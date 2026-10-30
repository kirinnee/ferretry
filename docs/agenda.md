# Agenda

The agenda is what the owner has to decide or do, and what each item blocks. It replaces "Attention"
as the name of the feature (`fy attention …` still works, deprecated). A plain notification with
nothing to decide is a **notice**, not an agenda item (see [Notices](#notices)).

The daemon owns the model: the state machine is `packages/daemon/src/lib/attention/state-machine.ts`,
the wire contract is `packages/protocol/src/lib/attention.ts`. This page says what they mean.

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
is not a card reference) still means a to-do; `--todo` is its name now.

## Turns

Every open item is somebody's turn. `attentionTurn(item)` (protocol) is the one definition:

| Turn       | When                                                                 |
| ---------- | -------------------------------------------------------------------- |
| **owner**  | A new ask. The owner has not answered, or the ferret handed it back. |
| **ferret** | The owner wrote about it in chat, or asked for more information.     |
| **done**   | Resolved (answered or dismissed), or the item is a notice.           |

A new ask is the owner's turn. Nothing starts "in discussion": the ferret raises it, the owner reads it.

Internally the ferret's turn is `waitingOn: 'ferret'` with `waitingFor` either `'discussion'` (the owner
replied) or `'info'` (the owner asked for more information). Clients read the turn, not those two fields.

## Handing it back

On the ferret's turn there are three ways out. **None of the first two pings the owner.**

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

**Nothing resolves.** There is no answer-by-chat. Each referenced item becomes the ferret's turn and is
recorded as such (a silent `replied` change that no observer reacts to). A notice is never referenced.
If the ferret finishes a turn without touching a referenced item, the daemon nudges it once (nudge-once
keys on the `[re !A…` opener); after that it stays quiet.

Picking an option on the card (`respond`) still answers the item, exactly as before. `--other "<words>"`
remains on the CLI and in the app for "none of the options"; chat no longer guesses it.

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
fy agenda add "Allow the Jev price correction?" --title "Jev price correction" --confirms warden.yaml
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

`fy agenda add | edit | step | show | ls | history | surface | done | dismiss | needs-info | discuss | send-now`

| Verb                    | Does                                                                    |
| ----------------------- | ----------------------------------------------------------------------- |
| `add`                   | Raise an item (the owner's turn). `--title` and the ask are required.   |
| `edit <id>`             | Reword; on the ferret's turn also hands the item back (silent).         |
| `surface <id>`          | Hand it back to the owner without changing it (silent).                 |
| `done <id>`             | Resolve, optionally answering its ask (`--choice`, `--yes`, `--other`…) |
| `dismiss <id>`          | Close without answering; agents only their own.                         |
| `ls` / `show`           | Open items with turn and blocking fields / one item in full.            |
| `needs-info`, `discuss` | The owner's side, kept for old clients. They make it the ferret's turn. |

`fy attention …` runs the same handlers and prints one line to stderr first
(its text says `fy attention` is now `fy agenda`). It is hidden from help and will be removed.

`add` no longer takes `--surface`: the daemon still accepts `surface` on a raise (older CLIs send it) and
ignores it.

## Rules the writing keeps

The card is read cold, so it must stand alone: a title of about 40 characters, an ask in one sentence
(120 at most), the premise, context and what is decided or still open as short bullets, every term of art
defined with `--term`, never a secret value. The daemon lints for this and answers with advice, never a
refusal. Agents close their own items as soon as the reason is gone: an open item whose blocker has
cleared is a bug.

## Delivery

How the owner's card actions — an answer, a done, a dismiss, a Discuss or a request for more information —
reach the ferret (`AttentionReplyBatcher`, `packages/daemon/src/lib/attention/reply-batch.ts`; the class keeps
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
