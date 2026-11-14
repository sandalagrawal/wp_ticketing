import {
  getJobsNeedingNudge,
  getJobsNeedingEscalation,
  getPendingJob,
  markNudged,
  markEscalated,
  markCustomerNotified,
  type PendingJob,
} from "./db.js";

/**
 * Sending is injected rather than imported, so nothing in here knows about
 * Baileys. If the WhatsApp transport is ever swapped, this file doesn't change.
 */
export type Sender = (jid: string, text: string) => Promise<void>;

/** Default text sent to a customer when work is finished. */
const DEFAULT_CUSTOMER_UPDATE = "Your work has been completed. Thank you!";

/** Where to reach the assignee. Phone JID preferred — see CLAUDE.md. */
function assigneeJid(job: PendingJob): string | null {
  if (job.assignee_wa_jid) return job.assignee_wa_jid;
  if (job.assignee_wa_lid) return job.assignee_wa_lid;
  if (job.assignee_phone) return `91${job.assignee_phone}@s.whatsapp.net`;
  return null;
}

// ─── Chasing ─────────────────────────────────────────────────

/**
 * Remind staff who haven't acknowledged, then tell the owner about anyone
 * still silent much later.
 *
 * This exists because the project's success metric is whether staff respond.
 * Measuring that without ever asking twice would be measuring the wrong thing.
 */
export async function runChaseSweep(
  send: Sender,
  ownerJid: string,
  opts: { nudgeAfterMs: number; escalateAfterMs: number },
): Promise<void> {
  // 1. Nudge the staff member.
  for (const job of getJobsNeedingNudge(opts.nudgeAfterMs)) {
    const jid = assigneeJid(job);
    if (!jid) continue;

    // Marked before sending: a send that fails shouldn't queue up a reminder
    // that fires again on every sweep.
    markNudged(job.id);

    const text =
      `⏰ *Reminder — Job #${job.id}*\n` +
      `${job.title}\n\n` +
      `Still waiting on you.\n` +
      `*1* on it  ·  *2* done  ·  *3* stuck`;

    try {
      await send(jid, text);
      console.log(`  ⏰ nudged ${job.assignee_name} about job #${job.id}`);
    } catch (err: any) {
      console.log(`  ⚠ could not nudge ${job.assignee_name}: ${err?.message}`);
    }
  }

  // 2. Tell the owner about the ones still ignored.
  for (const job of getJobsNeedingEscalation(opts.escalateAfterMs)) {
    markEscalated(job.id);

    const waited = job.assigned_at ? humanAge(Date.now() - job.assigned_at) : "a while";
    const text =
      `⚠️ *No response — Job #${job.id}*\n` +
      `${job.title}\n\n` +
      `${job.assignee_name ?? "Nobody"} hasn't replied in ${waited}.`;

    try {
      await send(ownerJid, text);
      console.log(`  ⚠ escalated job #${job.id} to the owner`);
    } catch (err: any) {
      console.log(`  ⚠ could not escalate job #${job.id}: ${err?.message}`);
    }
  }
}

// ─── Closing the loop to the customer ────────────────────────

/**
 * Work is finished — ask the owner whether to tell the customer.
 *
 * Deliberately not automatic. The owner often wants to add something ("bill is
 * ₹800"), and a message going to a customer without him seeing it first is the
 * kind of surprise that loses trust in the tool.
 */
export async function askOwnerToUpdateCustomer(
  send: Sender,
  ownerJid: string,
  jobId: number,
): Promise<void> {
  const job = getPendingJob(jobId);
  if (!job) return;

  // Owner-created jobs have no customer to tell.
  if (!job.chat_wa_id || !job.customer_wa_id) return;

  const text =
    `✅ *Job #${job.id} done* — ${job.assignee_name ?? "staff"}\n` +
    `${job.title}\n` +
    `Customer: ${job.customer_name ?? "unknown"}\n\n` +
    `Reply *send ${job.id}* to let them know.\n` +
    `Or *send ${job.id} <your message>* to say something specific.`;

  try {
    await send(ownerJid, text);
  } catch (err: any) {
    console.log(`  ⚠ could not prompt the owner about job #${job.id}: ${err?.message}`);
  }
}

/** "send 3" or "send 3 bill is 800" from the owner. */
export function parseSendCommand(
  text: string | null,
): { jobId: number; message: string | null } | null {
  if (!text) return null;
  const m = text.match(/^\s*send\s+#?(\d+)\s*([\s\S]*)$/i);
  if (!m) return null;
  const rest = m[2].trim();
  return { jobId: Number(m[1]), message: rest.length > 0 ? rest : null };
}

export interface CustomerUpdateResult {
  jobId: number;
  customerName: string | null;
  sentText: string;
}

/**
 * Send the update into the customer's original chat and close the job.
 * Returns null with a logged reason if it can't.
 */
export async function sendCustomerUpdate(
  send: Sender,
  jobId: number,
  message: string | null,
): Promise<CustomerUpdateResult | null> {
  const job = getPendingJob(jobId);

  if (!job) {
    console.log(`  ⚠ job #${jobId} not found`);
    return null;
  }
  if (!job.chat_wa_id) {
    console.log(`  ⚠ job #${jobId} has no customer chat — owner-created?`);
    return null;
  }
  // A notified job is already 'closed', so this also covers double-sends.
  if (job.status === "closed") {
    console.log(`  ⚠ job #${jobId} is already closed`);
    return null;
  }

  const text = message ?? DEFAULT_CUSTOMER_UPDATE;

  try {
    await send(job.chat_wa_id, text);
  } catch (err: any) {
    console.log(`  ⚠ could not message the customer for job #${jobId}: ${err?.message}`);
    return null;
  }

  markCustomerNotified(jobId, null);
  return { jobId, customerName: job.customer_name, sentText: text };
}

// ─── small helpers ───────────────────────────────────────────

function humanAge(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
