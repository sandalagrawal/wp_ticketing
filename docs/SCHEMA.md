# Parchi — database schema

Six tables. This file is the specification: implement it as written, and if something here
looks wrong, say so rather than quietly changing it.

> **The SQL below is copied from `createTables()` in `src/db.ts`.** If the two ever
> disagree, the code is the truth and this file is the bug — fix it here rather than
> changing the code to match. It has drifted once already: it documented a
> `member.wa_id` column for days after that was split into `wa_jid` and `wa_lid`.

Reviewed design notes and the diagram behind this:
https://claude.ai/artifact/G9ho1qknSMtVXghzAK4Lrw

---

## Decisions already made

**Use `node:sqlite`, not `better-sqlite3`.** It ships with Node and is stable in Node 24
(which this project runs). `better-sqlite3` is a native module that compiles C++ at install
time and reliably fails on Windows + Node 24 unless Visual Studio build tools are
installed. The API is nearly identical.

```ts
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("parchi.db");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA journal_mode = WAL");
```

**Both pragmas are mandatory, on every connection.**
- `foreign_keys = ON` — SQLite *ignores* `REFERENCES` without it. Every constraint below
  is decorative until this runs.
- `journal_mode = WAL` — in Step 7 the web page reads while the WhatsApp socket writes.
  Without WAL they block each other.

**All timestamps are `INTEGER`, epoch milliseconds.** No ISO strings, no
`datetime('now')`. Mixing `datetime('now')` (`2026-11-05 14:30:00`) with `toISOString()`
(`2026-11-05T14:30:00.000Z`) puts two different formats in comparable columns and
comparisons silently misbehave. Integers also make the burst rule plain subtraction.

**`sent_at` comes from WhatsApp, not from arrival time:**

```ts
const sentAt = Number(msg.messageTimestamp) * 1000;  // seconds -> ms
```

Using `Date.now()` breaks the burst rule — one network delay merges two unrelated jobs.

**`business_id` on every table, `DEFAULT 1` for now.** Phase 0 has one business, but
retrofitting tenant scoping across every table, unique key and query later is a weekend of
work plus a data migration. One column today. Every query filters on it.

---

## The six tables

Create them all in a single `db.exec()`. `message` and `job` reference each other, which
SQLite permits — it doesn't validate foreign key targets at `CREATE` time, only at
insert time, and by then both exist.

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

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
```

---

## Why each table exists

| Table | Holds | Note |
|---|---|---|
| `member` | staff and the owner | `handle` is what `@ravi` matches — never match on `name`, which breaks on duplicates, typos and case. **`wa_jid` and `wa_lid` are both needed**: WhatsApp uses either depending on context, so an inbound `done` must be matched against both. Filled by `sock.onWhatsApp()` once the socket is open; `identity_attempts` and `identity_checked_at` cap the retries |
| `contact` | WhatsApp identities seen | **This includes the owner and staff**, because every sender gets upserted. Treat it as "any identity", not "customer". Filter by joining `member.wa_jid` / `member.wa_lid` when you need customers only |
| `conversation` | where a message was said | In a DM this is nearly the same as the contact. In a **group** it is completely different: the group is the place, the participant is the person. Groups are the reason this project uses a linked device at all, so this table stays |
| `message` | every message, one row each | `type` + `body`, never a column per media kind — a message is one kind of thing, so per-kind columns would be null on every row. `job_id` is null for most messages, which is normal: most messages never become jobs |
| `job` | the ticket | Holds no WhatsApp identifiers — only internal ids. That is the adapter boundary: swap the transport and this table does not change |
| `job_event` | the history | Things that happen repeatedly (reassignment, reopening) cannot be columns. This is also the only way to compute the project's key metric: did staff update within 24 hours |

---

## Status machine

```
new ──> assigned ──> accepted ──> in_progress ──> done ──> closed
                         │                          ▲
                         └──────> blocked ──────────┘
```

| Status | Set by | Means |
|---|---|---|
| `new` | system | Created, no assignee yet |
| `assigned` | owner / manager | Sent to a staff member, not yet acknowledged |
| `accepted` | staff | **Seen and picked up.** Without this the owner is guessing whether anyone saw it — it is the single most important state |
| `in_progress` | staff | Optional; useful for multi-day jobs |
| `blocked` | staff | Carries `blocked_reason`, surfaces to the owner immediately |
| `done` | staff | Work finished, customer not yet told |
| `closed` | owner / system | Customer has been updated |

`done` and `closed` are deliberately separate. That gap is the difference between a task
list and a ticketing system.

**Crossing it is an explicit act.** When a job reaches `done`, the owner is messaged with
the customer's name; he replies `send <id>` (optionally with his own wording) and only
then does the customer hear anything, `notified_at` get set, and the job close. It is not
automatic: owners routinely want to add something ("bill is ₹800"), and a message reaching
a customer unseen is how people stop trusting the tool. See `src/notify.ts`.

**Chasing lives on the job row too.** `nudged_at` is set when the assignee is reminded
(30 min unacknowledged), `escalated_at` when the owner is told nobody has responded
(2 hours). Each is written *before* the send, so a failed message can't queue a reminder
that repeats on every sweep.

**Reopening** sets `status` back to `assigned` and writes a `reopened` row in `job_event`.
It is not a status of its own — it is an event, because it can happen more than once.

Every status change writes a `job_event` row. The `*_at` columns on `job` are a
convenience for queries; `job_event` is the source of truth for history.

---

## Write contracts

### `saveMessage` must return ids

Step 4 needs `message.id` to set `job.source_message_id`. `lastInsertRowid` is unreliable
when `ON CONFLICT DO NOTHING` swallows a duplicate, so use `RETURNING` with a select
fallback.

```ts
export interface IncomingMessage {
  waChatId: string;
  isGroup: boolean;
  groupSubject?: string;
  waMessageId: string;
  senderWaId: string | undefined;
  senderName: string | undefined;
  fromMe: boolean;
  type: MessageType;            // 'text' | 'image' | ...
  body: string | null;
  quotedWaMessageId: string | null;
  sentAt: number;               // epoch ms, from msg.messageTimestamp * 1000
}

export interface SavedMessage {
  messageId: number;
  conversationId: number;
  contactId: number | null;
}

export function saveMessage(msg: IncomingMessage): SavedMessage;
```

Inside, wrap all three writes in one transaction (`db.exec("BEGIN")` /
`"COMMIT"` / `"ROLLBACK"`), because a half-written message with no conversation is worse
than no message.

```sql
-- conversation
INSERT INTO conversation (business_id, wa_chat_id, type, title, created_at)
VALUES (1, ?, ?, ?, ?)
ON CONFLICT(business_id, wa_chat_id)
  DO UPDATE SET title = coalesce(excluded.title, title)
RETURNING id;

-- contact
INSERT INTO contact (business_id, wa_id, display_name, first_seen_at)
VALUES (1, ?, ?, ?)
ON CONFLICT(business_id, wa_id)
  DO UPDATE SET display_name = coalesce(excluded.display_name, display_name)
RETURNING id;

-- message
INSERT INTO message (business_id, conversation_id, wa_message_id, sender_wa_id,
                     direction, type, body, quoted_wa_message_id, sent_at, created_at)
VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(conversation_id, wa_message_id) DO NOTHING
RETURNING id;

-- fallback when the message was already stored
SELECT id FROM message WHERE conversation_id = ? AND wa_message_id = ?;
```

`coalesce(excluded.x, x)` matters: a later message with no `pushName` must not erase a
name already learned.

### Creating a job (Step 4) — insert order

`message` and `job` point at each other, so it takes three steps inside one transaction:

1. The message row already exists (saved on arrival).
2. `INSERT INTO job (...)` with `source_message_id` = that message's id.
3. `UPDATE message SET job_id = ? WHERE id IN (...)` for the whole burst.
4. `INSERT INTO job_event` rows for `created` and `assigned`.

---

## Queries Step 4 will need

### The burst — which messages belong to this job

Fetch **all** messages in the window, not just the sender's, because a message from the
business side is a boundary:

```sql
SELECT id, sender_wa_id, direction, sent_at
FROM message
WHERE conversation_id = ?
  AND sent_at BETWEEN ? AND ?
ORDER BY sent_at;
```

Then walk outward from the anchor message in code and stop when any of these is true:
- the gap to the next message exceeds **5 minutes**
- the sender changes
- a message with `direction = 'out'` appears (the business already replied — new topic)
- ten messages have been collected

### Does this customer already have an open job?

Drives *implicit attaches, explicit creates*. Runs on every inbound message.

```sql
SELECT id FROM job
WHERE contact_id = ?
  AND status NOT IN ('done','closed')
ORDER BY created_at DESC
LIMIT 1;
```

### Which member sent this reply?

Match against **both** identifiers — the same person arrives as either:

```sql
SELECT id, name, handle, role FROM member
WHERE business_id = 1 AND active = 1
  AND (wa_jid = ? OR wa_lid = ?);
```

Inactive members must be rejected — an ex-employee replying `done` to an old job message
gets a refusal, not a status change.

**No match means do nothing.** Never infer the sender from circumstance ("the one member
with an open job"): a LID carries no information to deduce from, customers arrive as LIDs
too, and a guess gets written permanently into that member's row. This was a real bug —
see `CLAUDE.md`.

---

## Retention (not Phase 0, but keep it possible)

The spec keeps only job-linked messages plus a rolling seven-day buffer. Nothing
implements this yet. The schema makes it one statement:

```sql
DELETE FROM message
WHERE sent_at < ?                       -- now - 7 days
  AND job_id IS NULL
  AND id NOT IN (SELECT source_message_id FROM job);
```

---

## Deliberately not here

- **No `job_message` link table.** `message.job_id` covers it. The only thing lost is one
  message spawning two jobs ("fix the AC and bring the invoice"), which is rare — add the
  link table the day it actually matters. A column to a link table is an easy migration.
- **No media storage.** `type` records that a photo arrived; the file is not saved, and the
  job sent to the staff member is **text only** — he gets the caption, not the picture.
  For a job that *is* a photo of a broken part, that's a real gap. The cheap fix when it
  matters is forwarding the original WhatsApp message rather than downloading and
  re-uploading it. The dashboard can't show media until this changes either.
- **No `business` table.** `business_id` is a hardcoded `1` until there is a second
  business.
- **No `estimated_time`**, no SLA fields, no analytics tables. Later.
- **No migrations.** Phase 0 has no users: to change the schema, delete `parchi.db` and let
  it recreate. That freedom ends the day a real business is connected.
