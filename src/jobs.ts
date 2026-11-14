import {
  findMemberByHandle,
  findMemberByWaId,
  findMemberBySenderWaId,
  findMessageByWaId,
  findLatestInboundMessage,
  getMessagesInWindow,
  createJob,
  findOpenJobForMember,
  updateJobStatus,
  type SavedMessage,
  type StoredMessage,
  type JobStatus,
} from "./db.js";

const FIVE_MINUTES = 5 * 60 * 1000;
const MAX_BURST = 10;
// Fetch messages in a 30-minute window around the anchor for burst detection
const BURST_WINDOW = 30 * 60 * 1000;

/**
 * Extract @handle from message text. Returns the handle (lowercase) or null.
 * Matches: "@ravi", "@ravi please fix", "assign to @ravi", etc.
 */
export function parseAtMention(text: string): string | null {
  const match = text.match(/@(\w+)/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * The burst rule: find the cluster of messages around the anchor that belong
 * together. Walk outward from the anchor and stop when:
 * - gap to next message > 5 minutes
 * - sender changes
 * - a message with direction 'out' appears (business already replied)
 * - 10 messages collected
 */
function collectBurst(allMessages: StoredMessage[], anchorIndex: number): number[] {
  const anchor = allMessages[anchorIndex];
  const senderWaId = anchor.sender_wa_id;
  const ids: number[] = [anchor.id];

  // Walk backward from anchor
  for (let i = anchorIndex - 1; i >= 0 && ids.length < MAX_BURST; i--) {
    const curr = allMessages[i];
    const next = allMessages[i + 1];
    if (next.sent_at - curr.sent_at > FIVE_MINUTES) break;
    if (curr.sender_wa_id !== senderWaId) break;
    if (curr.direction === "out") break;
    ids.unshift(curr.id);
  }

  // Walk forward from anchor
  for (let i = anchorIndex + 1; i < allMessages.length && ids.length < MAX_BURST; i++) {
    const curr = allMessages[i];
    const prev = allMessages[i - 1];
    if (curr.sent_at - prev.sent_at > FIVE_MINUTES) break;
    if (curr.sender_wa_id !== senderWaId) break;
    if (curr.direction === "out") break;
    ids.push(curr.id);
  }

  return ids;
}

export interface AssignmentResult {
  jobId: number;
  memberName: string;
  memberHandle: string;
  memberPhone: string;
  /** Where to send this member's job. Phone JID preferred over LID. */
  memberSendJid: string;
  title: string;
  description: string;
  messageCount: number;
}

/**
 * Check if a message is a job assignment (@mention in a reply) and create the job.
 * Returns the result if a job was created, null otherwise.
 */
/**
 * Owner typing "@ticket <work>" inside a staff member's own chat.
 *
 * Work that never arrived on WhatsApp — a phone call, something noticed in
 * person — still has to become a job. The owner is already opening Ravi's chat
 * to tell him, so he prefixes it instead of doing it anywhere else.
 *
 * The CHAT identifies the assignee, so there is no @handle to type. That also
 * makes it unambiguous: an ordinary message to Ravi stays an ordinary message.
 */
export function tryManualTicket(
  saved: SavedMessage,
  fromMe: boolean,
  body: string | null,
  chatId: string,
  isGroup: boolean,
): AssignmentResult | null {
  if (!fromMe || !body || isGroup) return null;

  // "@ticket ..." or "@job ..." at the start, case-insensitive.
  const match = body.match(/^\s*@(?:ticket|job)\b\s*([\s\S]*)$/i);
  if (!match) return null;

  // In a one-to-one chat the chat id IS the other person, so this tells us
  // whether we are in a staff member's chat and which one.
  const member = findMemberByWaId(chatId);
  if (!member) {
    console.log(`  ⚠ @ticket used in a chat that is not a staff member's`);
    return null;
  }

  const text = match[1].trim();
  if (!text) {
    console.log(`  ⚠ @ticket with no description — nothing to assign`);
    return null;
  }

  const title = text.length > 60 ? text.slice(0, 59).trimEnd() + "…" : text;

  const jobId = createJob({
    conversationId: saved.conversationId,   // the staff member's chat
    contactId: null,                        // no customer — owner-created
    sourceMessageId: saved.messageId,       // the "@ticket ..." message itself
    title,
    description: text,
    assigneeId: member.id,
    createdById: null,
    burstMessageIds: [saved.messageId],
  });

  return {
    jobId,
    memberName: member.name,
    memberHandle: member.handle,
    memberPhone: member.phone,
    memberSendJid:
      member.wa_jid ?? member.wa_lid ?? `91${member.phone}@s.whatsapp.net`,
    title,
    description: text,
    messageCount: 1,
  };
}

export function tryAssignment(
  saved: SavedMessage,
  fromMe: boolean,
  body: string | null,
  quotedWaMessageId: string | null,
): AssignmentResult | null {
  if (!fromMe || !body) return null;

  // Must contain @handle
  const handle = parseAtMention(body);
  if (!handle) return null;

  // Look up the member
  const member = findMemberByHandle(handle);
  if (!member) {
    console.log(`  ⚠ @${handle} not found in member table`);
    return null;
  }

  // Find the anchor: the quoted message if replying, or the latest inbound message
  let anchor: StoredMessage | undefined;
  if (quotedWaMessageId) {
    anchor = findMessageByWaId(quotedWaMessageId);
    if (!anchor) {
      console.log(`  ⚠ quoted message not found in database`);
      return null;
    }
  } else {
    // No quoted message: anchor on the customer's most recent message,
    // however old. The burst window is centred on THAT message's timestamp,
    // not on now, so assigning three days later still picks up the right
    // cluster. Deliberately not time-limited - a job is often spread over
    // several messages and the owner may get to it much later.
    anchor = findLatestInboundMessage(saved.conversationId);
    if (!anchor) {
      console.log(`  ⚠ no inbound messages in this conversation`);
      return null;
    }

    // Visible when the anchor is stale, so a surprising job has an explanation.
    const ageMs = Date.now() - anchor.sent_at;
    if (ageMs > 60 * 60 * 1000) {
      const hours = Math.round(ageMs / (60 * 60 * 1000));
      console.log(`  ℹ no reply quoted - anchored on a message from ~${hours}h ago`);
    }
  }

  // Burst: get messages around the anchor and collect the cluster
  const windowStart = anchor.sent_at - BURST_WINDOW;
  const windowEnd = anchor.sent_at + BURST_WINDOW;
  const allMessages = getMessagesInWindow(saved.conversationId, windowStart, windowEnd);

  const anchorIndex = allMessages.findIndex(m => m.id === anchor.id);
  if (anchorIndex === -1) return null;

  const burstIds = collectBurst(allMessages, anchorIndex);

  // Collect burst message bodies
  const burstMessages = allMessages.filter(m => burstIds.includes(m.id));
  const allBodies = burstMessages
    .map(m => m.body)
    .filter((b): b is string => b !== null && b.trim().length > 0);

  // Filter out greetings and filler
  const FILLER = /^(h(i|ey+|ello|lo)|yo|ok|please|pls|thanks|thank you|gm|good\s*(morning|evening|night)|asap|urgent|sir|ma'?am|bhai|bhaiya|ji)\b/i;
  const substantive = allBodies.filter(b => b.length >= 15 || !FILLER.test(b.trim()));
  const useful = substantive.length > 0 ? substantive : allBodies;

  // Description: filtered messages joined
  const description = useful.join("\n");

  // Title: the burst in order, compressed to one line.
  //
  // Picking any single message gets this wrong, because a customer spreads one
  // job across several: "Ac fix" is the problem, "New market bhopal" is the
  // address, neither is the job on its own. Longest-wins picks the address;
  // first-wins picks "Need help". Joining them in the order they were sent
  // reads as a summary and needs no cleverness:
  //   "Need help · Ac fix · 10, betwa · New market bhopal"
  const joined = useful.join(" · ");
  const title = joined.length > 60
    ? joined.slice(0, 59).trimEnd() + "…"
    : (joined || "[no text]");

  const jobId = createJob({
    conversationId: saved.conversationId,
    contactId: saved.contactId,
    sourceMessageId: anchor.id,
    title,
    description,
    assigneeId: member.id,
    createdById: null,
    burstMessageIds: burstIds,
  });

  return {
    jobId,
    memberName: member.name,
    memberHandle: member.handle,
    memberPhone: member.phone,
    // Prefer the phone JID for sending: addressing a LID can break reply
    // quoting on the recipient's device. Fall back to the LID, then to a
    // constructed JID if identity resolution hasn't run yet.
    memberSendJid:
      member.wa_jid ?? member.wa_lid ?? `91${member.phone}@s.whatsapp.net`,
    title,
    description,
    messageCount: burstIds.length,
  };
}

// ─── Staff reply parsing (Step 6) ────────────────────────────

const STATUS_MAP: Record<string, JobStatus> = {
  // 1 = ok/accepted
  "1": "accepted",
  "ok": "accepted",
  "okay": "accepted",
  "accept": "accepted",
  "accepted": "accepted",
  "theek hai": "accepted",
  "thik hai": "accepted",
  "haan": "accepted",
  // 2 = done/completed
  "2": "done",
  "done": "done",
  "completed": "done",
  "finish": "done",
  "finished": "done",
  "ho gaya": "done",
  "kar diya": "done",
  // 3 = stuck/blocked
  "3": "blocked",
  "stuck": "blocked",
  "blocked": "blocked",
  "help": "blocked",
  "problem": "blocked",
  "dikkat": "blocked",
  "issue": "blocked",
  // in progress
  "started": "in_progress",
  "start": "in_progress",
  "working": "in_progress",
  "on it": "in_progress",
  "shuru": "in_progress",
};

function parseStaffReply(text: string): { status: JobStatus; blockedReason?: string } | null {
  const trimmed = text.trim().toLowerCase();

  // Check for "3 <reason>" pattern — blocked with a reason
  const blockedMatch = trimmed.match(/^(3|stuck|blocked|help|problem|dikkat|issue)\s+(.+)/);
  if (blockedMatch) {
    return { status: "blocked", blockedReason: blockedMatch[2] };
  }

  const status = STATUS_MAP[trimmed];
  if (!status) return null;
  return { status };
}

export interface StatusUpdateResult {
  jobId: number;
  jobTitle: string;
  memberName: string;
  oldStatus: string;
  newStatus: JobStatus;
  blockedReason?: string;
}

export function tryStatusUpdate(
  senderWaId: string | undefined,
  body: string | null,
): StatusUpdateResult | null {
  if (!senderWaId || !body) return null;

  // Is this sender a known staff member?
  const member = findMemberBySenderWaId(senderWaId);
  if (!member) return null;

  // Parse what they said
  const parsed = parseStaffReply(body);
  if (!parsed) return null;

  // Find their most recent open job
  const job = findOpenJobForMember(member.id);
  if (!job) {
    console.log(`  ⚠ ${member.name} replied "${body}" but has no open job`);
    return null;
  }

  const oldStatus = job.status;
  updateJobStatus(job.id, parsed.status, member.id, parsed.blockedReason);

  return {
    jobId: job.id,
    jobTitle: job.title,
    memberName: member.name,
    oldStatus,
    newStatus: parsed.status,
    blockedReason: parsed.blockedReason,
  };
}
