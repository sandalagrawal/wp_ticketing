import { DatabaseSync } from "node:sqlite";
import path from "path";

// ─── Types ───────────────────────────────────────────────────

export type MessageType =
  | "text" | "image" | "video" | "audio" | "document"
  | "sticker" | "location" | "contact" | "other";

export interface IncomingMessage {
  waChatId: string;
  isGroup: boolean;
  groupSubject?: string;
  waMessageId: string;
  senderWaId: string | undefined;
  senderName: string | undefined;
  fromMe: boolean;
  type: MessageType;
  body: string | null;
  quotedWaMessageId: string | null;
  sentAt: number;               // epoch ms, from msg.messageTimestamp * 1000
}

export interface SavedMessage {
  messageId: number;
  conversationId: number;
  contactId: number | null;
}

// ─── Database singleton ──────────────────────────────────────

let db: DatabaseSync;

export function getDb(): DatabaseSync {
  if (db) return db;

  const dbPath = path.join(process.cwd(), "parchi.db");
  db = new DatabaseSync(dbPath);

  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");

  createTables();
  return db;
}

// ─── Schema ──────────────────────────────────────────────────

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS member (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id     INTEGER NOT NULL DEFAULT 1,
      name            TEXT    NOT NULL,
      handle          TEXT    NOT NULL,
      phone           TEXT    NOT NULL,
      -- WhatsApp gives a person TWO identifiers and uses either one depending
      -- on context. Store both; match an inbound sender against either.
      wa_jid          TEXT,   -- 918109322881@s.whatsapp.net  (phone-based)
      wa_lid          TEXT,   -- 213945457614937@lid          (opaque)
      role            TEXT    NOT NULL DEFAULT 'staff'
                        CHECK (role IN ('owner','manager','staff')),
      active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
      -- Identity resolution bookkeeping. A number that is mistyped or has no
      -- LID would otherwise be re-queried on every reconnect forever, which is
      -- the contact-harvesting pattern that gets accounts flagged.
      identity_attempts   INTEGER NOT NULL DEFAULT 0,
      identity_checked_at INTEGER,
      created_at      INTEGER NOT NULL,
      deactivated_at  INTEGER,
      UNIQUE (business_id, handle),
      UNIQUE (business_id, phone)
    );

    CREATE TABLE IF NOT EXISTS contact (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id   INTEGER NOT NULL DEFAULT 1,
      wa_id         TEXT    NOT NULL,
      display_name  TEXT,
      phone         TEXT,
      first_seen_at INTEGER NOT NULL,
      UNIQUE (business_id, wa_id)
    );

    CREATE TABLE IF NOT EXISTS conversation (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL DEFAULT 1,
      wa_chat_id  TEXT    NOT NULL,
      type        TEXT    NOT NULL CHECK (type IN ('dm','group')),
      title       TEXT,
      created_at  INTEGER NOT NULL,
      UNIQUE (business_id, wa_chat_id)
    );

    CREATE TABLE IF NOT EXISTS message (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id          INTEGER NOT NULL DEFAULT 1,
      conversation_id      INTEGER NOT NULL REFERENCES conversation(id),
      wa_message_id        TEXT    NOT NULL,
      sender_wa_id         TEXT,
      direction            TEXT    NOT NULL CHECK (direction IN ('in','out')),
      type                 TEXT    NOT NULL DEFAULT 'text'
                             CHECK (type IN ('text','image','video','audio','document',
                                             'sticker','location','contact','other')),
      body                 TEXT,
      quoted_wa_message_id TEXT,
      job_id               INTEGER REFERENCES job(id),
      sent_at              INTEGER NOT NULL,
      created_at           INTEGER NOT NULL,
      UNIQUE (conversation_id, wa_message_id)
    );

    CREATE TABLE IF NOT EXISTS job (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id       INTEGER NOT NULL DEFAULT 1,
      conversation_id   INTEGER NOT NULL REFERENCES conversation(id),
      contact_id        INTEGER REFERENCES contact(id),
      source_message_id INTEGER NOT NULL REFERENCES message(id),
      title             TEXT    NOT NULL,
      description       TEXT,
      status            TEXT    NOT NULL DEFAULT 'new'
                          CHECK (status IN ('new','assigned','accepted',
                                            'in_progress','blocked','done','closed')),
      priority          TEXT    NOT NULL DEFAULT 'normal'
                          CHECK (priority IN ('normal','urgent')),
      blocked_reason    TEXT,
      assignee_id       INTEGER REFERENCES member(id),
      created_by_id     INTEGER REFERENCES member(id),
      created_at        INTEGER NOT NULL,
      assigned_at       INTEGER,
      accepted_at       INTEGER,
      done_at           INTEGER,
      closed_at         INTEGER,
      -- Chasing. Each is set once so nobody gets reminded twice.
      nudged_at         INTEGER,   -- staff member reminded
      escalated_at      INTEGER,   -- owner told nobody has responded
      notified_at       INTEGER    -- customer told the work is finished
    );

    CREATE TABLE IF NOT EXISTS job_event (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id     INTEGER NOT NULL DEFAULT 1,
      job_id          INTEGER NOT NULL REFERENCES job(id),
      type            TEXT    NOT NULL
                        CHECK (type IN ('created','assigned','reassigned','accepted',
                                        'status_changed','blocked','reopened',
                                        'customer_notified','note')),
      actor_member_id INTEGER REFERENCES member(id),
      actor_wa_id     TEXT,
      from_value      TEXT,
      to_value        TEXT,
      note            TEXT,
      created_at      INTEGER NOT NULL
    );

    -- Landing-page signups. Not part of the product; kept here so there is one
    -- database to back up and one process to run while testing demand.
    CREATE TABLE IF NOT EXISTS waitlist (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT,
      business    TEXT,
      phone       TEXT,
      email       TEXT,
      team_size   TEXT,
      note        TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_msg_window  ON message(conversation_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_msg_wa_id   ON message(wa_message_id);
    CREATE INDEX IF NOT EXISTS idx_msg_job     ON message(job_id);
    CREATE INDEX IF NOT EXISTS idx_job_open    ON job(business_id, status, assignee_id);
    CREATE INDEX IF NOT EXISTS idx_job_contact ON job(contact_id, status);
    CREATE INDEX IF NOT EXISTS idx_event_job   ON job_event(job_id, created_at);
    -- NULLs are distinct in SQLite unique indexes, so several members may sit
    -- unresolved (both columns NULL) without colliding.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_member_jid ON member(business_id, wa_jid);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_member_lid ON member(business_id, wa_lid);
  `);
}

// ─── Member queries ──────────────────────────────────────────

export interface Member {
  id: number;
  name: string;
  handle: string;
  phone: string;
  wa_jid: string | null;
  wa_lid: string | null;
  role: string;
}

const MEMBER_COLS = `id, name, handle, phone, wa_jid, wa_lid, role`;

export function findMemberByHandle(handle: string): Member | undefined {
  const d = getDb();
  return d.prepare(`
    SELECT ${MEMBER_COLS} FROM member
    WHERE business_id = 1 AND handle = ? AND active = 1
  `).get(handle.toLowerCase()) as Member | undefined;
}

/**
 * Match an inbound sender id against either stored identifier.
 * WhatsApp uses the LID in most contexts now, but the phone JID still appears,
 * so both have to be checked.
 */
export function findMemberByWaId(waId: string): Member | undefined {
  const d = getDb();
  return d.prepare(`
    SELECT ${MEMBER_COLS} FROM member
    WHERE business_id = 1 AND active = 1
      AND (wa_jid = ? OR wa_lid = ?)
  `).get(waId, waId) as Member | undefined;
}

export function seedMembers() {
  const d = getDb();
  const now = Date.now();
  const insert = d.prepare(`
    INSERT OR IGNORE INTO member (business_id, name, handle, phone, role, created_at)
    VALUES (1, ?, ?, ?, ?, ?)
  `);
  insert.run("Ravi Kumar", "ravi", "8109322881", "staff", now);
  insert.run("Amit Singh", "amit", "9876543211", "staff", now);
  insert.run("Owner", "owner", "9999999999", "owner", now);
  console.log("Seeded dummy members: ravi, amit, owner");
}

// ─── Message queries for burst rule ──────────────────────────

export interface StoredMessage {
  id: number;
  sender_wa_id: string | null;
  direction: string;
  sent_at: number;
  body: string | null;
}

export function findMessageByWaId(waMessageId: string): StoredMessage | undefined {
  const d = getDb();
  return d.prepare(`
    SELECT id, sender_wa_id, direction, sent_at, body FROM message
    WHERE wa_message_id = ?
  `).get(waMessageId) as StoredMessage | undefined;
}

export function findLatestInboundMessage(conversationId: number): StoredMessage | undefined {
  const d = getDb();
  return d.prepare(`
    SELECT id, sender_wa_id, direction, sent_at, body FROM message
    WHERE conversation_id = ? AND direction = 'in'
    ORDER BY sent_at DESC
    LIMIT 1
  `).get(conversationId) as StoredMessage | undefined;
}

export function getMessagesInWindow(conversationId: number, fromTs: number, toTs: number): StoredMessage[] {
  const d = getDb();
  return d.prepare(`
    SELECT id, sender_wa_id, direction, sent_at, body
    FROM message
    WHERE conversation_id = ? AND sent_at BETWEEN ? AND ?
    ORDER BY sent_at
  `).all(conversationId, fromTs, toTs) as unknown as StoredMessage[];
}

// ─── Job creation ────────────────────────────────────────────

export interface CreateJobParams {
  conversationId: number;
  contactId: number | null;
  sourceMessageId: number;
  title: string;
  description: string;
  assigneeId: number;
  createdById: number | null;
  burstMessageIds: number[];
}

export function createJob(params: CreateJobParams): number {
  const d = getDb();
  const now = Date.now();

  d.exec("BEGIN");
  try {
    // 1. Insert the job
    const jobRow = d.prepare(`
      INSERT INTO job (business_id, conversation_id, contact_id, source_message_id,
                       title, description, status, assignee_id, created_by_id, created_at, assigned_at)
      VALUES (1, ?, ?, ?, ?, ?, 'assigned', ?, ?, ?, ?)
      RETURNING id
    `).get(
      params.conversationId,
      params.contactId,
      params.sourceMessageId,
      params.title,
      params.description,
      params.assigneeId,
      params.createdById,
      now, now,
    ) as { id: number };

    const jobId = jobRow.id;

    // 2. Link burst messages to this job
    const updateMsg = d.prepare(`UPDATE message SET job_id = ? WHERE id = ?`);
    for (const msgId of params.burstMessageIds) {
      updateMsg.run(jobId, msgId);
    }

    // 3. Write job_event rows
    const insertEvent = d.prepare(`
      INSERT INTO job_event (business_id, job_id, type, actor_member_id, to_value, created_at)
      VALUES (1, ?, ?, ?, ?, ?)
    `);
    insertEvent.run(jobId, "created", params.createdById, null, now);
    insertEvent.run(jobId, "assigned", params.createdById, String(params.assigneeId), now);

    d.exec("COMMIT");
    return jobId;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

// ─── Job queries ─────────────────────────────────────────────

export type JobStatus = "new" | "assigned" | "accepted" | "in_progress" | "blocked" | "done" | "closed";

export interface Job {
  id: number;
  title: string;
  status: JobStatus;
  assignee_id: number;
  blocked_reason: string | null;
}

/**
 * Resolve an inbound sender to a member, or undefined.
 *
 * NEVER guess. If no member matches exactly, the caller must ignore the
 * message. Inferring identity (e.g. "the one member with an open job") lets any
 * stranger who messages the business control job status.
 */
export function findMemberBySenderWaId(senderWaId: string): Member | undefined {
  // 1. Exact match on either stored identifier.
  const member = findMemberByWaId(senderWaId);
  if (member) return member;

  // 2. Phone digits — only possible for @s.whatsapp.net, never for @lid.
  //    A LID is opaque: there are no digits in it to extract.
  if (!senderWaId.endsWith("@s.whatsapp.net")) return undefined;

  const digits = senderWaId.split("@")[0]?.split(":")[0] ?? "";
  const phone = digits.startsWith("91") ? digits.slice(2) : digits;
  if (!phone) return undefined;

  const d = getDb();
  return d.prepare(`
    SELECT ${MEMBER_COLS} FROM member
    WHERE business_id = 1 AND phone = ? AND active = 1
  `).get(phone) as Member | undefined;
}

/**
 * Store whichever identifiers WhatsApp gave us. Passing undefined for one
 * leaves the existing value alone, so a later partial resolution can't wipe
 * something we already knew.
 */
export function setMemberIds(
  memberId: number,
  ids: { waJid?: string | null; waLid?: string | null },
): void {
  const d = getDb();
  d.prepare(`
    UPDATE member
    SET wa_jid = coalesce(?, wa_jid),
        wa_lid = coalesce(?, wa_lid)
    WHERE id = ?
  `).run(ids.waJid ?? null, ids.waLid ?? null, memberId);
}

/** Everyone active, for listing handles back to the owner. */
export function listActiveMembers(): Member[] {
  const d = getDb();
  return d.prepare(`
    SELECT ${MEMBER_COLS} FROM member
    WHERE business_id = 1 AND active = 1
    ORDER BY CASE role WHEN 'owner' THEN 1 ELSE 0 END, handle
  `).all() as unknown as Member[];
}

/**
 * Handles that look like what was typed — for "did you mean?" after an
 * unrecognised @mention. Prefix matches first, then anything containing it.
 */
export function findMembersLike(handle: string): Member[] {
  const needle = handle.toLowerCase();
  const all = listActiveMembers();

  const prefix = all.filter(m => m.handle.startsWith(needle));
  if (prefix.length) return prefix;

  return all.filter(m =>
    m.handle.includes(needle) ||
    needle.includes(m.handle) ||
    m.name.toLowerCase().split(/\s+/).some(part => part.startsWith(needle)),
  );
}

export function getAllActiveStaff(): Member[] {
  const d = getDb();
  return d.prepare(`
    SELECT ${MEMBER_COLS} FROM member
    WHERE business_id = 1 AND active = 1 AND role = 'staff'
  `).all() as unknown as Member[];
}

/**
 * Active members still missing an identifier AND still worth asking about.
 *
 * Two brakes, and both are needed:
 *  - `maxAttempts` stops us hammering a number that will never resolve
 *    (a typo, or someone not on WhatsApp).
 *  - `minGapMs` spaces the attempts out, so a flaky connection reconnecting
 *    every few seconds can't burn the whole allowance in under a minute.
 */
export function getMembersNeedingIdentity(
  maxAttempts: number,
  minGapMs: number,
): Member[] {
  const d = getDb();
  return d.prepare(`
    SELECT ${MEMBER_COLS} FROM member
    WHERE business_id = 1 AND active = 1
      AND (wa_jid IS NULL OR wa_lid IS NULL)
      AND identity_attempts < ?
      AND (identity_checked_at IS NULL OR identity_checked_at < ?)
  `).all(maxAttempts, Date.now() - minGapMs) as unknown as Member[];
}

/** Record that we asked WhatsApp about this member, successfully or not. */
export function noteIdentityAttempt(memberId: number): void {
  const d = getDb();
  d.prepare(`
    UPDATE member
    SET identity_attempts = identity_attempts + 1,
        identity_checked_at = ?
    WHERE id = ?
  `).run(Date.now(), memberId);
}

/**
 * Give a member a fresh allowance. Call this whenever their phone number
 * changes — a corrected typo deserves new attempts.
 */
export function resetIdentityAttempts(memberId: number): void {
  const d = getDb();
  d.prepare(`
    UPDATE member SET identity_attempts = 0, identity_checked_at = NULL
    WHERE id = ?
  `).run(memberId);
}

/** Active members we have given up on — surfaced so they aren't silent. */
export function getUnresolvableMembers(maxAttempts: number): Member[] {
  const d = getDb();
  return d.prepare(`
    SELECT ${MEMBER_COLS} FROM member
    WHERE business_id = 1 AND active = 1
      AND wa_jid IS NULL AND wa_lid IS NULL
      AND identity_attempts >= ?
  `).all(maxAttempts) as unknown as Member[];
}

export function findOpenJobForMember(memberId: number): Job | undefined {
  const d = getDb();
  return d.prepare(`
    SELECT id, title, status, assignee_id, blocked_reason FROM job
    WHERE business_id = 1 AND assignee_id = ? AND status NOT IN ('done', 'closed')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(memberId) as Job | undefined;
}

export function updateJobStatus(
  jobId: number,
  newStatus: JobStatus,
  actorMemberId: number,
  blockedReason?: string,
): void {
  const d = getDb();
  const now = Date.now();

  d.exec("BEGIN");
  try {
    const job = d.prepare(`SELECT status FROM job WHERE id = ?`).get(jobId) as { status: string };
    const oldStatus = job.status;

    // Update the job row
    const timestampCol =
      newStatus === "accepted" ? "accepted_at" :
      newStatus === "done" ? "done_at" :
      newStatus === "closed" ? "closed_at" : null;

    if (timestampCol) {
      d.prepare(`UPDATE job SET status = ?, ${timestampCol} = ?, blocked_reason = ? WHERE id = ?`)
        .run(newStatus, now, blockedReason ?? null, jobId);
    } else {
      d.prepare(`UPDATE job SET status = ?, blocked_reason = ? WHERE id = ?`)
        .run(newStatus, blockedReason ?? null, jobId);
    }

    // Write job_event
    const eventType =
      newStatus === "blocked" ? "blocked" :
      newStatus === "accepted" ? "accepted" : "status_changed";

    d.prepare(`
      INSERT INTO job_event (business_id, job_id, type, actor_member_id, from_value, to_value, note, created_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    `).run(jobId, eventType, actorMemberId, oldStatus, newStatus, blockedReason ?? null, now);

    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

// ─── Chasing and closing the loop ────────────────────────────

export interface PendingJob {
  id: number;
  title: string;
  status: JobStatus;
  assigned_at: number | null;
  done_at: number | null;
  assignee_name: string | null;
  assignee_wa_jid: string | null;
  assignee_wa_lid: string | null;
  assignee_phone: string | null;
  customer_name: string | null;
  customer_wa_id: string | null;
  chat_wa_id: string | null;
}

const PENDING_COLS = `
  j.id, j.title, j.status, j.assigned_at, j.done_at,
  m.name  AS assignee_name,
  m.wa_jid AS assignee_wa_jid,
  m.wa_lid AS assignee_wa_lid,
  m.phone AS assignee_phone,
  c.display_name AS customer_name,
  c.wa_id        AS customer_wa_id,
  cv.wa_chat_id  AS chat_wa_id
`;

const PENDING_JOINS = `
  FROM job j
  LEFT JOIN member       m  ON m.id  = j.assignee_id
  LEFT JOIN contact      c  ON c.id  = j.contact_id
  LEFT JOIN conversation cv ON cv.id = j.conversation_id
`;

/** Sent to someone who hasn't acknowledged it, and not yet reminded. */
export function getJobsNeedingNudge(olderThanMs: number): PendingJob[] {
  const d = getDb();
  return d.prepare(`
    SELECT ${PENDING_COLS} ${PENDING_JOINS}
    WHERE j.business_id = 1
      AND j.status = 'assigned'
      AND j.assigned_at IS NOT NULL
      AND j.assigned_at < ?
      AND j.nudged_at IS NULL
  `).all(Date.now() - olderThanMs) as unknown as PendingJob[];
}

/** Still unacknowledged well after the nudge. The owner needs to know. */
export function getJobsNeedingEscalation(olderThanMs: number): PendingJob[] {
  const d = getDb();
  return d.prepare(`
    SELECT ${PENDING_COLS} ${PENDING_JOINS}
    WHERE j.business_id = 1
      AND j.status = 'assigned'
      AND j.assigned_at IS NOT NULL
      AND j.assigned_at < ?
      AND j.escalated_at IS NULL
  `).all(Date.now() - olderThanMs) as unknown as PendingJob[];
}

export function getPendingJob(jobId: number): PendingJob | undefined {
  const d = getDb();
  return d.prepare(`
    SELECT ${PENDING_COLS} ${PENDING_JOINS}
    WHERE j.business_id = 1 AND j.id = ?
  `).get(jobId) as PendingJob | undefined;
}

/** Jobs finished but whose customer hasn't been told yet. */
export function getJobsAwaitingCustomerUpdate(): PendingJob[] {
  const d = getDb();
  return d.prepare(`
    SELECT ${PENDING_COLS} ${PENDING_JOINS}
    WHERE j.business_id = 1
      AND j.status = 'done'
      AND j.notified_at IS NULL
      AND j.contact_id IS NOT NULL
  `).all() as unknown as PendingJob[];
}

export function markNudged(jobId: number): void {
  getDb().prepare(`UPDATE job SET nudged_at = ? WHERE id = ?`).run(Date.now(), jobId);
}

export function markEscalated(jobId: number): void {
  getDb().prepare(`UPDATE job SET escalated_at = ? WHERE id = ?`).run(Date.now(), jobId);
}

/**
 * The customer has been told. That closes the job — the gap between 'done'
 * (work finished) and 'closed' (customer informed) is the whole difference
 * between a task list and a ticketing system.
 */
export function markCustomerNotified(jobId: number, actorMemberId: number | null): void {
  const d = getDb();
  const now = Date.now();
  d.exec("BEGIN");
  try {
    d.prepare(`
      UPDATE job SET notified_at = ?, status = 'closed', closed_at = ?
      WHERE id = ?
    `).run(now, now, jobId);
    d.prepare(`
      INSERT INTO job_event (business_id, job_id, type, actor_member_id, from_value, to_value, created_at)
      VALUES (1, ?, 'customer_notified', ?, 'done', 'closed', ?)
    `).run(jobId, actorMemberId, now);
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

// ─── Dashboard queries ───────────────────────────────────────

export interface DashboardJob {
  id: number;
  title: string;
  description: string | null;
  status: JobStatus;
  priority: string;
  blocked_reason: string | null;
  assignee_name: string | null;
  customer_name: string | null;
  created_at: number;
  assigned_at: number | null;
  accepted_at: number | null;
  done_at: number | null;
  closed_at: number | null;
}

/** Every job, open ones first, newest first within each group. */
export function getJobsForDashboard(): DashboardJob[] {
  const d = getDb();
  return d.prepare(`
    SELECT j.id, j.title, j.description, j.status, j.priority, j.blocked_reason,
           j.created_at, j.assigned_at, j.accepted_at, j.done_at, j.closed_at,
           m.name AS assignee_name,
           c.display_name AS customer_name
    FROM job j
    LEFT JOIN member  m ON m.id = j.assignee_id
    LEFT JOIN contact c ON c.id = j.contact_id
    WHERE j.business_id = 1
    ORDER BY
      CASE WHEN j.status IN ('done','closed') THEN 1 ELSE 0 END,
      j.created_at DESC
  `).all() as unknown as DashboardJob[];
}

// ─── Waitlist ────────────────────────────────────────────────

export interface WaitlistEntry {
  name?: string | null;
  business?: string | null;
  phone?: string | null;
  email?: string | null;
  teamSize?: string | null;
  note?: string | null;
}

export function addToWaitlist(entry: WaitlistEntry): number {
  const d = getDb();
  const row = d.prepare(`
    INSERT INTO waitlist (name, business, phone, email, team_size, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    entry.name ?? null,
    entry.business ?? null,
    entry.phone ?? null,
    entry.email ?? null,
    entry.teamSize ?? null,
    entry.note ?? null,
    Date.now(),
  ) as { id: number };
  return row.id;
}

export function countWaitlist(): number {
  const d = getDb();
  return Number((getDb().prepare(`SELECT count(*) AS n FROM waitlist`).get() as { n: number }).n);
}

// ─── Retention ───────────────────────────────────────────────

/**
 * Drop messages older than the retention window that never became part of a
 * job. The product only needs job-linked messages plus a short rolling buffer
 * so a job can still be made from something said yesterday.
 *
 * This is the main privacy lever: without it, a breach exposes the business's
 * entire message history instead of their open work orders.
 *
 * Returns the number of rows removed.
 */
export function purgeOldMessages(olderThanMs: number): number {
  const d = getDb();
  const cutoff = Date.now() - olderThanMs;

  const result = d.prepare(`
    DELETE FROM message
    WHERE sent_at < ?
      AND job_id IS NULL
      AND id NOT IN (SELECT source_message_id FROM job)
  `).run(cutoff);

  return Number(result.changes);
}

// ─── Prepared statements (lazy) ──────────────────────────────

function stmts() {
  const d = getDb();
  return {
    upsertConv: d.prepare(`
      INSERT INTO conversation (business_id, wa_chat_id, type, title, created_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(business_id, wa_chat_id)
        DO UPDATE SET title = coalesce(excluded.title, title)
      RETURNING id
    `),
    upsertContact: d.prepare(`
      INSERT INTO contact (business_id, wa_id, display_name, first_seen_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(business_id, wa_id)
        DO UPDATE SET display_name = coalesce(excluded.display_name, display_name)
      RETURNING id
    `),
    insertMsg: d.prepare(`
      INSERT INTO message (business_id, conversation_id, wa_message_id, sender_wa_id,
                           direction, type, body, quoted_wa_message_id, sent_at, created_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, wa_message_id) DO NOTHING
      RETURNING id
    `),
    selectMsg: d.prepare(`
      SELECT id FROM message WHERE conversation_id = ? AND wa_message_id = ?
    `),
  };
}

// ─── saveMessage ─────────────────────────────────────────────

export function saveMessage(msg: IncomingMessage): SavedMessage {
  const d = getDb();
  const s = stmts();
  const now = Date.now();
  const direction = msg.fromMe ? "out" : "in";

  d.exec("BEGIN");
  try {
    // 1. Upsert conversation
    const convRow = s.upsertConv.get(
      msg.waChatId,
      msg.isGroup ? "group" : "dm",
      msg.groupSubject ?? null,
      now,
    ) as { id: number };

    // 2. Upsert contact (every sender, including owner/staff — filter later)
    let contactId: number | null = null;
    if (msg.senderWaId) {
      const contactRow = s.upsertContact.get(
        msg.senderWaId,
        msg.senderName ?? null,
        now,
      ) as { id: number };
      contactId = contactRow.id;
    }

    // 3. Insert message — RETURNING gives us the id on fresh inserts
    let msgRow = s.insertMsg.get(
      convRow.id,
      msg.waMessageId,
      msg.senderWaId ?? null,
      direction,
      msg.type,
      msg.body,
      msg.quotedWaMessageId,
      msg.sentAt,
      now,
    ) as { id: number } | undefined;

    // Fallback: ON CONFLICT DO NOTHING swallowed the insert (duplicate)
    if (!msgRow) {
      msgRow = s.selectMsg.get(convRow.id, msg.waMessageId) as { id: number };
    }

    d.exec("COMMIT");

    return {
      messageId: msgRow.id,
      conversationId: convRow.id,
      contactId,
    };
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}
