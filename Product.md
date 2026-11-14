# Parchi — product background and decisions

Everything in this file is the *reasoning*. `CLAUDE.md` is the operating summary.
Full spec: https://claude.ai/code/artifact/71c5842c-27b2-43b7-8794-e76759f2a64f

---

## The problem

In a shop, clinic, workshop, or small distributor, the owner's WhatsApp *is* the
operations system. Everything arrives there and nothing leaves it except by the owner
personally telling someone.

- Requests get missed because they scrolled past
- Nobody knows who was assigned what, including the people assigned
- There is no record — when a customer asks "what happened to my order," the owner scrolls
- When the owner is unavailable, work stops

Existing help desks assume a support team, a portal, and staff who log in. Small
businesses have none of those.

## Who it's for

3–15 people, owner personally receives customer or operational messages on WhatsApp and
distributes the work. Service and repair shops, clinics and labs, small distributors and
dealers, event and catering operators, property and facility managers. India first.

**Not for:** companies with a real support team (Zendesk, Freshdesk, WATI, Interakt serve
them), anyone needing marketing broadcasts, anyone whose work doesn't originate in
WhatsApp.

## Open question that should have been answered by now

**Do the target businesses' actionable messages arrive in groups or in direct chats?**

This matters more than anything else technical. The official WhatsApp Cloud API cannot see
group chats at all. If the work arrives in groups — vendor groups, delivery coordination,
staff groups — then the linked-device route is the *only* one that works, and the
platform risk below is unavoidable rather than chosen.

Go look at four real prospects' phones before scaling anything.

---

## Why linked device, and the three routes considered

**1. WhatsApp Cloud API (official).** Requires the business to move its number onto Meta's
API. Coexistence mode now lets them keep using the WhatsApp Business app on the same number
— messages mirror both ways, ~6 months of history syncs, contacts sync. Genuinely low
friction for the owner.

But: **no group chat support at all**, activation requires Solution Partner or Tech
Provider status with Meta (or going through a BSP like 360dialog or Gupshup), the Business
App must be opened every 10–12 days or the link expires, not available in every country,
and the number needs 7+ days of prior activity. Plus per-conversation fees and approved
message templates for anything outside the 24-hour customer service window.

**2. Browser automation** (whatsapp-web.js + Puppeteer). Drives a headless Chrome loading
web.whatsapp.com. ~400–500 MB RAM per number. Unviable past a handful of businesses.

**3. Linked device via protocol library** (Baileys / whatsmeow). **Chosen.** Speaks
WhatsApp Web's multi-device protocol directly — Noise handshake plus protobuf frames, no
browser. ~50 MB per session. Groups work. No templates, no 24-hour window, no per-message
fees. Owner scans once and nothing about their setup changes.

Since 2021 each linked device holds its own identity key and works independently, so the
owner's phone can be off. Up to 4 companion devices per account — detect at onboarding and
tell the owner which to remove if the slots are full.

## Platform risk — accepted, with conditions

Linked-device access violates WhatsApp's terms. The terms prohibit "software or APIs that
function substantially the same as our Services and offer them for use by third parties in
an unauthorized manner." That is this, exactly.

**Why it survives commercially:** Meta bans phone numbers, not vendors — there is no
switch to shut a provider off, so enforcement lands on individual customers one at a time.
And the detection that actually fires is spam-driven: send velocity, new-contact rate,
block and report complaints. One operator's figures across 50+ deployments put
reactive-only messaging (replying to people who contacted you first) under 2% ban rates
over 12 months, versus 15–30% for proactive outbound to strangers. Periskope runs this way
at 5,000+ businesses.

**Why it's a different bet for us than for them:** Periskope can absorb a cease-and-desist
or a detection change — bad quarter, forced migration to Cloud API. For a solo founder it
is the end of the product. And our customers are more fragile than theirs: a big company
losing a support line is an incident; a small shop losing *the number that is their entire
business* is a catastrophe they will blame us for.

**Therefore, non-negotiable:**

1. Transport behind a swappable adapter. `wa_id` as the permanent customer identity
   regardless of source. Migration measured in weeks, not extinction.
2. Hard per-business outbound rate caps, enforced in one place in the code.
3. **Never** bulk messaging. Not as a feature, not as a setting, not "just for one
   customer."
4. Tell customers the tradeoff before they connect, in plain words, on the connect screen.
   Not buried in terms. Periskope advertises "no Business API required" openly; hiding it
   is worse than disclosing it.

---

## Competition

**Periskope** — closest. Right-click any message → task, assign to a teammate, due dates,
SLA escalations, automatic ticketing from group messages. Connects via WhatsApp Web
multi-device protocol by QR, no Business API. $15–30 per user per month, users *and* phone
numbers billed separately. Customers include Swiggy, Policybazaar, Shiprocket; testimonials
cite 50 CS agents and 250 program managers; Enterprise starts at a 50 user/phone minimum.

**It is not competing for our ICP.** It is a mid-market WhatsApp operations platform. A
six-person business is not who it is built, priced, or sold to.

**Talkvit** — nearly our exact flow, group-focused: keyword or `@mention` detection,
priority and deadline, assignment, `/done` and `/reopen` in chat, dashboard. Claims the
official Business API.

**Adjacent and crowded:** WATI, Interakt, DoubleTick, AiSensy, Gallabox, respond.io —
shared *customer support* inboxes with agent assignment, not internal work distribution.
Above them, Zendesk / Freshdesk / Zoho Desk with WhatsApp as a channel.

**Finding from reading their reviews:** most of the mixed sentiment traces to bulk
messaging — the feature that gets numbers banned. Parchi deliberately doesn't have it.
That is a positioning line: *"we never send bulk messages, which is why your number stays
safe."*

## Pricing

Competitors charge per seat. An owner with five field staff pays Periskope roughly
₹10,000/month, which is why small businesses don't buy those tools.

Because staff live in WhatsApp and consume no seat, Parchi bills **one price per business,
unlimited staff, one connected number.** Target ₹499–999/month. Outbound costs nothing to
send, so gross margin is infrastructure only.

This is a consequence of the architecture, not a discount. It cannot be copied without
rebuilding the product.

---

## Design decisions worth not relitigating

**`@mention` in WhatsApp, not a tap in the app.** You cannot add a menu inside real
WhatsApp — so "right-click a message" would require building a WhatsApp client first. The
owner replies `@ravi` in the chat he's already reading. The app is the dashboard, not the
workspace.

**Which messages go into a job.** The owner replied to a specific message, and WhatsApp
carries that anchor. Take it plus the *burst* around it: neighbouring messages from the
same sender, stopping at a gap over 5 minutes, stopping at any message from the business
side, capped at 10. In a group, "same sender" means that one participant.

Don't chase perfection — chase correctability. The confirmation says
`Job #34 → Ravi · 3 messages`, so a wrong guess is visible immediately and fixable in one
action.

**Implicit attaches, explicit creates.** A follow-up from a customer who already has an
open job attaches to it and notifies the assignee. A fresh `@name` from the owner always
creates a new job, even mid-conversation.

**Staff on WhatsApp, not in an app.** The staff member is the least motivated user in the
system and the most likely to kill adoption. Field staff won't reliably open a second app,
and once statuses go stale the owner stops trusting the dashboard and stops paying. Since
we're a linked device, pinging them costs nothing and comes from a number they know.

**`done` and `closed` are separate states.** Work finished vs customer informed. That gap
is the difference between a task board and a ticketing system, and it's where the product
earns its price. When a job is marked done, the owner gets a one-tap "send update" that
opens the customer's thread prefilled.

**Staff changes via the owner's own "Message yourself" chat.** There is no Parchi number —
Parchi *is* the owner's number. His self-chat becomes the command console:
`add Ravi 9876543210`, `remove Ravi`, `team`, `jobs`. The dashboard does the same things.

Offboarding is easy because staff never had an account: it's a database flag and they stop
receiving messages. But their open jobs must go back to unassigned and be pushed at the
owner — that is exactly where work quietly vanishes in a real business. Their history stays
in the audit log. An ex-employee replying `done` to an old message gets refused. Re-confirm
long-silent numbers, since recycled prepaid numbers are common in India.

---

## Privacy posture

Parchi is a device on the account, so messages arrive **already decrypted**. We can
technically read every conversation the business has. Every serious buyer works this out,
so the answer has to be designed in.

**The biggest lever is storing less** — a product decision, not a security one. Keep only:
messages that became jobs, follow-ups on open jobs, and a rolling 7-day buffer so a job can
still be made from yesterday's message. Everything else is processed in memory and never
written. That changes what a breach means from the business's entire customer history to a
list of open work orders.

| What | How |
|---|---|
| WhatsApp session keys | Envelope encryption — per-business key wrapped by KMS. These keys *are* account access; a leaked database must be useless without KMS |
| Message bodies | Column-level encryption. Disk encryption protects a stolen drive, not a dumped database or a compromised app server |
| Media | Encrypted object storage, short-lived signed URLs only |
| Backups | Encrypted, same retention, deletion requests reach them |

**Access:** staff see their own jobs and the message that created each one, enforced in the
query not the UI. Owner and manager see their business only. We get no routine access to
production message content; break-glass is time-limited and logged. "Our engineers can see
everything" is a losing answer to the question every careful buyer asks.

**Retention:** raw message buffer 7 days, job records 12 months after closing, media 90
days. On cancellation: unlink the device, purge within 30 days, confirm in writing.

**Law:** the business is the Data Fiduciary, Parchi processes on its behalf. India's DPDP
Rules were notified November 2025 on a phased ramp — soft enforcement through November
2026, full adjudication and penalties from May 2027, maximums up to ₹250 crore. Needed
before the first paying customer: a clear privacy notice, a written processing agreement
per business, deletion that actually works, a named grievance contact, retention that
executes. Have a lawyer review.

**Name the gap out loud:** the end customer never agreed to be in Parchi. The business
carries that as Data Fiduciary and the terms must say so plainly.

Write a one-page "what we store, what we don't, who can see it, how to delete it" and put
it in front of prospects before they ask. Most competitors answer this vaguely; a straight
answer is a sales asset.

---

## Architecture — the destination, not the start

One constraint shapes everything: **a WhatsApp connection is a long-lived stateful
websocket.** This cannot run on serverless functions. Every business needs a live process
holding an open socket, and the same session must never run on two machines at once.

| Component | Job | Notes |
|---|---|---|
| session workers | Hold the WhatsApp sockets | ~50 MB each; a 4 GB box carries 60–70. Sessions pinned to a machine with a lease so two workers never claim one |
| event queue | Every inbound message becomes an event | Redis Streams or BullMQ. Keeps fragile sockets away from business logic — a crash never loses a message |
| core service | Rules and state | `@mention` parsing, burst grouping, follow-up attachment, status transitions. Also serves the dashboard API |
| outbound sender | Sends messages out | The per-business rate cap lives here — this is the ban-risk control and it belongs in one place |
| postgres | Everything relational | Every query scoped by `business_id` |
| object storage | Media | S3/R2, encrypted, signed URLs |
| KMS | Wraps encryption keys | |
| scheduler | Nudges, 9am digest, session health | Plain cron worker |
| dashboard | Mobile-first web app | Not native. Nothing critical depends on it |

**Session lifecycle is where the real operational pain lives:**
- Persist auth state on *every* credentials update, not on a timer
- Distinguish a network blip from a user logout and act differently
- Track last-event-received per session; silence past a threshold means force a reconnect,
  because a socket can look alive and be deaf
- Long-running sessions degrade — schedule rolling restarts rather than waiting for failure
- Node is single-threaded; many sessions in one process bottlenecks the event loop. Worker
  processes per core

**Cost:** 100 businesses ≈ 5 GB session memory ≈ two mid-size boxes plus managed Postgres,
roughly $60–120/month against ~₹80,000/month revenue. The margin problem will be support
hours, not servers.

**Deployment:** stateful containers on Hetzner, Fly, or ECS. Never Lambda or Vercel
functions for the session layer. Local laptop is fine while building; move to a VPS
(~₹400–500/month) before a real business depends on it, since a sleeping laptop drops the
connection.

---

## Data model

| Entity | Key fields |
|---|---|
| `business` | id, name, plan, created_at |
| `wa_connection` | business_id, phone_e164, encrypted_device_state, status (active/expired/logged_out), last_seen_at |
| `member` | business_id, name, phone_e164, role (owner/manager/staff), active, deactivated_at |
| `contact` | business_id, **wa_id**, display_name, phone_e164 — the customer; `wa_id` is the permanent identity key |
| `conversation` | business_id, wa_chat_id, type (dm/group), title, contact_id |
| `message` | conversation_id, wa_message_id, sender_wa_id, direction, body, media_ref, sent_at |
| `job` | business_id, conversation_id, contact_id, source_message_id, title, status, priority, assignee_id, created_by, accepted_at, done_at, closed_at |
| `job_message` | job_id, message_id — attaches follow-ups to an open job |
| `job_event` | job_id, actor_id, type, from_value, to_value, at — the audit trail |

Every table carries `business_id` and every query is scoped by it. Multi-tenant isolation
is not a later refactor.

**Job lifecycle:** `new` → `assigned` → `accepted` → `in_progress` → `done` → `closed`,
plus `blocked` (carries a reason, surfaces to the owner immediately). `accepted` exists
because without it the owner is guessing whether anyone saw the job. Reassignment is one
action and notifies both people.

---

## Onboarding

Five minutes, on a phone, no laptop anywhere.

1. **Sign in** — mobile number and an SMS code. No email, no password.
2. **Name the business** — one field, skippable.
3. **Add the team** — name and number each. *Before* connecting WhatsApp, because
   `@ravi` needs a Ravi to match, and it's an easy task that builds commitment before the
   hard one.
4. **Connect WhatsApp** — pairing code by default (QR for anyone at a desk).
5. **Health check** — confirm messages flow, report free device slots.
6. **First job, guided** — walk them through one real assignment.
7. **Staff welcome** — each person gets a message from the owner's number; their reply
   confirms the number works and that they'll respond at all.

**Failure states are most of the work:** SMS code doesn't arrive, all four device slots
taken, pairing code expires, connects then drops, owner abandons halfway, a staff number
isn't on WhatsApp, a staff member never replies to the welcome.

**Target:** connected inside five minutes, first job within 24 hours.

---

## Validation

Asking a stranger to let you observe their customer messages for a week doesn't work —
nobody says yes. What works instead:

1. **Start with a business you already have access to.** A relative's shop, a friend's
   clinic. Not a cold approach.
2. **Read competitor reviews** for "our staff didn't use it" — free, and already done:
   the complaints cluster around bulk messaging instead.
3. **Demo, don't ask for access.** A 2-minute phone demo, 10–15 shops, five minutes each.
4. **Ask for money, not access.** "₹799/month, first three months at ₹399 if you pay now."
   "Nice idea" means nothing; ₹399 means something.
5. **The product is what buys you access.** Nobody lets you observe their business; plenty
   will try a free tool. Build the 40 hours — it's also the demo and the credibility.

Some risks can't be tested cheaply before building. "Will staff update statuses" is
handled by **design** — one word in WhatsApp, a tappable button, nudges, visible
non-responders — and then watched closely once live.

## Risks

| Risk | Severity | Response |
|---|---|---|
| Staff don't update jobs, dashboard goes stale, owner stops trusting it | **Fatal** | Updates are one word in WhatsApp. Nudges. If under 50% after two weeks, stop building |
| A customer's number gets banned | **Fatal** | Reactive-only, no bulk, hard caps, disclose upfront, adapter architecture |
| Data breach — decrypted chats on our server | **Fatal** | Store less, encrypt at rest, no routine staff access |
| WhatsApp changes break the library | High | Pin versions, monitor sessions, budget 5–10 h/week maintenance once live. Forever cost, not build cost |
| Owner never opens the dashboard | High | Assignment happens in WhatsApp, so it works regardless. Daily digest pulls them back |
| Four device slots already full | Medium | Detect at onboarding, say which to remove |
| Periskope or Talkvit moves down-market | Medium | Their pricing and 50-seat minimums make it structurally awkward. Stay narrow and cheap |

## Measurement

**Primary: percentage of assigned jobs that get a staff status update within 24 hours.**
Above 80% good. Below 50% after two weeks of Phase 0, the concept does not work.

Supporting, once live: median message→assignment time, median assignment→done time, share
of done jobs where the customer actually got a reply, weekly active owners, jobs per
business per week (under ten and the pain probably isn't real).

## Effort

- **Phase 0** — 35–50 h. Connect, `@mention` detection, send to staff, catch replies,
  database, one plain page. One business, hardcoded.
- **Phase 1** — 150–200 h on top, plus ~25% for the unforeseeable. Multi-tenancy, OTP
  sign-in, staff management, the real dashboard, reply-to-customer, follow-up threading,
  media, session recovery, nudges and digest, roles, encryption at rest, deployment,
  monitoring.
- **Realistic v1: 200–300 h.** 5–8 weeks full-time, or 3–5 months at 15 h/week. Multiply
  by 1.5–2 for a first product in an unfamiliar stack.

Blowups to avoid: a WhatsApp inbox in the app (+150–250 h), a native staff app
(+80–150 h).