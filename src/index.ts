import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  jidNormalizedUser,
  type WAMessage,
} from "baileys";
import pino from "pino";
import {
  saveMessage,
  seedMembers,
  setMemberIds,
  getMembersNeedingIdentity,
  getUnresolvableMembers,
  noteIdentityAttempt,
  purgeOldMessages,
  type MessageType,
} from "./db.js";
import { tryAssignment, tryManualTicket, tryStatusUpdate } from "./jobs.js";
import { startDashboard } from "./dashboard.js";
import { chooseLinkMethod, showQr, showPairingCode, type LinkChoice } from "./linking.js";
import {
  runChaseSweep,
  askOwnerToUpdateCustomer,
  parseSendCommand,
  sendCustomerUpdate,
  type Sender,
} from "./notify.js";

// ─── SETTINGS ────────────────────────────────────────────────
// Pairing codes expire after about a minute. The `qr` event keeps firing while
// we're unlinked, so a fresh code is issued whenever the last one is this old.
const PAIRING_CODE_TTL_MS = 75 * 1000;

// How hard to try resolving a member's WhatsApp identifiers before giving up.
// Each attempt is a USync lookup against WhatsApp's servers, so these are
// deliberately conservative - see the caution in CLAUDE.md.
const MAX_IDENTITY_ATTEMPTS = 5;
const IDENTITY_RETRY_MS = 60 * 60 * 1000;   // 1 hour between attempts

// Messages that never became part of a job are kept only this long. Long
// enough that the owner can still assign something said days ago, short
// enough that we aren't holding the business's whole chat history.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days
const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;      // sweep 4x a day

// Dashboard. Served from the same process, so it reads the database directly.
const DASHBOARD_PORT = 3000;

// Chasing silent staff. The dashboard shows who hasn't responded; these
// actually do something about it.
const NUDGE_AFTER_MS = 30 * 60 * 1000;        // remind the staff member
const ESCALATE_AFTER_MS = 2 * 60 * 60 * 1000; // then tell the owner
const CHASE_EVERY_MS = 5 * 60 * 1000;         // how often to check
// ─────────────────────────────────────────────────────────────

function purge() {
  try {
    const removed = purgeOldMessages(RETENTION_MS);
    if (removed > 0) {
      console.log(`  🧹 purged ${removed} message(s) older than 7 days and not part of a job`);
    }
  } catch (err: any) {
    console.log(`  ⚠ purge failed: ${err?.message}`);
  }
}

let connecting = false;

// Chosen once, on the first connect while unlinked. Kept across reconnects so
// a dropped connection mid-linking doesn't ask again.
let linkChoice: LinkChoice | null = null;
let lastPairingCodeAt = 0;

/**
 * Ask WhatsApp for each member's identifiers and store BOTH.
 *
 * A person has a phone JID (918109322881@s.whatsapp.net) and an opaque LID
 * (213945457614937@lid). WhatsApp uses either depending on context, so keeping
 * only one means inbound messages stop matching. `onWhatsApp` asks for both in
 * a single USync query — verified in the Baileys 6.7.24 source.
 *
 * This runs after the connection opens, because it is a network call.
 */
async function resolveMemberIdentities(sock: ReturnType<typeof makeWASocket>) {
  // Anyone we've already given up on, reported once so it isn't silent.
  for (const m of getUnresolvableMembers(MAX_IDENTITY_ATTEMPTS)) {
    console.log(`  ✗ ${m.name} (${m.phone}) could not be found on WhatsApp after ` +
                `${MAX_IDENTITY_ATTEMPTS} tries — check the number, then reset their attempts`);
  }

  const pending = getMembersNeedingIdentity(MAX_IDENTITY_ATTEMPTS, IDENTITY_RETRY_MS);
  if (pending.length === 0) return;

  for (const m of pending) {
    // Count the attempt before making it, so a crash mid-call still burns a
    // try rather than leaving us in a loop.
    noteIdentityAttempt(m.id);

    try {
      const results = await sock.onWhatsApp(`91${m.phone}`);
      const hit = results?.[0];

      // A number that isn't on WhatsApp is dropped from the result list
      // entirely. Say so rather than storing a half-resolved member.
      if (!hit?.exists) {
        console.log(`  ⚠ ${m.name} (${m.phone}) is not on WhatsApp — jobs cannot be sent`);
        continue;
      }

      const waJid = hit.jid ? String(hit.jid) : null;
      const waLid = hit.lid ? String(hit.lid) : null;

      setMemberIds(m.id, { waJid, waLid });
      console.log(`  ✓ ${m.name}: ${waJid ?? "no jid"} / ${waLid ?? "no lid"}`);
    } catch (err: any) {
      // Leave the member unresolved; retried on a later connect, up to the cap.
      console.log(`  ⚠ Could not resolve ${m.name}: ${err?.message}`);
    }
  }
}

/** The connected account is the owner, so his own chat is how we reach him. */
function ownerJidOf(sock: ReturnType<typeof makeWASocket>): string | null {
  const id = sock.user?.id;
  return id ? jidNormalizedUser(id) : null;
}

function senderFor(sock: ReturnType<typeof makeWASocket>): Sender {
  return async (jid, text) => { await sock.sendMessage(jid, { text }); };
}

/**
 * Periodically remind silent staff and escalate to the owner.
 * Restarted on each reconnect so it always uses a live socket.
 */
let chaseTimer: ReturnType<typeof setInterval> | null = null;

function startChasing(sock: ReturnType<typeof makeWASocket>) {
  if (chaseTimer) clearInterval(chaseTimer);

  const run = async () => {
    const owner = ownerJidOf(sock);
    if (!owner) return;
    try {
      await runChaseSweep(senderFor(sock), owner, {
        nudgeAfterMs: NUDGE_AFTER_MS,
        escalateAfterMs: ESCALATE_AFTER_MS,
      });
    } catch (err: any) {
      console.log(`  ⚠ chase sweep failed: ${err?.message}`);
    }
  };

  chaseTimer = setInterval(run, CHASE_EVERY_MS);
  run();
}

async function connect() {
  // Guard: never let two connection attempts run at once.
  if (connecting) return;
  connecting = true;

  const { state, saveCreds } = await useMultiFileAuthState("auth");

  // Ask how to link before opening the socket, so the question isn't buried
  // under connection chatter. Only ever asked while unlinked.
  if (!state.creds.registered && !linkChoice) {
    linkChoice = await chooseLinkMethod();
  }

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    // WhatsApp checks this identifier - use a known-good preset.
    browser: Browsers.ubuntu("Chrome"),
    // Don't mark the account "online", or the phone stops showing
    // notifications while we're connected.
    markOnlineOnConnect: false,
    // Skip the big backfill of old chats. We only want live messages.
    syncFullHistory: false,
    // Baileys asks for an old message when it needs to retry decryption.
    // We don't keep a store yet, so tell it we have nothing.
    getMessage: async () => undefined,
  });

  connecting = false;

  // Save credentials EVERY time they change.
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Only runs while unlinked. The `qr` event fires every ~20s until linked,
    // which is what lets us reissue an expired pairing code automatically.
    if (qr && !sock.authState.creds.registered) {
      if (linkChoice?.method === "code" && linkChoice.number) {
        if (Date.now() - lastPairingCodeAt > PAIRING_CODE_TTL_MS) {
          lastPairingCodeAt = Date.now();
          sock.requestPairingCode(linkChoice.number)
            .then(showPairingCode)
            .catch((err: any) => {
              console.log(`  ⚠ could not get a pairing code: ${err?.message}`);
              console.log("    Stop with Ctrl+C and try again, or choose QR next time.\n");
              lastPairingCodeAt = 0;   // let the next qr event retry
            });
        }
      } else {
        showQr(qr);
      }
    }

    if (connection === "open") {
      // Linked for good now — the credentials in ./auth are all that matters
      // from here, and nothing downstream knows which method was used.
      if (linkChoice) {
        console.log(`\n  ✓ Linked by ${linkChoice.method === "code" ? "pairing code" : "QR"}. ` +
                    "You won't be asked again unless you delete the auth folder.\n");
        linkChoice = null;
      }
      console.log("Connected. Listening for messages...\n");
      resolveMemberIdentities(sock);
      startChasing(sock);
    }

    if (connection === "close") {
      const code = (lastDisconnect?.error as any)?.output?.statusCode;

      // CRITICAL: shut this socket down completely before doing anything else.
      // Without this, the dead socket keeps firing events and every reconnect
      // stacks another live socket on top - which is what caused the 440 loop.
      sock.ev.removeAllListeners("connection.update");
      sock.ev.removeAllListeners("messages.upsert");
      sock.end(undefined);

      if (code === DisconnectReason.loggedOut) {
        console.log("Logged out on the phone. Delete the 'auth' folder and run again.");
        process.exit(0);
      }

      if (code === DisconnectReason.connectionReplaced) {
        console.log("Another session took over this account. Stopping.");
        console.log("(Close any other copy of this app, then run again.)");
        process.exit(0);
      }

      if (code === DisconnectReason.restartRequired) {
        console.log("Restart required (normal right after linking). Reconnecting...");
        setTimeout(connect, 1000);
        return;
      }

      console.log(`Connection dropped (code ${code}). Reconnecting in 3s...`);
      setTimeout(connect, 3000);
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    // Handled one at a time: two messages arriving together must not race
    // each other into the same job.
    void (async () => {
      for (const msg of messages) {
        try {
          await handleMessage(msg, sock);
        } catch (err: any) {
          console.log(`  ⚠ error handling a message: ${err?.message}`);
        }
      }
    })();
  });
}

/** What kind of message is this? Maps to the `type` column in the database. */
function getMessageType(msg: WAMessage): MessageType | null {
  const m = msg.message;
  if (!m) return null;
  if (m.protocolMessage || m.senderKeyDistributionMessage) return null;

  if (m.conversation || m.extendedTextMessage) return "text";
  if (m.imageMessage) return "image";
  if (m.videoMessage) return "video";
  if (m.audioMessage) return "audio";
  if (m.documentMessage) return "document";
  if (m.stickerMessage) return "sticker";
  if (m.locationMessage) return "location";
  if (m.contactMessage) return "contact";
  if (m.reactionMessage) return "other";
  return null;
}

/** Turns a WhatsApp message into readable text, or null if it isn't a real message. */
function describe(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;
  if (m.protocolMessage || m.senderKeyDistributionMessage) return null;

  const text = m.conversation ?? m.extendedTextMessage?.text;
  if (text) return text;

  if (m.imageMessage) return "[image] " + (m.imageMessage.caption ?? "");
  if (m.videoMessage) return "[video] " + (m.videoMessage.caption ?? "");
  if (m.audioMessage) return "[voice note]";
  if (m.documentMessage) return "[document]";
  if (m.stickerMessage) return "[sticker]";
  if (m.locationMessage) return "[location]";
  if (m.contactMessage) return "[contact card]";
  if (m.reactionMessage) return "[reaction] " + (m.reactionMessage.text ?? "");

  return null;
}

async function handleMessage(msg: WAMessage, sock: ReturnType<typeof makeWASocket>) {
  const msgType = getMessageType(msg);
  if (msgType === null) return;

  const body = describe(msg);
  const chatId = msg.key.remoteJid ?? "";
  const isGroup = chatId.endsWith("@g.us");
  const senderId = isGroup ? msg.key.participant : chatId;

  const who = msg.key.fromMe
    ? "YOU"
    : msg.pushName || senderId?.split("@")[0] || "unknown";

  const where = isGroup ? "group" : "chat";
  const time = new Date().toLocaleTimeString("en-IN");

  console.log(`[${time}] (${where}) ${who}: ${body}`);

  // ─── Save to database ───────────────────────────────────
  const sentAt = Number(msg.messageTimestamp) * 1000;

  const quoted = msg.message?.extendedTextMessage?.contextInfo?.stanzaId
    ?? null;

  const saved = saveMessage({
    waChatId: chatId,
    isGroup,
    waMessageId: msg.key.id ?? "",
    senderWaId: senderId ?? undefined,
    senderName: msg.pushName ?? undefined,
    fromMe: msg.key.fromMe ?? false,
    type: msgType,
    body,
    quotedWaMessageId: quoted,
    sentAt,
  });

  console.log(`  → saved (msg=${saved.messageId} conv=${saved.conversationId})`);

  // ─── Owner closing the loop: "send 3" / "send 3 bill is 800" ──
  if (msg.key.fromMe) {
    const cmd = parseSendCommand(body);
    if (cmd) {
      const result = await sendCustomerUpdate(senderFor(sock), cmd.jobId, cmd.message);
      if (result) {
        console.log(`  ✉ told ${result.customerName ?? "the customer"} about job #${result.jobId} — now closed`);
        const owner = ownerJidOf(sock);
        if (owner) {
          await sock.sendMessage(owner, {
            text: `✉️ Job #${result.jobId} closed. ${result.customerName ?? "Customer"} has been told.`,
          }).catch(() => {});
        }
      }
      return;
    }
  }

  // ─── Check for a job ────────────────────────────────────
  // Two ways one gets created, told apart by which chat we're in:
  //   customer's chat  →  "@ravi"            → job from their messages
  //   staff member's chat → "@ticket <work>" → job from the text
  const assignment =
    tryManualTicket(saved, msg.key.fromMe ?? false, body, chatId, isGroup)
    ?? tryAssignment(saved, msg.key.fromMe ?? false, body, quoted);

  if (assignment) {
    console.log(`  ★ JOB #${assignment.jobId} created → ${assignment.memberName} (@${assignment.memberHandle})`);
    console.log(
      assignment.messageCount === 1
        ? `    "${assignment.title}"`
        : `    "${assignment.title}" (${assignment.messageCount} messages)`
    );

    // ─── Send job to staff on WhatsApp ──────────────────
    const staffJid = assignment.memberSendJid;

    const jobMsg =
      `📋 *Job #${assignment.jobId}*\n` +
      `${assignment.title}\n\n` +
      `${assignment.description}\n\n` +
      `Reply:\n` +
      `*1* — ok, I'm on it\n` +
      `*2* — done, work finished\n` +
      `*3* — stuck, need help`;

    sock.sendMessage(staffJid, { text: jobMsg }).then(() => {
      console.log(`  → sent to ${assignment.memberName} (${staffJid})`);
    }).catch((err: any) => {
      console.log(`  ⚠ failed to send to ${assignment.memberName}:`, err?.message);
    });
    return;
  }

  // ─── Check for staff status update ──────────────────────
  // In a DM, senderId = remoteJid regardless of direction — so the owner
  // typing "done" in Ravi's chat would look like Ravi sent it.
  if (msg.key.fromMe) return;

  const update = tryStatusUpdate(senderId ?? undefined, body);
  if (update) {
    console.log(`  ★ JOB #${update.jobId} ${update.oldStatus} → ${update.newStatus} by ${update.memberName}`);
    if (update.blockedReason) {
      console.log(`    blocked: ${update.blockedReason}`);
    }

    // Acknowledge to the staff member
    const staffJid = senderId!;
    const ack = update.newStatus === "blocked"
      ? `⚠️ Job #${update.jobId} marked as *stuck*. Owner has been notified.`
      : update.newStatus === "done"
        ? `✅ Job #${update.jobId} marked as *done*. Nice work!`
        : `👍 Job #${update.jobId} — *${update.newStatus}*`;

    sock.sendMessage(staffJid, { text: ack }).catch(() => {});

    const owner = ownerJidOf(sock);

    // Stuck — the owner needs to know, in HIS chat. (This used to be sent to
    // `chatId`, which is the staff member's own chat: it told Ravi that Ravi
    // was stuck.)
    if (update.newStatus === "blocked" && owner) {
      const ownerMsg =
        `⚠️ *Job #${update.jobId}* is stuck\n` +
        `${update.jobTitle}\n\n` +
        `${update.memberName} says: ${update.blockedReason ?? "no reason given"}`;

      sock.sendMessage(owner, { text: ownerMsg }).catch(() => {});
    }

    // Done — close the loop. The customer still hasn't heard anything, so ask
    // the owner whether to tell them. Until that happens the job is 'done',
    // not 'closed'.
    if (update.newStatus === "done" && owner) {
      await askOwnerToUpdateCustomer(senderFor(sock), owner, update.jobId);
    }
  }
}

// While developing, a background error shouldn't kill the whole program.
process.on("unhandledRejection", (err) => {
  console.log("[ignored background error]", (err as any)?.message ?? err);
});

seedMembers();
purge();
setInterval(purge, PURGE_EVERY_MS);
startDashboard(DASHBOARD_PORT);
connect();
