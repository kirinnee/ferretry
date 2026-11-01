# Agenda

The agenda is what the owner has to decide or do, and what each item blocks. It replaces "Attention"
as the name of the feature (`fy attention …` still works, deprecated). A plain notification with
nothing to decide is a **notice**, not an agenda item (see [Notices](#notices)).

**The agenda is not a task tracker.** It exists to get information, a decision or an action only the owner can
give. A ferret never raises an item to track or check its own work: no "please test X", "please verify Y" or "try it
after the release". That is the board's job: a finished card reaches its "To test" lane and the owner presses
**Done** or **Not good** ([board.md](board.md)). After the owner marks a result **Not good**, the ferret
opens an agenda item only if it needs something from them to fix it. The ferret's instruction says so
(`AGENDA_INSTRUCTION`, [notifications.md](notifications.md#agenda-mode)).

**A question the owner asks is answered on the agenda too.** The owner reads the agenda, not every reply, so an answer
given only in chat can be missed. When the owner asks a question ABOUT an open item ("[re !A163 …] what is X?"), the
ferret answers ON that item: `fy agenda edit !A163 --question-answer "<text>"` brings it back with an "Answer to your
question" block above its own options, which stay visible and answerable. **A question item keeps its own answer shape
until the owner answers it with one of its answers, or the ferret closes it with `done`.** The owner's reply never turns
it into a Got it, and an answer is never a separate `--kind info` item standing in for it: tapping Got it on an info item
resolves only that info item, never the question it was about. A question the owner asks about nothing in particular
gets one `--kind info` item holding the answer (premise = the question, ask or body = the answer, readable with no chat
open); a follow-up edits that item rather than adding another. `fy agenda done` on a question the owner has not
answered asks for `--reason`, and the item reads as **withdrawn**, never as answered.

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

### Done · closes &F12

An item tied to a card can offer the owner one extra answer, **Done · closes &F12**: one tap resolves the item
AND closes the card, through the same shared Done the board uses (the Closed lane, the card's history, and the
plain message to its ferret — nothing here is a second path).

- **Opt in**: `fy agenda add --task F12 --offer-close` (the flag `offerClose` on the item). It is **on by default**
  for a to-do (`--kind todo`) or a review on a card that is in the board's to-test lane when the item is raised —
  the lane `release.published` enters ("Released · to test"), the one notion the board's lane facts already use. A
  notice never offers it, and an add that names no card (and the session has no focus card) is refused the flag.
- **Where it sits**: one more answer in the one A/B/C row, in the → slot while the card gave fewer than three
  answers and in the full-width row otherwise. It is tap only: no swipe and no arrow reaches it, so a swipe
  can never close a card.
- **Order**: the card is closed first; only when that succeeded is the item resolved. A card the board refuses to
  close, or one that cannot be read, leaves the item open with "Not closed: …" under the row. The button is off
  while the card is closing, so a second tap closes nothing twice. The close is immediate: the Inbox's Undo window
  holds the item's resolution, not the card's.
- **Several cards**: the app lists them with a checkbox each, all ticked, and asks to confirm; cards close in
  turn and a failure names the card and which earlier ones already closed. (An item carries one `task` today, so
  the wire yields one card; the list is ready for the day it carries more.)
- **Owner only**: the tap is the owner's in the app, and the board's own gate already refuses a ferret moving a
  card into the Closed lane (`ownerGate`, standing `owner-human`).
- **The app ships first**: a daemon reports `agenda.offer-close.1` on `GET /v1/health`. The app offers the button
  only for a machine that lists it AND an item with a linked card of that machine that asked for it. The CLI sends
  `offerClose` only to a daemon that lists it; to an older one it raises the item without and says so.

## Gate items

A card the owner asked for that reaches a gate lane asks them here: ONE item the daemon raises and only the owner
answers ([board.md](board.md#gates-ask-the-owner) owns the rules). It is an ordinary choice item, so an app that
predates gates answers it by label, plus:

- **`gate`** (`AgendaGateSchema`): `cardId`, `laneId`, `laneName`, `entry` (the card history's `seq` that put it
  there), `projectId`, `projectName?`, and `options` (`id`, `label`, `outcome`: `next`, `lane`,
  `reopen-with-agenda`, `close`), in the lane's own order. Only the daemon writes it; an add that carries one is
  refused.
- **`sourceRef`** `gate:<card>:<lane>:<entry>`; the title is the card's, the ask the lane's ("Try it: <first step of
  How to test>", "OK to build? <summary>"), the premise its summary and the body its How to test, verbatim (never `steps`, which make a choice a mix).
- **Swipes.** → the first option that moves the card on (Done), ← the reopen-with-agenda option (Not good), ↑ a third (the owner's decision !A205). A gate with one
  option gets a second answer, **Not yet** (← ; the card stays). The ask lists its options in that order, ← · ↑ · →,
  because a choice card lays them out by it (`gateAskOptions`, `gateAnswers` in `@ferretry/protocol`). ↓ is Skip, and
  **Not needed** (the button) dismisses it: the owner's choice, the card stays where it is, quietly, and a device needs
  the `fleet` grant for it as for an answer. A bare done (`resolve` with no answer) is refused.
- **Answering** is `resolve` with `{kind: 'multiple-choice', choice: <label>}` and the owner's words as `note`; Not good
  needs words (the note, or `{kind: 'other', answer}`). The card moves first; a refusal leaves the item open
  (`400 invalid`, `403 forbidden`, `409 gate_moved_on`, `409 gate_not_moved`).
- **Who.** The owner at the machine, or a paired device the `fleet` grant lets use the board. A ferret, its lead
  (the sub-ferret rule below does not reach a gate item) and the daemon are refused every verb that would close or
  reword one. The daemon resolves one quietly when its card moves on. Clearing the agent ferrets' backlog skips gate
  items, and a chat message that names one does not park it.
- **Its follow-up.** Not good opens one `reply` item about the card, `gate-followup:<card>:<entry>`, raised by the
  daemon on behalf of the card's ferret once the card went back, starting on the ferret's turn (in discussion); the ferret edits,
  surfaces and closes it as its own, and the owner's answer reaches it as on its own item.
- **It buzzes once**, at its raise, and is never part of a stop's push ([notifications.md](notifications.md)).

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

On the ferret's turn there are three ways out. Only `edit` — with the whole card refreshed — brings back an item the owner's
reply parked (see "Parked items"); a bare `surface` is refused there. **None of the first two pings the owner.**

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
- **The ferret decides what happens next.** It brings the item back with `fy agenda edit <id> --summary "…"
--premise "…" --context "…"`, on the owner's turn — **fresh**: `waitingSince` is now, so it reads as new and
  unread. **The whole card is refreshed on every reply**: the owner's words changed what is going on, so the
  ask, the premise and the context are all written again (restating one unchanged is fine) and the card stays an
  isolated, self-contained statement of the situation. An `edit` that leaves one out is refused (`invalid`,
  naming the missing flags), and so is a bare `fy agenda surface <id>` of a replied item. The owner, the
  daemon's timer and a snoozed or never-replied item are unaffected. `fy agenda done <id>` closes it when the
  reply settled it.
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

The rule is the config files' own (`heldEditRefusal`, shared with `POST /v1/config/confirm`): the fleet's `use`
grant, the file's grant on `configure`, and for Allow from a governed device the passkey. Allow and Discard
change are written to the security log as `fleet.configured` (`config-confirm` / `config-discard`,
`via: agenda`) naming the caller — a paired device by its id — and the file's `kind` (`warden`, `pack`, `accountDefaults` …; never its name or path), exactly as a confirmation in Settings is
([audit.md](audit.md)); Deny changes nothing and is not recorded. The state
machine refuses any non-owner answer to such an item a second time. A ferret may still close its own card
unanswered (`fy agenda dismiss`). A ferret on its own session credential is always itself here, whatever
header it sends. As for every admin-token caller WITHOUT one, telling the owner's shell from a ferret's
rests on the session header the CLI sends ([grants.md](grants.md)): an honest-client boundary, not a
cryptographic one — the same boundary `fy config confirm` has.

**Declared gap: the agenda does not yet say "admin token".** The board and the lane sets record a call on the
admin token with no session credential as `admin-token` ([agent-tools.md](agent-tools.md#who-a-ferret-may-be-every-route-says)).
The agenda still records that caller as the person, so an item a ferret closed with `fy` and no session reads
"done by you". Its authority is right (the token is the owner's at the machine); only the label is not. Since a
ferret's `fy` and MCP server present its own credential ([secrets.md](secrets.md#what-a-ferrets-fy-presents)),
a current ferret on this machine's loopback is recorded as itself. "Done by you" still appears for an admin-token
act with no session header from: a pane whose credential is from before the `fys_` prefix; an MCP server
started before that change, until its pane restarts; a daemon on a wildcard, LAN or tailscale bind, which does
not take ferret credentials; `fy --as-owner`; `FY_TOKEN` set in a pane; and any process that reads
`api-token` itself. It closes only with an `admin-token` label beside the agenda's own `resolvedBy`.

## Verbs

`fy agenda add | edit | step | show | ls | history | surface | snooze | unsnooze | done | dismiss | needs-info | discuss | send-now`

| Verb                    | Does                                                                            |
| ----------------------- | ------------------------------------------------------------------------------- |
| `add`                   | Raise an item (the owner's turn). `--title` and the ask are required.           |
| `add --offer-close`     | With `--task`: the owner may close the card with the same tap that resolves it. |
| `edit <id>`             | Reword; on the ferret's turn, or a replied item, hands it to the owner.         |
| `surface <id>`          | Hand it back to the owner, or bring back a replied one, unchanged (silent).     |
| `snooze <id>`           | The owner's: put it away `--for 4h` or `--until 17:00`; it comes back fresh.    |
| `unsnooze <id>`         | The owner's: bring a snoozed or replied item back to the list now.              |
| `done <id>`             | Resolve, optionally answering its ask (`--choice`, `--yes`, `--other`…)         |
| `dismiss <id>`          | Close without answering; agents only their own.                                 |
| `ls` / `show`           | Open items with turn and blocking fields / one item in full.                    |
| `needs-info`, `discuss` | The owner's side, kept for old clients. They make it the ferret's turn.         |

`edit` and `surface` take `--now` when it is urgent: it wakes an item the owner snoozed, once an hour per item.

**Sub-ferrets raise nothing.** A session another ferret started (`config.parent`) is refused `add`, `edit`,
`surface`, `done` and `dismiss` (and `fy notify`, the same owner-facing channel) with `forbidden`: `Sub-ferrets don't
raise agenda items or notify the owner; tell your lead: fy send <lead-callsign> "…"`. They report to the lead with
`fy send`; the lead decides what the owner must see. `AgendaService.apply` is the one choke point; reads stay open.
Their prompt carries no Agenda mode section even when the switch is on
([pack-mode.md](pack-mode.md#sub-ferret-limits)).

**A lead clears its sub-ferrets' agenda.** The lead (and any ancestor) may `edit`, `surface`, `done` and `dismiss`
items on the board of a session it started (never a [gate item](#gate-items)): `fy agenda done !A1 -s <sub-session>`. `AgendaService.apply` proves the
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

**Every segment is short points, never a paragraph.** The premise, context, decided, still-open, question
answer, body, option details, ask, revision notes and terms all read as the same Markdown on the card: bullets
(`-` or `•`), numbered lists, **bold**, `code`, references, and a single line break kept as a line
(`segmentMarkdown` in the app owns that, so no segment flattens its lines). Writing follows: answer first, one
idea per line. `fy agenda add` and `agenda edit` warn, never block, when a segment is a single paragraph over
280 characters (`AGENDA_SEGMENT_PARAGRAPH_LENGTH` in `@ferretry/protocol`), saying to split it into short points
or bold the answer first. Lists, tables, headings and fenced code are not counted as paragraphs.

**The premise and the context are required.** They are what a cold reader starts from — what is going on, and
the facts around it — so every NEW item a ferret raises must carry both:

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

## What I need from you

**Every card has one answer shape, and it says it in one place.** Under the premise and the context, before any
optional section, every open card draws a segment headed **What I need from you**. It holds exactly the ask and
ends with one plain instruction, so the owner always knows what to do:

| Kind (`--kind`)                     | The segment shows                                   | The buttons                                            |
| ----------------------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| `choice`                            | ONE question, then each option with what it means   | the options (three on the row), recommended tagged     |
| `yesno`                             | one yes-or-no question                              | Yes · No                                               |
| `permission`                        | what is being approved, and its effect (`--impact`) | Approve · Deny                                         |
| `review`                            | what to review (`--link`)                           | Approve · Request changes                              |
| `reply`, one question               | the question                                        | none: "Type your answer below."                        |
| `reply`, several questions or a mix | a numbered list of each answer wanted               | none: "Reply with your answers below, numbered."       |
| `form`                              | numbered fields, each answered where it is asked    | none: the card's fields, the reply box, one Send       |
| `todo`                              | the steps, numbered, each ticked                    | Mark as done                                           |
| `info`, and a notice                | the message                                         | Got it (quiet: a bare Got it does not wake the ferret) |

- **Options are only for a choice; steps only for a to-do.** Several questions, or a question mixed with anything
  else, are `--kind reply` with one `--question` each: never option buttons. The owner answers them all in one
  reply, by number.
- **Request changes** is a button, never a swipe: it sends what the composer holds as the change asked for, or puts
  the owner in the composer when it is empty. Where no composer is at hand (the Sessions page's compact card), the
  card says to type the changes in the message box instead.
- **Swipes are the visible buttons only.** A card answered in words swipes nowhere except ↓ Skip.
- **It is enforced where an item is raised.** `fy agenda add` refuses a raise that mixes shapes before anything is
  sent, and the daemon refuses the same raise from a ferret (`invalid`), each naming the shape to write instead —
  "several questions → write them as a numbered list for the owner to answer in the reply: one --question each,
  --kind reply; no --option". `fy agenda edit` may not give steps to anything but a to-do. The daemon's and the
  Warden's own raises keep their fixed shapes, and a notice and a confirmation have theirs.
- **An item already on the board reads in its shape too**, from its stored fields (`agendaShape`): an old item with
  several questions loses its per-question pickers (any options it had are said in words), an old to-do keeps only
  Mark as done (and a Skip its ferret added), and an old choice that also had steps is a mix, answered in words.
- **One source of truth.** The rules and their words live in `packages/protocol/src/lib/agenda-shape.ts`: the line
  every ferret's prompt carries (`AGENDA_SHAPE_LINE`, inside `AGENDA_INSTRUCTION`), the `fy agenda add --help` table
  with an example per kind (`agendaShapeHelp`), the refusals (`AGENDA_SHAPE_ERRORS`, `agendaShapeProblems`) and the
  owner's instruction lines (`AGENDA_SHAPE_LEADS`). Change the wording there, never at a surface.

### Forms

A **form** (`--kind form`) is several structured answers at once. Its `fields` are an ordered list, one per question:

| Field type (`--field`)                 | Drawn as                               | Answer                       |
| -------------------------------------- | -------------------------------------- | ---------------------------- |
| `one` (options `Label: meaning`, 2–12) | radio buttons, each with what it means | the chosen label             |
| `many` (options as above)              | checkboxes                             | the chosen labels            |
| `yesno`                                | a Yes \| No segment                    | `Yes` or `No`                |
| `text`                                 | "Type it below."                       | whatever the reply box holds |

Write a field as `--field "id|type|Question|option|option…"`, one flag per field, in order: `--field "1|one|Which region?|EU: data
stays in Europe|*US: cheapest"` is a pick-one with two options. A leading `*` on an option (or `*Yes` / `*No` on a yes/no) marks the
recommended value; a trailing `optional` segment lets the field stay empty; `Name~Question` sets the short word the numbered
answer uses (`Region~Which region?` → "1. Region: EU"). The same list can be the `fields` of a `--json-file`. Ids are short and
unique (`1`, `region`); a pick-one or pick-many needs 2–12 options, a text field none. `fy agenda edit <id> --field …` replaces
the whole list.

- **One Send.** The card's fields and the reply box are one answer. Send combines them — "1. Region: EU · 2. Alerts: Page, Mail · 3. Restart: Yes · 4. <typed text>" — and delivers that to the ferret as the answer to the item. A form that has no `text`
  field sends the typed words as a note instead.
- **No secrets.** There is no secret field kind and a form answer is plain text on the item, so a password, token or code is never asked here: it goes through an input request ([input-requests.md](input-requests.md)), which the agent never reads.
- **Recorded by field id.** The answer is stored on the item as `{ kind: "form", answers: [{ id, picked }] }` (a pick-many's
  picked is a list), so the ferret reads `fy agenda show <id> --json` instead of parsing prose.
- **Empty required fields are asked about once.** The first Send says which fields are unanswered and that Send again sends
  it as it is; the next Send goes through. Nothing filled in at all is not sent.
- **No swipes** except ↓ Skip. Recommended values start picked and say "Recommended".
- **In the chat** (the Sessions page's compact card) the fields are drawn read-only with "Open this in the Inbox to fill it
  in, or answer in the reply box, numbered."
- **Stored `ask` is still `open-question`**, so an app that predates forms still reads the item as an open-question reply item;
  `kind: form` is what makes a current app draw the fields.

## Clearing the agent ferrets' backlog

Agent ferrets (sessions with `mode: auto`, the same fact as the Inbox's **Agents** filter) can leave a long backlog
the owner never meant to read. One owner action dismisses every open item on their boards.

- **Route:** `POST /v1/agenda/clear-agents` → `{ cleared, sessions }`. `{ "dryRun": true }` returns the same counts
  and dismisses nothing; the app and the CLI use it for the confirm. Offered as `agenda.clear-agents.1`.
- **Owner only.** An agent credential is refused with 403. Each item is dismissed through `AgendaService` as the
  human, with the note `cleared: agent-ferret backlog`. Only the open items of agent sessions are touched;
  interactive sessions' items, and items already resolved, are left alone.
- **CLI:** `fy agenda clear --agents [--yes]` shows the count and asks to confirm unless `--yes`. It is refused
  when `FY_SESSION_ID` is set — a ferret never clears for the owner.
- **App:** in the Inbox, choose **Agents** in the kind filter (All / Interactive / Agents) and press **Clear all
  from agent ferrets**. The confirm counts each machine with a dry run, then clears on every machine that offers
  the feature; a machine without it is listed as "needs an update", and one that did not answer as "could not be
  reached". The machines are those the Inbox shows rows from.

## In the Inbox

The Inbox lists every item waiting on the owner, from every paired machine, grouped by ferret. Each group — and
each open item — says **who and what**, never the callsign alone: the ferret, what it works on (its task's name and
its card, `&F12`), and the machine. A row whose item is about a different card than its ferret's says that card too.

- **Opening an item shows the chat's own item view** — the same component (`AgendaItemView`), so Markdown, the
  options, the quick replies, the terms and the history read exactly as in the chat — with that ferret's **real
  composer** under it. A message typed there goes to the ferret's chat about the item (`!A5 …`, delivered as
  `[re !A5 …]`), the chat's own path; a quick reply carries what is typed as its note. "Open chat" goes to the
  conversation at the item, and so does a modified click on a row.
- **The open items are a deck**, on a phone and a wide screen alike. Swipe — from the item's head or its
  who-and-what line; the body scrolls — or press the arrow keys:
  - **← ↑ →** send the card's answers, which mean the same everywhere (the deck, the card, the item view, what the
    CLI prints): a row of options is in the **options list's order** — the first ←, the second ↑, the third →
    (two options: ← and →) — wherever the recommendation sits;
  - **↓ is Skip**, everywhere a card swipes (the deck, the chat dock, the card's top bar and answer row, the ↓ key,
    and the to-test and task-panel cards): it moves on to the next one; nothing is sent, nothing is dismissed and
    the item stays open. A single mis-swipe can therefore never close a card.
  - **Not needed is a button, or the far side of the compass** (below) — never a plain swipe. It is the pill in the
    card's top bar and a button under the card, into the same undo window as any answer. A notice has no Not needed
    (it is cleared, not dismissed). The item's › also skips.

  A held drag is stamped with what letting go would do (there is no hint line under the card); a card pulled down shows
  "Skip" on the ground it uncovers, in the to-test rows' style. Every answer
  goes into the same undo window as a tap. Reduced motion (the OS preference or Settings › Appearance › Motion) drops
  the fly-off and the spring.

### The compass

Every item — a question, a gate, a notice — has a second swipe layer. Pull **down** past the Skip threshold and **keep the
pointer down**: a small compass opens on the ground the card uncovers, and where the pointer goes from there is what
letting go does:

- **↓ (let go)** is Skip, unchanged: the plain swipe down never reaches the compass.
- **↓ ←** is Skip too, the left arm of the compass.
- **↓ →** is **Not needed**: the item is dismissed into the undo window, and **Undo** (about five seconds, the toast every
  answer gets) really un-dismisses it — nothing is sent while the window is open.
- **↓ ↓** is **Snooze**, and going further down shows the three lengths — **↓↓↓ 1 h / 4 h / 1 day**, one per column;
  letting go over one snoozes the item until then, into the same undo window.
- Pulling back up, or letting go before the threshold, cancels: the card springs back and nothing happens.

A swipe down is therefore never destructive without Undo. The choices are a pure state machine
(`agenda-compass.ts`: a drag path in, an intent out), so the thresholds are tested without a pointer. Nothing depends on the
gesture: under every open card are plain buttons — **Skip** and **Not needed** — and the head's clock (`CardHead`: 1 h / 4 h /
tomorrow / custom) snoozes; the arrow keys are unchanged. Snooze is offered only where the machine advertises it
(`agenda.snooze.1`), in the compass and in the clock alike. The touch rules stay: a drag never starts on a control, and the direction locks on its first move.

### Gate items

A **gate item** is a board card waiting on the owner at a gate, raised as an ordinary Inbox item (`item.gate`: the card, its lane and what each option does):
the owner meets one stream, not a question list and a separate to-test list. It is
the card's ONE head row (the title, ‹ n/N ›, ⓘ, the snooze clock, ✕ — `CardHead`) under ONE quiet meta line: **what it is** — "Try it"
(a card in a verify lane) or "OK to build?" (a plan awaiting approval) — the project, the ferret and "Open chat ›". It repeats
nothing: no summary line, no chip, no restated ask. Its body is the card's _How to test_ as numbered tick-steps, and its
options are the gate's own, laid out as every choice is (the first ←, the second ↑, the third →) and then MIRRORED left/right for a gate, so the forward option is always on the right.

- **→** is the forward option (Done, OK to build, Yes), the same as the side panel's Cards view and the to-test rows; **←** is **Not good**, which reopens the card with an agenda item; **↓** is Skip. The buttons read Not good (left) · Done (right).
- **Not good needs words.** Pressing it (or ←) answers nothing yet: the "why" composer opens where the answer row was, and
  Send back stays disabled until something is written. The words go as the answer's note. Cancel changes nothing.
- On a **one-option gate** the left answer is **Not yet** — not one of `gate.options`: the card stays where it is, and words
  are welcome but not required.
- Answering is a plain choice, `{ kind: 'multiple-choice', choice: <label> }`, held in the undo window like any answer. A
  refusal (the card moved on, or the gate was not reached) shows beside the buttons, as for every answer.
- **Question items keep their sticky options and composer exactly as they were.**

**The app ships before the daemon.** A machine that advertises `board.gate-items.1` on its health sends gate items, and the
Inbox then drops the _synthesized_ to-test rows those items replace. A machine that does not keeps today's rows. A person-asked
card in a gate lane **with no open gate item** keeps its to-test row even on a machine that advertises gates, so no card
waiting on the owner is ever lost between the two lists.

**GAP — attachments.** The board's Not good takes pictures and files. The agenda's resolve carries a choice and a note but no
attachment ids, so **Not good from the Inbox is words only**; the composer says nothing about pictures. Sending pictures with
it needs the resolve contract to carry attachment ids; until then the owner opens the card on the Board for that.

### What the side panel's Cards view shows

The task panel's **Cards** view and the Inbox ask the same question of a card — _is it waiting on the owner?_ — through one
pure selector (`awaitingOwner`, `lib/awaiting-owner.ts`): a card shows only if it is **not dropped, asked of a person (not an
internal agent), and sitting in a gate lane**. A gate lane is a verify lane ("Try it") or an owner-gate lane that is not
closed ("OK to build?"). Everything else — to do, in progress, in review, merged, released, closed, and every internal or
agent-asked card — never appears there; the Kanban and the List show the rest. With nothing waiting, the view says so in one
line rather than listing cards that need nothing from the owner.

A card here swipes as a gate item does: **→ Done**, **← Not good**, **↓ Skip**, and the buttons read Not good (left) · Done (right). The to-test rows in the Inbox and the Answer-quickly run swipe the same way.

## Delivery

How the owner's card actions — an answer, a done, a dismiss, a Discuss or a request for more information —
reach the ferret (`AgendaReplyBatcher`, `packages/daemon/src/lib/agenda/reply-batch.ts`; the class keeps
its old name until a later release renames it; its files are [on disk](#on-disk) under the agenda names). The owner's words that drove it:
"only on receipt (the harness receive the 'card reply'), then it can be considered 'DONE', else it surfaces
back as a card again".

A bare **Got it** (or Done with no words) on an `info` item is never delivered: it resolves the item quietly, for the ferret to see in `fy agenda ls`, and starts no turn. Words the owner typed, a dismiss and every other kind still go through the steps below.

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
  item answered again after an undelivered first answer off the id the ledger already settled. With the
  durable queue switched off, the instructions-updated note ([launch-settings.md](launch-settings.md)) is
  queued here too, under `instructions~<digest>`, and belongs to no item.
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
- Records already in `notifications.jsonl` keep their `attention:` keys, their `attention` origin and their
  `attentionId` field; new ones are written `agenda:` with `agendaId`, a repeat check treats the two key spellings as
  one key, and `attentionId` is read as `agendaId`. A daemon-written send id is read the same
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
