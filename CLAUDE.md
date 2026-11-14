# Parchi — project context for Claude

WhatsApp-native job assignment for small businesses. Working name, changeable.

**Read `docs/PRODUCT.md` before suggesting any product or scope change.** It holds the
reasoning behind the decisions below, and the full spec lives at
https://claude.ai/code/artifact/71c5842c-27b2-43b7-8794-e76759f2a64f

**Read `docs/SCHEMA.md` before touching the database.** It is the specification for all six
tables, the write contracts, and the queries Steps 4–6 depend on. Implement it as written;
if something there looks wrong, say so rather than quietly changing it.

---

## What it does

Small businesses run operations on WhatsApp. The owner's phone is the bottleneck —
everything arrives there, and work only moves when he personally tells someone.

1. A customer messages the business's WhatsApp.
2. The owner **replies to that message with `@ravi`**.
3. Parchi creates a job from the quoted message and assigns it to Ravi.
4. Ravi gets it **on WhatsApp**, from the owner's own number, and replies `ok` / `done`.
5. The owner sees everything open on a dashboard, and can send the customer an update.

The owner never leaves WhatsApp to assign. Staff install nothing.

## How it connects

Parchi links to the owner's existing WhatsApp as a **linked device** — the same mechanism
as WhatsApp Web. One scan, nothing about their setup changes.

Consequences that shape the whole design:
- Group chats work (the official Cloud API cannot see groups at all)
- Outbound messages are free — no templates, no 24-hour window, no per-message fees
- Staff get pinged from a number they already recognise: their boss's

**This is against WhatsApp's terms of service.** Accepted deliberately. See
`docs/PRODUCT.md` → Platform risk. The practical consequence for code:

> Keep the WhatsApp connection behind a swappable interface. The ticket layer must not
> know or care where a message came from. `wa_id` is the permanent identity key for a
> customer regardless of transport. If this route closes, we replace one adapter.

---

## Current state

**Phase 0 is feature-complete.** One business, hardcoded staff, no auth, no
multi-tenancy. All seven steps done, plus several things added after.

| Step | | |
|---|---|---|
| 0 | Laptop setup, TypeScript project runs | done |
| 1 | Connect to WhatsApp, print messages | done |
| 2 | Survive restart without re-pairing | done |
| 3 | Store messages in SQLite (`docs/SCHEMA.md`) | done |
| 4 | `@name` reply → create and assign a job | done |
| 5 | Send the job to the staff member | done |
| 6 | Parse staff reply → update status | done |
| 7 | Web dashboard | done |

Added since: owner-created jobs (`@ticket`), closing the loop to the customer,
nudges and escalation, linking by pairing code as well as QR, LID identity
resolution, 7-day message retention.

**Next, in order:** deploy to a VPS so it runs 24/7 → run it with one real
business for two weeks → watch the staff-response number. Dashboard polish,
OTP login and multi-tenancy come after that, not before.

### Files

| | |
|---|---|
| `src/index.ts` | Socket lifecycle, message dispatch, startup wiring |
| `src/db.ts` | Schema and every query. Nothing else touches SQL |
| `src/jobs.ts` | Burst rule, `@mention` assignment, `@ticket`, staff reply parsing |
| `src/notify.ts` | Nudges, escalation, customer updates. Sending is injected, so it knows nothing about Baileys |
| `src/linking.ts` | QR vs pairing-code choice at startup |
| `src/dashboard.ts` | HTTP server for the dashboard |
| `public/index.html` | The dashboard page — plain HTML, no build step |

### What a user can type

| Who | Where | What | Effect |
|---|---|---|---|
| Owner | customer's chat | `@ravi` | Job from that customer's message burst |
| Owner | staff member's chat | `@ticket <work>` | Job from the text, assigned to that person |
| Owner | anywhere | `send 7` / `send 7 <message>` | Tells the customer, closes the job |
| Staff | their own chat | `1` / `2` / `3` | accepted / done / stuck |

---

## Stack and commands

- Node + TypeScript, **ESM** (`"type": "module"`)
- `baileys` — WhatsApp protocol library, **pinned to 6.7.24**
- `pino` — logger, silenced
- `qrcode-terminal` — prints the link QR
- **`node:sqlite`** (built into Node, stable in 24) — **not `better-sqlite3`**, which
  compiles C++ at install time and fails on Windows + Node 24. Postgres later, when there
  is more than one business.

```
npm start      # run once - use this for pairing/linking
npm run dev    # run with auto-restart on save
```

Do not use `npm run dev` while linking a device — a restart mid-pair invalidates the code.

Dashboard at `http://localhost:3000`, and on the LAN address it prints at startup so it
can be opened on a phone.

**Schema changes have no migrations.** Phase 0 has no users: delete `parchi.db`,
`parchi.db-wal` and `parchi.db-shm` and let it rebuild. That stops the day a real business
is connected.

---

## Keeping this file honest

This file is the only thing a new session knows. If it drifts from the code, the next
session starts from a wrong picture and confidently builds on it.

**After any change that alters what the project IS** — a step completed, a new module, a
new thing a user can type, a decision reversed — update the relevant section here in the
same sitting. Not the end of the week.

Good commit rhythm: finish a feature → update this file → `git commit` with both.

If you are a session that just discovered this file is out of date, say so before building
on it.

---

## Gotchas already paid for — do not re-learn these

**Pin Baileys.** `npm install baileys` resolves to `7.0.0-rc*`, a release candidate that
depends on `whatsapp-rust-bridge` and fails to load with
`ERR_PACKAGE_PATH_NOT_EXPORTED`. Stable is **6.7.24** (npm `legacy` tag).

**Baileys is ESM-only.** The project must stay `"type": "module"`. tsconfig uses
`module: ESNext` + `moduleResolution: Bundler` so relative imports don't need `.js`
extensions.

**`browser` must be a known-good preset.** Use `Browsers.ubuntu("Chrome")`. A custom
string like `["Parchi", "Chrome", "1.0.0"]` causes "Couldn't link device" on the phone.

**Always tear down a dead socket before reconnecting.** On `connection === "close"`:
`removeAllListeners` for each event, then `sock.end(undefined)`, *then* reconnect on a
timer. Calling the connect function again without this stacks live sockets, each one
replaces the previous (code 440), and the loop feeds itself until the process dies.

**Disconnect codes are not interchangeable:**
- `515` restart required — normal right after linking, reconnect after ~1s
- `440` connection replaced — **stop**, do not reconnect, something else took the session
- `401` logged out — stop, needs a fresh link
- anything else — usually network, reconnect after ~3s

**`messages.upsert` fires for history too.** Guard on `type !== "notify"` or the terminal
floods with old chat on every connect.

**Message text lives in different places** by type: `conversation`,
`extendedTextMessage.text`, or a media caption. `protocolMessage` and
`senderKeyDistributionMessage` are WhatsApp's internal bookkeeping — filter them out, they
are not from a human. See `describe()` in `src/index.ts`.

**Group vs 1:1 sender:** in a group the sender is `msg.key.participant`; in a 1:1 chat the
sender is `msg.key.remoteJid` itself.

**QR is more reliable than pairing codes** for development. There is a `USE_PAIRING_CODE`
flag at the top of `src/index.ts` — pairing codes matter for real mobile-only owners, but
they are flakier, so don't let them block local work.

**WhatsApp sends LIDs, not phone numbers, and you cannot guess identity from them.**
A LID (`248107426156741@lid`) is an opaque per-user id WhatsApp uses instead of a phone
JID (`918109322881@s.whatsapp.net`). Both customers and staff now arrive as LIDs, so a
`wa_id` seeded from a phone number will never match an inbound sender, and you cannot
extract digits from a LID.

**Resolve both identifiers when a member is created, using `sock.onWhatsApp()`.** Verified
in the 6.7.24 source (`lib/Socket/chats.js`): it issues a USync query with
`.withLIDProtocol()` and returns `{ jid, exists, lid }`. So the mapping is available on the
pinned version — ask for it once, store both, never infer.

```ts
const [hit] = (await sock.onWhatsApp(`91${phone}`)) ?? [];
if (!hit?.exists) return null;                 // number is not on WhatsApp
const waJid = String(hit.jid);                 // 918109322881@s.whatsapp.net
const waLid = hit.lid ? String(hit.lid) : null; // 213945457614937@lid
```

`lid` is typed `unknown`, so cast it. The call needs a live socket, so member creation runs
after `connection === "open"`. A number not on WhatsApp is dropped from the result list
entirely — surface that to the owner rather than storing a half-resolved member.

Match an inbound sender against **either** column:
`WHERE active = 1 AND (wa_jid = ? OR wa_lid = ?)`.

`signalRepository.lidMapping` (`getLIDForPN` / `getPNForLID`) is **Baileys 7.x only** —
do not reach for it here.

**Never infer who sent a message.** Matching an unknown sender to "the member with an open
job" or any similar heuristic is a correctness and security hole: any stranger who messages
the business then controls job status, and the guess gets written permanently into that
member's row. If a sender cannot be matched to a known member by exact id, do nothing.

**Baileys logs directly to the console, bypassing pino.** `Bad MAC`,
`Failed to decrypt message with any known session`, `Closing session: SessionEntry {...}`
and `Closing open session in favor of incoming prekey bundle` come from inside the
`libsignal` package. They are routine Signal-protocol session churn, not application
errors — Baileys retries and recovers. Silencing pino does not stop them; filter `console`
if the noise hides real output.

**SQLite ignores foreign keys unless you turn them on,** per connection. Run both pragmas
immediately after opening the database or every `REFERENCES` in the schema is decorative:
`PRAGMA foreign_keys = ON` and `PRAGMA journal_mode = WAL` (the Step 7 web page reads while
the socket writes).

**Timestamps are `INTEGER` epoch milliseconds everywhere.** Never `datetime('now')`, never
ISO strings — mixing the two formats in comparable columns makes comparisons silently
wrong. And `sent_at` must come from `Number(msg.messageTimestamp) * 1000`, not
`Date.now()`: the burst rule measures gaps between messages, so arrival time merges
unrelated jobs when the network hiccups.

**The `auth/` folder is account access.** Those keys make the holder a linked device on
that WhatsApp account. Gitignored. Never log, print, commit, or screenshot it. In
production it gets envelope-encrypted with a per-business key wrapped in a KMS.

---

## Scope discipline

The owner of this project is new to Node/TypeScript and wants to understand the code, not
just receive it. **Explain the non-obvious parts; use Python comparisons where they help.**
Build in small steps that each end in something observable.

Deliberately **not** being built, and not to be suggested without a reason:

- A WhatsApp inbox inside the app — this means building a WhatsApp client, +150–250h.
  The owner stays in WhatsApp; that is the whole point of `@mention` assignment.
- A native staff app — +80–150h, and the install is where adoption dies.
- **Bulk messaging — never.** It is the single fastest way to get a customer's number
  banned, and competitor reviews are full of exactly that complaint. This absence is a
  selling point, not a gap.
- AI job classification, analytics, SLAs, CRM integrations, multiple numbers per business.
  All later. These exist in competitors because their customers have 50 agents.

Phase 0 has no Docker, no Redis, no queues, no login, no multi-tenancy. The architecture in
`docs/PRODUCT.md` is the destination, not the starting point.

---

## The number that decides this project

**Percentage of assigned jobs that get a status update from staff within 24 hours.**

Target above 80%. Below 50% after two weeks with a real business, the concept does not
work and no amount of product polish fixes it. Keep the staff action as close to free as
possible: one word in WhatsApp, a tappable button, a nudge after 30 minutes, and the owner
able to see who hasn't responded.
