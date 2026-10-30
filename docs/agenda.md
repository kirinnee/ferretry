# Agenda

The agenda is what the owner has to decide or do, and what each item blocks. It replaces "Attention"
as the name of the feature (`fy attention …` still works, deprecated). A plain notification with
nothing to decide is a **notice**, not an agenda item (see [Notices](#notices)).

The daemon owns the model: the state machine is `packages/daemon/src/lib/agenda/state-machine.ts`,
the wire contract is `packages/protocol/src/lib/agenda.ts`. This page says what they mean.

## Agenda mode is a switch

A ferret keeps an agenda only while its **Agenda mode** switch is on. It is a recorded per-session setting
like Hypermedia and Pack mode (`config.agenda`, `sessionAgendaEnabled`; absent means OFF, but a new ferret records ON
from the machine default below), switched from the
ferret's **Actions › Agenda mode** toggle or `fy notify agenda on|off`, and it takes effect at the ferret's
next launch. With it off the ferret is told only the notify rule and the session summary carries no
`agendaMode`, so the chat draws no agenda line or drawer.

**The machine default** is `agendaMode` in `machine.yaml`, on unless turned off in Settings › Machines, with
`fy machine set agenda-mode on|off`. It only decides what a ferret records when it starts and has recorded
nothing; a stored per-ferret value always wins and ferrets that already exist are not touched. It is not a
loosening, so it needs no `fy config confirm`. The whole contract is
[notifications.md § Agenda mode](notifications.md#agenda-mode).

## Every item belongs to a card

An item names the board card it is about (`task`, board-design.md §2.6). `fy agenda add --task F18` names it;
an add that names none takes the raising session's **focus card** (`config.focusTask`) — the CLI's, a harness
question's and a Warden escalation's alike. A session with no focus card raises an item with no card. The card
only derives from the agenda: its open items are its asks, and an open **blocking** one makes it "Waiting on
you" until the item is answered — nothing is written to the card. A notice is context, never an ask.

The CLI sends `task` only to a daemon that reports `agenda.task.1`; an older one refuses the whole add over the
field, so the item is raised without it and the CLI says so. For one release a bare `--task` (or a value that
is not a card reference) still means a to-do; `--todo` is its name now. The kind is named `--kind todo` for the same
reason — "task" means a board card — and `--kind task` is still read as its older spelling. The wire value stays
`task`, so a released daemon keeps accepting the add.

## Turns

Every open item is somebody's turn. `agendaTurn(item)` (protocol) is the one definition:

| Turn       | When                                                                   |
| ---------- | ---------------------------------------------------------------------- |
| **owner**  | A new ask. The owner has not answered, or the ferret handed it back.   |
| **ferret** | The owner asked to talk it through (Discuss), or asked for more info.  |
| **done**   | Resolved (answered, dismissed or replied to), or the item is a notice. |

A new ask is the owner's turn. Nothing starts "in discussion": the ferret raises it, the owner reads it.

Internally the ferret's turn is `waitingOn: 'ferret'` with `waitingFor` either `'discussion'` (the owner
asked to discuss it) or `'info'` (the owner asked for more information). Clients read the turn, not those two
fields. **A chat reply is not a turn at all: it parks the item** (see "Parked items").

## Handing it back

On the ferret's turn there are three ways out. The same two verbs also bring back an item the owner's
reply parked (see "Parked items"). **None of the first two pings the owner.**

- `fy agenda edit <id> …` — change the card (settled answers, what is still open, new options). Any edit by
  the raising agent on its own turn hands the item back to the owner, even one that changes nothing.
- `fy agenda surface <id> [--why "…"]` — hand it back as it stands.
- `fy agenda done <id>` / `dismiss <id>` — close it, if the talk settled it.

A human's edit never changes whose turn it is.

## Chatting about items

The owner can mention open items in a chat message: type `!A5`, or attach "re:" chips (several are fine).
The ferret receives the message as

```
[re !A5 «title», !A7 «title»] <text>
```

**A reply is not an answer, and it is not "still open" either.** Each referenced item is closed for the
owner at once (next section). The message itself is the delivery: the ferret reads `[re !A5 …]` in its chat,
and the daemon sends nothing else (a `replied` change that no observer reacts to). A notice is never
referenced. If the ferret finishes a turn without touching a referenced item, the daemon nudges it once
(nudge-once keys on the `[re !A…` opener); after that it stays quiet.

Picking an option on the card (`respond`) still answers the item, exactly as before. `--other "<words>"`
remains on the CLI and in the app for "none of the options"; chat no longer guesses it.

## Parked items

A parked item is still open, but it is **nobody's turn** for now: it leaves the owner's open list, the Inbox's open
sections, the badge counts and "Needs you", and the session summary does not count it. It carries
`parked: { reason, at, until? }` and reads as the `parked` turn (`agendaTurn`). There are two reasons, one
mechanism: why it is parked, and its way back.

### Replied

An item the owner replied to in the chat (`[re !A5 «title»] …`) is **parked as `replied`** the moment the message
is accepted. Otherwise an item a ferret never touches would hang on the owner's list for ever, and closing it
would lose it when the ferret still needs something.

- **The words are kept.** The reply text is a `replied` entry in the item's history, cut at the detail limit. A
  reply with no words (a bare chip) records the entry without a note. Any wait (more information, a discussion)
  ends: the reply answered it.
- **The ferret decides what happens next.** `fy agenda surface <id> [--why "…"]` or its own
  `fy agenda edit <id> …` brings it back on the owner's turn — **fresh**: `waitingSince` is now, so it reads as
  new and unread. `fy agenda done <id>` closes it when the reply settled it.
- The app lists it under **Replied (n)**; the owner can bring it back themselves ("Back to my list").
- Buttons, options and `[answer to !A…]` are unchanged: they still resolve with a response, as `done`.
- **Warden items follow the same rule.** A daemon-raised item the owner replied to parks like any other; it is
  not raised again for the same anomaly while the Warden's "already told" record holds.
- **Discuss is separate.** The owner's explicit Discuss (and a request for more information) still puts the item
  on the ferret's turn and counts as a request.

### Snoozed

The owner can put an open item away ("we are waiting for approval"): **for** a while or **until** a time — 1 hour,
4 hours, tomorrow 9:00 in their own time zone, or a time they pick. In the app it is the clock in the item's head
(never a button in the answer row); on the command line `fy agenda snooze <id> --for 4h | --until 17:00`, and
`fy agenda unsnooze <id>` brings it back now.

- **It wakes on its own** at `until`, or at its `neededBy` when that is sooner — a deadline is never slept
  through (`agendaWakeAt`). The daemon's waker sweeps every minute and reads only the boards, so a snooze
  outlives a restart and an item that fell due while the daemon was down wakes on the first sweep.
- **It comes back fresh** (`waitingSince` is the wake), unread, on the owner's turn. The phone buzzes only when
  it blocks the ferret or has a deadline, once per wake (see [notifications.md](notifications.md)).
- **The ferret is told without text tags**: the state is the item's own field, and `fy agenda ls` says
  "snoozed by the owner until …". A ferret's `edit` or `surface` leaves a snoozed item asleep (an edit still
  changes its words). Only `--now` — it is urgent — wakes it, and a ferret may do that **once an hour per item**
  (`urgentAt`; a second try inside the hour is refused as `rate-limited`).
- Only the owner snoozes and unsnoozes; only the daemon's own timer wakes. A notice is read, not snoozed.
- **The app ships first**: a daemon reports `agenda.snooze.1` on `GET /v1/health`, and the app sends snooze or
  unsnooze only to a machine that lists it. To an older machine it sends nothing and says the machine needs an
  update; a machine not yet read that refuses the request as an unknown action is told apart the same way.

**Migration.** Replies used to close items (`disposition: 'replied'`), and before that they left an item on the
ferret's turn. When a board is read, an item still waiting on the ferret only because of an owner reply is
parked as `replied` at the reply, and an item closed as `replied` is open again, parked as `replied` at its
close — newest first, and only while the board has room (the per-session cap, and the agent cap for a ferret's
item); the rest stay closed, and `surface` or `edit` still reopens one. It is pure and idempotent
(`parkOwnerReplies`), and the next write persists it.

## What an item blocks

Three optional fields say how much the owner's answer matters:

| Field         | Flag                     | Meaning                                              |
| ------------- | ------------------------ | ---------------------------------------------------- |
| `blockingNow` | `--blocking`             | The ferret is stopped until this is answered         |
| `willBlock`   | `--will-block "<thing>"` | What it will block ("the 14:00 deploy"), ≤ 200 chars |
| `neededBy`    | `--by "<time>"`          | When the answer is needed (an instant)               |

`--by` takes an ISO time (`2026-10-29T17:00:00Z`, local when it names no offset), a wait (`in 3h`, `in 90m`,
`in 1d`, `in 1h 30m`) or a clock time (`17:00`, its next occurrence). Anything else is refused with these forms.

On `edit`, each field is set again or taken off by name: `--not-blocking`, `--clear-will-block`, `--clear-by`.
These send `clear: ['blockingNow' | 'willBlock' | 'neededBy', …]`, because the fields have no empty value; a
request that sets and clears the same field is refused. Edits are kept in the item's revisions like any
other field. `fy agenda ls` prints them as `blocking now`, `will block` and `needed by`, under the turn.

The daemon does not decide when to push for these: stopped and deadline pings are
covered by the notification policy ([notifications.md](notifications.md)).

## Notices

A notice is a plain notification: `notice: true` on the raise request. No ask, no answers, no steps, kind
`info`, and **never anybody's turn** — it does not count as open in the session summary and chat cannot
reference it. `ping: true` asks for the phone to buzz and is only valid on a notice. `fy notify` raises one
(the older `fy attention notify` still works, deprecated).

## Lane proposals

A ferret that works in a project with no lanes runs `fy board lanes propose --template <t> [--rename old=new]…`.
The daemon stores the set at once (unconfirmed, live) and raises **one** choice on the proposer's agenda,
`Lanes for <project>: A → B → … · Accept / Edit`, with `source: 'task'` and the stable `sourceRef`
`lanes:<projectId>:<version>`, so proposing the same version twice is one card. **Accept** confirms the set
as the owner; **Edit** points at the Board lane editor. A ferret's own edit leaves a set unconfirmed, an
owner's edit confirms it. The routes are `GET /v1/board/projects` and `GET|POST /v1/board/projects/:projectId/lanes`.
If the card cannot be raised the set stays live and the response says `agenda: "failed"`.

## Confirming a configuration change

An edit that loosens what the machine may spend or do is **held** until the owner confirms it
([config-files.md](config-files.md#how-a-file-is-read)). A ferret must not confirm, so it raises a card whose
**Allow is the confirmation** — the owner answers it and nothing else has to be run:

```
fy agenda add "Allow the Jev price correction?" --title "Jev price correction" \
  --context "The Warden overcharges every run until it is on" --confirms warden.yaml
```

- **Raising.** `--confirms <file>` names the file; the daemon looks up its held edit and records on the item
  (`confirms`) the edit's digest — its etag, the same one `fy config confirm` confirms by — and each loosening
  in the daemon's words. The caller never supplies either. A file with no held change is refused and nothing
  is raised. The daemon writes the card: a choice of **Allow** (swipe right), **Deny** (left) and **Discard
  change** (up), and a premise that is the change itself followed by "Allow applies this change to
  warden.yaml." (the raiser's own `--premise` follows, when it fits). `--kind`, `--option`, `--question` and
  `--up` are refused beside `--confirms`.
- **Allow** puts the held edit into effect **only if it still has the recorded digest**. If the file was edited
  after the card was raised, nothing is confirmed: the card is restated with the change as it is now
  (`confirms.restated`, the new premise kept as a daemon revision, the owner's turn again) and the answer is
  refused `409 config_changed` so the owner reads it again. If no change waits any more (confirmed elsewhere,
  reverted), the card is closed and the answer refused `409` saying so.
- **Deny** closes the card and touches nothing: the held edit stays held, the tighter version in effect.
- **Discard change** drops the held edit — the file goes back to the version in effect (a new file that was
  never in effect is removed) — under the same digest rule.
- The ferret reads the outcome with the owner's answer: `confirmed warden.yaml: the change is in effect`,
  `denied: …`, `discarded …`, then the owner's own note.

**Who may answer.** Only the owner, enforced in the daemon, never in the app:

| Caller                                                       | Allow / Discard change                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `fy` at the machine (admin token, ungoverned)                | yes, as `fy config confirm` is                                                                                                 |
| a paired device (the app), relayed or not                    | the file's grant on `configure`; Allow also a passkey proved for the act (`loosen-config`), which the app asks for and resends |
| a ferret's own `fy agenda done --choice Allow` (its session) | refused `403`, before the file or the card is touched                                                                          |
| an agent token (a warden, any `peer:`/`warden:` caller)      | refused `403`                                                                                                                  |
| a caller nothing can say the grants of                       | refused `403`                                                                                                                  |

The rule is the config files' own (`heldEditRefusal`, shared with `POST /v1/config/confirm`), and the state
machine refuses any non-owner answer to such an item a second time. A ferret may still close its own card
unanswered (`fy agenda dismiss`). As for every admin-token caller, telling the owner's shell from a ferret's
rests on the session header the CLI sends ([grants.md](grants.md)): an honest-client boundary, not a
cryptographic one — the same boundary `fy config confirm` has.

## Verbs

`fy agenda add | edit | step | show | ls | history | surface | snooze | unsnooze | done | dismiss | needs-info | discuss | send-now`

| Verb                    | Does                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| `add`                   | Raise an item (the owner's turn). `--title` and the ask are required.        |
| `edit <id>`             | Reword; on the ferret's turn, or a replied item, hands it to the owner.      |
| `surface <id>`          | Hand it back to the owner, or bring back a replied one, unchanged (silent).  |
| `snooze <id>`           | The owner's: put it away `--for 4h` or `--until 17:00`; it comes back fresh. |
| `unsnooze <id>`         | The owner's: bring a snoozed or replied item back to the list now.           |
| `done <id>`             | Resolve, optionally answering its ask (`--choice`, `--yes`, `--other`…)      |
| `dismiss <id>`          | Close without answering; agents only their own.                              |
| `ls` / `show`           | Open items with turn and blocking fields / one item in full.                 |
| `needs-info`, `discuss` | The owner's side, kept for old clients. They make it the ferret's turn.      |

`edit` and `surface` take `--now` when it is urgent: it wakes an item the owner snoozed, once an hour per item.

**Sub-ferrets raise nothing.** A session another ferret started (`config.parent`) is refused `add`, `edit`,
`surface`, `done` and `dismiss` (and `fy notify`, the same owner-facing channel) with `forbidden`: `Sub-ferrets don't
raise agenda items or notify the owner; tell your lead: fy send <lead-callsign> "…"`. They report to the lead with
`fy send`; the lead decides what the owner must see. `AgendaService.apply` is the one choke point; reads stay open.
Their prompt carries no Agenda mode section even when the switch is on
([pack-mode.md](pack-mode.md#sub-ferret-limits)).

**A lead clears its sub-ferrets' agenda.** The lead (and any ancestor) may `edit`, `surface`, `done` and `dismiss`
items on the board of a session it started: `fy agenda done !A1 -s <sub-session>`. `AgendaService.apply` proves the
lineage from `config.parent` and marks the actor for the state machine (`overSubFerret`; a request cannot set it);
anyone else keeps `forbidden: an agent may change the agenda only in its own session`. The change is recorded as the
lead's. Warden escalations are not the lead's to close.

`fy attention …` runs the same handlers and prints one line to stderr first
(its text says `fy attention` is now `fy agenda`). It is hidden from help and will be removed.

`add` no longer takes `--surface`: the daemon still accepts `surface` on a raise (older CLIs send it) and
ignores it.

## Rules the writing keeps

The card is read cold, so it must stand alone: a title of about 40 characters, an ask in one sentence
(120 at most), the premise, context and what is decided or still open as short bullets, every term of art
defined with `--term`, never a secret value. The daemon lints for this and answers with advice, never a
refusal — with one exception below. Agents close their own items as soon as the reason is gone: an open item
whose blocker has cleared is a bug.

**The premise and the context are required.** They are what a cold reader starts from — what is going on, and
why it matters now — so every NEW item a ferret raises must carry both:

- `fy agenda add` refuses without `--premise` and `--context` (or the same fields in `--json-file`), naming
  the flag that is missing, before anything is sent. A blank one counts as missing.
- The daemon refuses the same raise from a ferret (`invalid`, naming the missing field), so a client that
  skips the CLI cannot skip the rule (`agendaBriefRequiredProblems` in `@ferretry/protocol`).
- **Exempt:** a notice (`fy notify`, read rather than answered); an item the daemon or the Warden raises (a
  lane proposal, a harness prompt, a handover, a Warden escalation), which writes its own words; an item the
  owner raises in the app, which is only warned about. A confirmation (`--confirms`) needs only
  `--context`: its premise is the held change, in the daemon's words.
- **Only new items.** It is checked when an item is raised, never when one is read or edited: an item already
  on a board keeps working without them, and `agenda edit` may still reword either.

## In the Inbox

The Inbox lists every item waiting on the owner, from every paired machine, grouped by ferret. Each group — and
each open item — says **who and what**, never the callsign alone: the ferret, what it works on (its task's name and
its card, `&F12`), and the machine. A row whose item is about a different card than its ferret's says that card too.

- **Opening an item shows the chat's own item view** — the same component (`AgendaItemView`), so Markdown, the
  options, the quick replies, the terms and the history read exactly as in the chat — with that ferret's **real
  composer** under it. A message typed there goes to the ferret's chat about the item (`!A5 …`, delivered as
  `[re !A5 …]`), the chat's own path; a quick reply carries what is typed as its note. "Open chat" goes to the
  conversation at the item, and so does a modified click on a row.
- **The open items are a deck**, on a phone and a wide screen alike. Swipe — from the item's head, its
  who-and-what line or its quick replies; the body scrolls — or press the arrow keys:
  - **↑** sends the **primary** answer (the recommended one, the right-hand answer on the card);
  - **←** and **→** send the others (→ takes what ↑ gave on the card, else it is the primary again);
  - **↓ skips** to the next item: nothing is sent and the item stays open.

  A held drag is stamped with what letting go would do (there is no hint line under the card). Every answer
  goes into the same undo window as a tap. Reduced motion (the OS preference or Settings › Appearance › Motion) drops
  the fly-off and the spring.

## Delivery

How the owner's card actions — an answer, a done, a dismiss, a Discuss or a request for more information —
reach the ferret (`AgendaReplyBatcher`, `packages/daemon/src/lib/agenda/reply-batch.ts`; the class keeps
its old name until a later release renames it; its files are [on disk](#on-disk) under the agenda names). The owner's words that drove it:
"only on receipt (the harness receive the 'card reply'), then it can be considered 'DONE', else it surfaces
back as a card again".

1. **Held.** The action goes to the ferret's outbox (`agenda-replies.json`, beside the agenda's own
   file). It is due **10 seconds after the last card action**: every further action on that ferret's cards
   restarts the countdown, and the first one never waits more than **2 minutes**. The agenda says so:
   `replies: {pending, dueAt, heldForTurn?}` on every `GET` and `POST` of the agenda route
   (`/v1/sessions/:id/agenda`; older clients use `/attention`, see [Compatibility](#compatibility)). "Send now"
   (`POST /v1/sessions/:id/agenda/replies`, `fy agenda send-now`) skips the countdown.
2. **Waiting for the turn.** A due batch waits while the ferret's `turnState` is `working`, and later
   answers join it. It is looked at again every 5 seconds and goes once the turn ends. Past 15 minutes it
   goes through the ordinary send path anyway, which queues natively. A state that cannot be read
   counts as not busy.
3. **Waiting for an empty composer.** A due batch is typed **only into an empty composer**: the pane is
   read first, and Claude's dim ghost suggestion is not text. A person's draft, or a screen that cannot
   be read, holds it (`delivery.heldForComposer`) and it is looked at again every 5 seconds. If a draft
   appears between the read and the keys, the send path refuses before a single key and the batch goes
   back to waiting. Past the composer wait (10 minutes after the cap) it is **undelivered** (step 5).
4. **Sending.** Once the send path accepts the batch it is `sending` (`delivery.sending` lists its
   items: the app's "Sending…"). It is **delivered only when the send ledger proves it** in the
   ferret's transcript (the send tracker’s `delivered` fate). The outbox then never queues
   those items again.
5. **Undelivered.** A send refused outright, a fate of `timed_out`, `unaccounted`, `withdrawn` or
   `cancelled`, no proof within the receipt wait (15 minutes), or a composer that never emptied: each
   item goes **back to the owner as an open card**. An answer, done or dismiss reopens the closed item; a
   Discuss or request for more information ends that wait. The item carries
   `undelivered: {at, reply, reason}`: the app shows "Your answer didn't reach <ferret> — answer again
   or Retry", and Retry posts `{...reply, id}`, the same action again. The owner's next action on the
   item clears the mark. An agenda already full of open items keeps the answer closed.

| Key in `config/daemon.json`       | Default | Range (whole seconds) | What it bounds                                   |
| --------------------------------- | ------- | --------------------- | ------------------------------------------------ |
| `agenda.replySettleSeconds`       | 10      | 1–3600                | the quiet time after the last card action        |
| `agenda.replyMaxWaitSeconds`      | 120     | 1–3600                | the longest the first action waits               |
| `agenda.replyComposerWaitSeconds` | 600     | 10–86400              | waiting for an empty composer, past the cap      |
| `agenda.replyReceiptSeconds`      | 900     | 30–86400              | waiting for the transcript's proof after sending |

The older `attention.` spellings of these keys are still read ([Compatibility](#compatibility)). A settle longer than the
max wait is **refused** by the config check, not clamped. All four are read at start.

- **Exactly once per item.** An item held, sending or delivered is never queued again. A batch is sent
  under `attention-<session>-<ids>-<stamp>`, the stamp being when the batch began. It is written down
  before it is sent, so a batch told twice, or re-sent after a restart, is one message. The stamp keeps an
  item answered again after an undelivered first answer off the id the ledger already settled. The
  instructions-updated note ([launch-settings.md](launch-settings.md)) is queued here too, under
  `instructions~<digest>`, and belongs to no item.
- **Durable.** A daemon restarted before a batch was accepted re-sends it under the same id; one
  restarted after looks for its proof. Answers held across a restart are delivered once it is back.
- **A damaged outbox** is set aside as `agenda-replies.json.damaged-<id>` and a fresh one starts, so it
  never stops later answers.
- **Why this replaced the old outbox.** The old one recorded a batch as delivered the moment it was handed
  over, and swallowed a refusal. A ferret whose composer held text (a person mid-message, or a stranded
  draft) refused the send, and the owner's Discuss or answer was lost while the agenda said it had gone.

## Compatibility

The agenda was called Attention, and its wire still carries that name for older apps and CLIs. The app ships from
`main` the moment a change merges while a daemon changes only after a release and `fy daemon update`, so for a while
every combination of old and new meets.

### Both spellings, one window

| Older name (still answered)               | Agenda name                       | Today                                                                      |
| ----------------------------------------- | --------------------------------- | -------------------------------------------------------------------------- |
| `GET/POST /v1/sessions/:id/attention`     | `/v1/sessions/:id/agenda`         | both served, same handler and grants                                       |
| `POST /v1/sessions/:id/attention/replies` | `/v1/sessions/:id/agenda/replies` | both served                                                                |
| `GET /v1/warden/attention`                | `/v1/warden/agenda`               | both served                                                                |
| `SessionState.attention`                  | `SessionState.agenda`             | both written, same value                                                   |
| journal `attention.*` events              | `agenda.*`                        | new names written; readers accept both                                     |
| `machine.yaml` `attentionNudge`           | `agendaNudge`                     | both read, the new one wins; config check warns                            |
| `config/daemon.json` `attention.{…}`      | `agenda.{…}`                      | both read, key by key the new one wins; a start notice names the old block |
| push kind `attention`, tag, `?attention=` | `agenda`, `?agenda=`              | old still SENT; apps read both                                             |
| handover `references.attention` count     | `references.agenda`               | old still written; new accepted                                            |

The last two rows are still sent the old way on purpose: an older app's service worker drops a push kind it does not
know, and the handover counts are a strict object an older reader refuses an unknown key in.

### On disk

A ferret's session directory holds the agenda as `agenda.json` and its held answers as `agenda-replies.json`; releases
before the rename called them `attention.json` and `attention-replies.json`. The daemon **reads the new name, else the
old one, and always writes the new one**, so a daemon upgraded or downgraded in between never loses an item.

- **Once, at start**, the daemon moves each session's old file to the new name: it writes the new file whole, reads it
  back and requires it equal, and only then renames the old file to `*.migrated`. A crash at any step leaves a file the
  reader still understands; the next start finishes it.
- **Both files present** (a crash between the two steps, or a downgrade and an upgrade): the newer document stays and the
  other becomes `*.migrated`. A ledger is newer by its `updatedAt`, then its `nextId`; an outbox has no clock, so it is
  dated by the latest instant of any answer in it. A tie keeps the new name.
- **A damaged old file is left exactly where it is** and the session counts as failed: the reader still reads or sets it
  aside as before, and the next start tries again. The marker `agenda-files-migration.json` in the daemon's home is
  written only when every session succeeded, and the migration never stops the daemon starting.
- **`*.migrated` files are kept for one release.** The release after the one that migrated may delete them.
- Records already in `notifications.jsonl` keep their `attention:` keys and their `attention` origin; new ones are
  written `agenda:`, and a repeat check treats the two spellings as one key. A daemon-written send id is read the same
  way: `attention-…` and `agenda-…` name one send.

### How each end finds out

A daemon that speaks the agenda names lists `agenda.wire.1` in `features` on `GET /v1/health`. The app reads that per
machine and dials the agenda routes only where it is listed; until it knows, it uses the older routes, which every
daemon answers. The CLI dials the agenda route and, on a `404` with `code: "unknown_route"`, retries the older one once
and keeps using it for that daemon.

### Watching for older clients

Each older route is marked legacy. The daemon records every use of one — route, first and last time, count and the
caller's `x-fy-version` — in `legacy-wire-use.json` in its home, reports it on `GET /v1/health` as `legacyWire`, and
`fy doctor` prints it ("older clients still use …" or "no older clients seen for 14 days"). It counts only requests that
passed authorization and writes the file at most once a minute (and on shutdown). `GET /v1/health` needs no
credential, so the report — route patterns, times and client versions, never a session or a body — is public to
anyone who can reach the daemon, like the rest of health. A server cannot see which
field a client reads; an app that reads `state.attention` also dials the older routes, so the routes stand in for it.

### The removal release

One release removes the older names and switches the rows still sent the old way (push kind, tag and link, the
handover count). It ships no earlier than **the second minor release after the one that added `agenda.wire.1`**, and
only once **every daemon you run shows no older-client use for 14 days** in `fy doctor`. Until then nothing here may
be removed.
