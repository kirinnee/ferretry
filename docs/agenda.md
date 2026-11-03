# Agenda

The agenda is what the owner has to decide or do, and what each item blocks. It replaces "Attention"
as the name of the feature (`fy attention …` still works, deprecated). A plain notification with
nothing to decide is a **notice**, not an agenda item (see [Notices](#notices)).

**An agenda is one channel of the owner's attention** ([One channel per topic](#one-channel-per-topic)): a ferret
opens one only for what the owner alone can give — information, a decision or an action — and only when no open
agenda passes the three-part test; otherwise it adds to the closest. It never opens one just to track or check its
own work: no "please test X", "please verify Y" or "try it after the release". Testing a card is the board's job
today: a finished card reaches its "To test" lane and the owner presses **Done** or **Not good**
([board.md](board.md)). The ferret's instruction says all of this (`AGENDA_INSTRUCTION`,
[notifications.md](notifications.md#agenda-mode)).

**A question the owner asks is answered on the agenda too.** The owner reads the agenda, not every reply, so an answer
given only in chat can be missed. When the owner asks a question ABOUT an open item ("[re !A163 …] what is X?"), the
ferret answers ON that item: `fy agenda edit !A163 --question-answer "<text>"` brings it back (even from the replied pile) with an "Answer to your
question" block above its own options, which stay visible and answerable. **A question item keeps its own answer shape
until the owner answers it with one of its answers, or the ferret closes it with `done`.** The owner's reply never turns
it into a Got it, and an answer is never a separate `--kind info` item standing in for it: tapping Got it on an info item
resolves only that info item, never the question it was about. A question the owner asks about nothing in particular
gets one `--kind info` item holding the answer (premise = the question, ask or body = the answer, readable with no chat
open); a follow-up edits that item rather than adding another. `fy agenda done` on a question the owner has not
answered asks for `--reason`, and the item reads as **withdrawn**, never as answered.

## One channel per topic

**An agenda is one channel of the owner's attention: one context they switch into.** Everything in it is something
they would want to hear about in the same place, against the same background, and decide at the same pace.

- **The test.** Two things belong in one agenda when all three hold: **same place** (the owner would want to be told
  about both together), **same context** (one premise and one background explain both) and **same pace** (decisions
  on them come at about the same rate).
- **Always one:** things that depend on each other — cause and effect, a dependency, one blocking the other.
  Splitting them would make the owner decide half a thing.
- **Always two:** one item that would ask two independent decisions with different backgrounds, or at different
  speeds.
- **Search, check, then open.** A ferret opens a new agenda only when something needs the owner, or soon will, and
  no open one passes the test. Otherwise it adds to the closest; if unsure, it adds to the closest.
- **Split** a part that stops passing the test as the agenda evolves.
- **Its type evolves:** one agenda can go explainer → question → plan → tracker → test, whatever it needs from the
  owner right now.
- **Its states, as the ferret is taught them:** Needs you buzzes the owner; Resting is quiet. The owner's reply rests
  an item, the ferret's answer on it brings it back, and only the ferret marks it Done, when nothing more is
  expected. (Today a reply parks the item as replied, and `edit --question-answer` or `edit --back` brings it back:
  [Parked items](#parked-items).)
- **Chat discussion lands in the agenda.** When the owner discusses an agenda in the main chat, the ferret puts the
  exchange into it — the owner's words verbatim, then its reply — and links the agenda from its chat reply. Unsure
  which agenda: the closest, and it says so.
- **Two standing rules, in the prompt word for word.** "Bug batch: ONE agenda, line each + where tracked." and "Owner
  Q: answer ON it, options stay; no item: ONE `-k info`." (an owner's question about an item is answered on that
  item and its options stay; with no item to answer on, one `info` agenda carries the answer).

**`fy agenda add` runs the check.** Before it opens anything it lists the open agendas on the caller's own agenda
(its lineage: a sub-ferret has none of its own), closest first, each with its reference, its state (`needs you`,
`resting` or `snoozed`), its title and its card:

```text
Search, check, then open: these agendas are open, closest first.
  !A7  needs you  Ship the cache  &F9  ← carries &F9, which &F12 depends on
  !A2  resting    Relay choice

Should this join !A7? It does when all three hold: same place, same context, same pace;
dependent things always share one. If unsure, join the closest. Add it there instead (nothing is opened):
  fy agenda edit A7 --still-open 'Pick the relay region' --premise '…' --context '…'

Open a new agenda only when none passes the test:
  fy agenda add … --new "<why none fits>"
```

- **What a join carries.** `fy agenda edit` rewords an open agenda: it adds lines to what is still open, the premise,
  the context and what is decided, but it cannot give the agenda a new question, options, a body, blocking, an
  urgency or a deadline (the agenda edit verbs that can arrive later). So a **plain-words ask** (a line with its
  premise and context) joins by the one printed `edit`, which keeps every line both agendas say: the old still-open
  lines stay, the new ask is added to them, and the premise and context are the union of both. An item the owner
  replied to is brought back by the same edit with `--back --summary '<the new ask>'`, the old subject kept as a
  still-open line. A **structured ask** (options, an approval, a form, questions, steps, a body, `--blocking`,
  `--will-block`, `--by`, links, terms, an answer of its own such as `--up`, its own `--why` or `--resolve`, a different card) is never squeezed in:
  the listing says what would be lost and the safe way out, `--new "<why none fits; closest is !A7>"`.
- **`--new` bypasses the refusal, not the listing.** With `--new "<why>"` the same search runs and the same list is
  printed (to stderr, so `--json` still prints the raised item on stdout), ending "Opening a new agenda anyway: <why>";
  then the agenda opens. A bare `--new` still works for now, with a warning that the reason is wanted.
- **At a terminal** the question is asked ("Should this join !A7? [y/N]"). Only `y` joins (the edit is printed and
  nothing is opened). Enter, `n` or anything else opens nothing either: the two ways out are printed, and a new
  agenda needs `--new "<why>"`.
- **The old spelling still works.** `fy agenda add --title Deploy --premise x --context y --new "Choose region"`, from when
  `--new` was a flag with no value, reads the words `--new` swallowed as the ask (with a warning that `--new` now takes the
  reason). When the ask is given in words or with `--ask`, `--new` is the reason. The one ambiguity: a legacy bare
  `--new` followed by the ask's first word, with more ask words after it, reads that first word as the reason.

- **The order.** An agenda carrying the card `--task` names, or a card that one depends on or blocks, comes first
  (dependent things share one agenda); then the daemon's strong and weak related matches
  ([work-search.md](work-search.md#the-related-check)); then the words they share; then the oldest.
- **The candidates** are the items a ferret raised and can add to. The owner's own items, notices, held configuration
  changes, gate items and the daemon's input cards are never listed.
- **A ferret** (nobody at a terminal) is refused with the list and the two ways out; `--json` prints
  `{candidates, related}` and refuses the same way. **A person at a terminal** is asked "Should this join !A7?": yes
  prints the edit and opens nothing, anything else opens nothing and prints the two ways out.
- **With no candidate**, the add opens, unless the daemon's related check finds a STRONG match in someone else's work,
  which refuses as before (`--related A3`, `--related F12`, `fy send`).
- **Two decisions.** The add warns, and still opens, when the ask looks like two decisions: the one-line ask asks two
  questions or more, or its `-q` questions are wanted at different paces (one "now", one "next week"). The warning
  says both rules: independent decisions belong in two agendas, dependent ones share one. The heuristic is
  `twoDecisionSignals` in `packages/cli/src/lib/agenda/two-decisions.ts`.
- **A held configuration change** (`--confirms`) is its own card and skips the check.

**What the daemon raises on a ferret's behalf.** An input request (`terminal_request_input`,
`browser_request_input`) raises its own form card, because the form is what the owner answers. When the agent's
prompt strongly matches an open agenda of the same ferret, the card links to it ("Part of: <title>" → `!A3`), so it
does not read as a fresh topic (`closestAgenda` in `packages/daemon/src/lib/agenda/closest.ts`). The
`*_ask_owner` tools raise no agenda item at all: they bring the surface's tab forward.

**GAP: an input card does not join its agenda.** It stays a separate item that links to the closest one. Folding the
form into the topic's own item needs the card asks that card gates get later, and is not built.

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

## One ask per thing

The owner is asked about one thing **once**. A card that waits at a gate while a ferret already has an open question
about that same card on the owner's agenda would otherwise ask twice, so the daemon keeps the two apart
([board.md](board.md#one-ask-per-thing) owns the rules):

- **A gate attaches to a thread.** A card at a gate that has a **carrier thread** — an agent-raised item whose `task`
  is the card, not a gate item and not a notice, that is **open**, **not parked** (not replied to, not snoozed) and
  on the owner's turn or within the 24 h grace — raises **no gate item**. The daemon puts the gate on the
  thread instead: `gateAttached` (an `AgendaGate`, written only by the daemon; an add or edit that carries one is
  refused). With several threads it attaches to the one on the owner's turn, else the newest. A gate item already open
  when a thread appears is resolved by the daemon, its note naming the thread that now asks — unless the owner has
  begun to talk about it (needs-info, discuss, reply): then it stays, and the thread raises unlinked.
- **Answering it.** The thread shows the gate's options as a second answer row, the same labels as a gate
  item, naming the card by its title ("&F12 Badge colour is ready to test. Answer it here too."; `cardTitle` on the gate).
  Only the thread's **own** options carry the ←/→ arrows and the swipe; the gate's row is tap only (no swipes, no arrows), Not good on the left and Done on the right like every swipe surface. `resolve` with `gate: true` answers the **gate**, not the thread:
  it goes through the same path as a gate item (owner only, the card moves first, the same refusals). The thread stays
  open for its own question; the gate leaves it once the card moves on. A `resolve` without `gate: true` is the thread's
  own answer, as ever.
- **It stops counting** when the thread is closed, parked, the card leaves the gate, or the thread sits on the
  **ferret's** turn for more than 24 hours: a ferret cannot mute a gate by opening a thread and leaving it. The daemon
  looks again every Warden sweep and the gate item is raised if no thread stands in for it. **Only the owner's answer
  to a gate option on the thread counts as asked** (recorded as a `gate-answered` history entry naming the gate, "Not
  yet" included); a thread closed any other way — its own answer, Dismiss, Not needed, the ferret withdrawing — while
  the card is still at that gate raises the gate item. A thread past the grace is also listed by the duplicate sweep.
- **A second add is refused.** `fy agenda add --task <card>` by an agent, for a card that is already asking the owner,
  answers `invalid`: `&F12 is already asking the owner (!A3 on <home>'s agenda); add what you need to it instead: fy
task note F12 "<text>"`. An add with no `--task` that would take the focus card while that card is asking is raised
  **without** the card link, and the response carries `notes` (the CLI prints each as `Note: …`). If the card's gate
  cannot be read, the add is not refused and not trusted either: it is raised without the card, with a note saying so.
  Notices are never refused.
- **`--thread` only links.** `fy task create --thread !A12` sets the `task` of the caller's own open thread to the
  new card (refused when that thread is already linked to another card). The card stays as external as any other: its
  gate rides on the thread through attach, and is raised when the thread closes.
- **The duplicate sweep.** At boot and on every Warden sweep the daemon reads every agenda (pure `findDuplicates`) and
  closes only what is provably the same ask. Every rule is scoped to **one lineage** (one home): one card with more than
  one open owner item; one `source` + `sourceRef`; identical normalized titles. It keeps the **oldest** (the first
  ask) unless a newer one is on the owner's turn, and closes the rest with the note `duplicate of !A<n>` — only when
  both were raised by the **same session**, and for identical titles only when the ask and body match too (else it
  reports). It never closes an item the owner has begun to talk about, a hands-on card, or a gate the owner answered,
  and closes nothing while any agenda is unreadable. What it leaves is listed by `fy doctor` ("N possible duplicate
  asks left open"). `GET /v1/health` gives an unauthenticated caller only the **count** (`duplicateAskCount`); the
  list (`duplicateAsks`) is for the privileged loopback path.

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

On the ferret's turn there are three ways out. An item the owner's reply parked (see "Parked items") is off their list:
a plain `edit` updates the card and leaves it parked, only `edit --back` — with the whole card refreshed — brings it
back, and a bare `surface` is refused there. **None of the first two pings the owner.**

- `fy agenda edit <id> …` — change the card (settled answers, what is still open, new options). Any edit by
  the raising agent on its own turn hands the item back to the owner, even one that changes nothing. (Not an item
  the owner replied to: that edit keeps it parked, unless it carries `--back`.)
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
(nudge-once keys on the `[re !A…` opener); after that it stays quiet. The nudge says the item is off the owner's
list: "Owner replied about !A5; it is off their list. Do the work, then `fy agenda done A5`. Use `fy agenda edit A5
--back …` only if you need something NEW from them." It never says it is the ferret's turn to hand the item back.

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
- **It stays off the list until there is something new.** The owner has answered, so the ferret does the work. A
  plain `fy agenda edit <id> …` by the ferret updates the card (the living summary) and **leaves it parked**: no
  `waitingSince` bump, nothing unread, no badge. `fy agenda done <id>` / `dismiss <id>` closes it **without telling
  the owner** (no push, no buzz, no badge change): the CLI prints "A5 closed; the owner is not notified (they had
  already replied)", and the item shows under Resolved as usual.
- **`--back` is the one way back.** When the ferret needs something NEW from the owner it runs
  `fy agenda edit <id> --back --summary "…" --premise "…" --context "…"`, on the owner's turn — **fresh**:
  `waitingSince` is now, so it reads as new and unread. **The whole card is refreshed**: the owner's words changed
  what is going on, so the ask, the premise and the context are all written again (restating one unchanged is
  fine) and the card stays an isolated, self-contained statement of the situation. A `--back` that leaves one out
  is refused (`invalid`, naming the missing flags), and so is a bare `fy agenda surface <id>` of a replied item.
  An answer to the owner's own question (`--question-answer`) counts as new and needs no `--back`. The owner, the
  daemon's timer and a snoozed or never-replied item are unaffected.
- The app lists it under **Replied (n)**; the owner can bring it back themselves ("Back to my list"). The Inbox does not wait for the next board read: a reply sent from an open Inbox item is shown as replied at once, with an Undo (see "In the Inbox").
- Buttons, options and `[answer to !A…]` are unchanged: they still resolve with a response, as `done`.
- **Warden items follow the same rule.** A daemon-raised item the owner replied to parks like any other; it is
  not raised again for the same anomaly while the Warden's "already told" record holds.
- **Discuss is separate.** The owner's explicit Discuss (and a request for more information) still puts the item
  on the ferret's turn and counts as a request.

### Snoozed

The owner can put an open item away ("we are waiting for approval"): **for** a while or **until** a time — 1 hour,
4 hours, tomorrow 9:00 in their own time zone, or a time they pick. In the app it is the clock in the item's head
(never a button in the answer row), and on a phone the Inbox swipe-down compass offers the same four choices (one
list, `snoozePicks`, for both; Custom… asks for the time on a sheet); on the command line `fy agenda snooze <id> --for 4h | --until 17:00`, and
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

## The machine agenda

Some notices belong to no ferret's thread: the Warden could not move a ferret, a card has nobody working on it, a login
hit its budget. They are held on **one daemon-owned board** — the machine agenda — instead of on whichever
ferret's agenda they concern, and the Inbox shows them as their own **Machine** group (a stand-in conversation named
"Machine", with a small machine icon), counted, searchable and notified like any other item. The ledger's id,
`MACHINE_AGENDA_ID` (`machine-agenda`), is owned by `@ferretry/protocol`; the daemon and the app both import it, and
a contract test reads the daemon route's real snapshot with the app's client. A push for a machine item, and a search
hit on one, open the **Inbox** item, never a `/session/<id>` page.

- **Who writes, who answers.** Only the daemon raises (`{kind:'daemon',cause:'system'}`); no ferret can address it
  — the session agenda routes do not accept its id. Only the owner answers, and never with a reply (the board holds
  notices, which are read).
- **Routes.** `GET /v1/machine/agenda` lists; `POST /v1/machine/agenda` takes exactly four owner verbs:
  **dismiss** (the app's Clear), **snooze**, **unsnooze** and **resolve** without a reply. Anything else, or a
  `resolve` that carries a reply, is a 400. Both routes are owner-only (`minimum: 'operator'`, `caller: 'person'`)
  and take no grant — the `clear-agents` rule in [grants.md](grants.md).
- **Visible to search.** Machine items are indexed for `/v1/search` and the `search_work` tool like a session's
  agenda items, so any caller who may search work can read their text. That is the same exposure session items
  already have; it is not an extra privilege, and the owner-only `GET` stays the only route that lists the board.
- **One item per cause.** The same `sourceRef` refreshes in place:
  - `warden:auto-move-failed` — "N ferrets could not be moved", listing each (up to 12, then "…and N more."). A
    ferret that stops, is gone, or moved to another login drops off; the item resolves when the list is empty. A
    stopped ferret is never added.
  - `warden:orphans` — one item naming the cards that have nobody working on them, titled "A card has nobody working on it"
    (or "N cards have nobody working on them"), one plain line per card: "&B1 Fix simcha Loge 502 is waiting in
    Review/CI, but no ferret is assigned, so nothing will happen to it." A card leaves it when someone takes it. The
    nudge to a live owner ferret is unchanged. It is information, so **Got it** dismisses the whole item, and it
    carries `cards` (below): each card gets its own **Open**, **Start a ferret** and **Close**, on one line (a phone's width
    holds the three; a screen reader hears "Open card &B1", "Start a ferret on &B1", "Close card &B1").
    - **`cards`** is a structured field on an `info` item (1 to 12 rows, each `{ task: { id }, line }`, strict; refused
      on any other kind). The daemon sets it only for a machine that reports `agenda.cards.1`; an older app drops the
      unknown field and reads the same lines from the context instead, so nothing is lost. An app that draws `cards`
      hides the context, because it would say every line twice, and a lone card's line is not repeated under its own title.
    - **Open** goes to the card. **Close** asks first (with a reason the owner may edit) and then drops the card with
      the board's own `POST /v1/board/tasks/:taskId` `{action:'drop', reason}`. The button is shown to the person and
      confirms first; the drop underneath keeps the board's existing rules (`caller: any`, the planner ACL), which are
      unchanged, so a card's owner ferret or an ancestor may still drop it as before. **Start a ferret** is
      `POST /v1/board/tasks/:taskId/start` ([board.md](board.md#start-a-ferret-on-a-card)): it starts a NEW ferret on
      the card, and is the person's act only (operator minimum, `fleet` use). Each click carries its own action key
      (kept across a retry when no answer came back), so a lost response cannot start a second ferret.
    - **A card a live ferret already holds** is not offered a start: the daemon answers with that ferret
      (`started: false`); the row swaps **Start a ferret** for **Open its chat**, and its line reads "… — a ferret has
      picked it up." in place of "no ferret is assigned".
    - There is no sentence under the notice telling the owner what the buttons do; the buttons say it.
  - `warden:input-stuck` — one item naming every ferret idle with a message of Ferretry's own typed in its box and
    never submitted, after the Warden's Enter did not submit it (the `input_stuck` flag,
    [message-delivery.md](message-delivery.md#b144-a-ferret-idle-behind-its-own-unsent-message)). A ferret leaves it
    once it takes a turn again; the item resolves when the list is empty.
  - `budget:<login>:<window>` — one per login per budget window. (It used to double because the notice was
    de-duplicated only inside the agenda of the ferret it was anchored to, and the anchor differed.)
- **Waking.** A machine item's member list is kept beside it. An update that **adds** a member to an item the owner
  parked wakes it, as the daemon (never as the owner); one that only shrinks it does not. Once the owner dismisses an
  item, the same members do not raise it again, and the list the item holds is kept current while it is dismissed,
  so a member that leaves and later comes back counts as new and raises it again.
- **Serial.** Each cause's member list (`AutoMoveFailures`, `OrphanList`) and the machine agenda itself run their
  writes one at a time, so a note, a reconcile and the boot folding never overwrite each other. The Warden's sweep
  and the one-minute reconcile start only after the folding has finished.
- **Port.** Other daemon code uses `MachineAgenda`: `raiseOrUpdate(ref, request, members?)`, `resolve(ref, note?)`
  and `list()`. Only notice-type items belong here; gate items and Not-good follow-ups never do. A Warden notice
  about a sub-ferret with no owner home reaches it through `AgendaService` (home rule, step 4).
- **The open view of "could not be moved".** One place lists the ferrets: each with its reason and its action. A
  ferret mid-turn says "Wait for it to finish its turn"; one no login can take says "Wait for a login to reset"
  (the reason names when, if known); one a login can take shows a command that runs, `fy migrate <id> -a <login>`,
  with the login the Warden's own auto-migrate would pick (the most headroom first). The command stays on one line,
  copy button at the right edge. The Why, Context and What-I-need blocks do not repeat the list.
- **Migration.** On first start after this shipped, the daemon folds the old per-ferret notices (`warden-auto-move`,
  `warden-orphan:*`, `budget:*`) into their machine item and closes the originals. It writes
  `machine-agenda-notices-migration.json` only when every agenda was read and every item folded; otherwise it tries
  again next start. The folding is quiet — it raises without a push, so an old notice does not buzz the phone again —
  and it closes, without a machine item, a budget notice whose window has already reset.

## Lane proposals

A ferret that works in a project with no lanes runs `fy board lanes propose --template <t> [--rename old=new]…`.
The daemon stores the set at once (unconfirmed, live) and raises **one** choice on the proposer's agenda,
`Lanes for <project>: A → B → … · Accept / Edit`, with `source: 'task'` and the stable `sourceRef`
`lanes:<projectId>:<version>`, so proposing the same version twice is one card. **Accept** confirms the set
as the owner; **Edit** points at the Board lane editor. A ferret's change to lanes a project already has is NOT
live: it waits beside them as the set's pending proposal, and its card, keyed by the proposal's own version, says
the board keeps its lanes until the owner accepts and what the change would do (lanes removed and where their
cards go, gates that stop waiting). Only a person's Accept takes it live, and only then do its cards move, as the
owner's ([board.md](board.md#a-ferrets-lane-change-waits-for-the-owner)). An owner's edit confirms at once. The routes are `GET /v1/board/projects` and `GET|POST /v1/board/projects/:projectId/lanes`.
If the card cannot be raised the set stays live and the response says `agenda: "failed"`.

## Reserved sourceRefs

Some daemon producers ACT on the owner's answer to their item: a lane proposal's Accept confirms lanes, a gate item's
answer moves a card. So the grammars the daemon writes `sourceRef` in — `lanes:`, `gate:`, `gate-followup:`,
`warden:`, `warden-orphan:`, `handover:`, `budget:`, `prompt:`, `question:` (`DAEMON_SOURCE_REF_PREFIXES` in
`@ferretry/protocol`) — are the daemon's alone, held at both ends:

- **Nothing a ferret writes carries one.** An agenda add names no reference at all (`forbidden` for a ferret and the
  owner alike). A harness question's tool id comes from the ferret's own question file, so its item is namespaced,
  `question:<tool id>` (a provider's id taken as written, a colon included), and an id that is itself in a daemon
  grammar, blank or too long is not raised at all; the daemon log says so, with the id's control characters made
  harmless.
- **Every consumer checks the producer, not just the reference.** A lane proposal's Accept counts only on the daemon's
  own `task`-source card (`acceptedProposal`); a gate item is the `task` source with its `gate`, and its follow-up
  the daemon's `task` source too — so a question naming either moves no card, routes no words to a ferret, and, raised
  and closed first, suppresses no real item. The harness settles only its own `question:` and `prompt:` items (and a
  question raised before the namespace that carries no other producer's mark): an input or secret card, a phone
  approval, a 2FA seed, a login recipe or a task plan — all `question` items too — is never closed by a console
  prompt coming and going.

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

| Verb                    | Does                                                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add`                   | Open an agenda (the owner's turn). `--title` and the ask are required. Lists the open ones first and opens only with `--new "<why none fits>"` when there are some ([One channel per topic](#one-channel-per-topic)). |
| `add --offer-close`     | With `--task`: the owner may close the card with the same tap that resolves it.                                                                                                                                       |
| `add --task <card>`     | Refused for an agent when the card is already asking the owner ([One ask per thing](#one-ask-per-thing)).                                                                                                             |
| `edit <id>`             | Reword; on the ferret's turn hands it to the owner. A replied item stays parked.                                                                                                                                      |
| `edit <id> --back`      | Needs something NEW from the owner: bring a replied item back, whole card refreshed.                                                                                                                                  |
| `surface <id>`          | Hand it back to the owner, unchanged (silent). Refused for a replied item.                                                                                                                                            |
| `snooze <id>`           | The owner's: put it away `--for 4h` or `--until 17:00`; it comes back fresh.                                                                                                                                          |
| `unsnooze <id>`         | The owner's: bring a snoozed or replied item back to the list now.                                                                                                                                                    |
| `done <id>`             | Resolve, optionally answering its ask (`--choice`, `--yes`, `--other`…). Quiet on a replied item.                                                                                                                     |
| `dismiss <id>`          | Close without answering; agents only their own. Quiet on a replied item.                                                                                                                                              |
| `ls` / `show`           | Open items with turn and blocking fields / one item in full.                                                                                                                                                          |
| `needs-info`, `discuss` | The owner's side, kept for old clients. They make it the ferret's turn.                                                                                                                                               |

`edit` and `surface` take `--now` when it is urgent: it wakes an item the owner snoozed, once an hour per item.

**Sub-ferrets raise nothing.** A session another ferret started (`config.parent`) is refused `add`, `edit`,
`surface`, `done` and `dismiss` (and `fy notify`, the same owner-facing channel) with `forbidden`: `You are a sub-ferret, so you can't
raise agenda items or notify the owner. You may read the agenda and report to your lead. For anything else ask your lead: fy send <lead-callsign> "…"`. They report to the lead with
`fy send`; the lead decides what the owner must see. `AgendaService.apply` is the one choke point; reads stay open.
Their prompt carries no Agenda mode section even when the switch is on
([pack-mode.md](pack-mode.md#sub-ferret-limits)).

### The agenda home

Only the owner's own ferret's agenda asks the owner. The **home** of a session (`AgendaHomes`,
`packages/daemon/src/lib/agenda/home.ts`) is where the daemon raises on its behalf:

1. Walk `config.parent` up to the root. The walk is **rooted** only if it ends at a session with no parent. A parent
   that cannot be read, a loop and a chain past the depth bound leave it **broken**: a broken lineage is never an
   owner's root.
2. A rooted lineage whose root the owner started (`provenance.origin` `human`, or no stamp) has that root as home.
3. Otherwise (a Warden's or another session's orphan, or a broken lineage) the home is the owner's most recently
   active interactive session on the same project: mode `interactive`, no parent, owner-started, same `projectId`.
   Recency is the session's `config.updatedAt`.
4. Otherwise, for a NOTICE only, the machine-wide agenda (the `MachineAgendaHome` port). A Warden escalation or a
   daemon item raised with `notice: true` lands there as a machine item scoped to the ferret it is about
   (`<sourceRef>:<sessionId>`, so two ferrets are two items, never an overwrite) and is resolved there when the
   Warden clears it. A gate item or a follow-up never goes there: it takes step 5.
5. Otherwise the root, if the lineage is rooted; for a broken one, the session itself, with a warning naming where
   the chain broke.

`AgendaService.raise` and `resolveSource` apply it to a daemon actor on a sub-ferret, so a gate item, a Not good
follow-up and a Warden escalation or notice land on the home. A redirected Warden item's title starts with the
sub-ferret's callsign (`<callsign>: <title>`) so the owner can tell which ferret it is about. The mutation's
snapshot `sessionId` says where it landed, and the agenda-delivered count pairs that session with the item.

**A Warden notification about a sub-ferret names it.** On the home its `sourceRef` is
`warden:ask:<kind>:<sessionId>`, so the home's own `warden:ask:<kind>` and each sibling's are separate rows, and
one recovering clears only its own. The Warden plan reads each ferret's home (`homeOf`) and looks for the row there:
a standing escalation is never cleared as "recovered" for sitting on a board that is not the ferret's, and a row
about a ferret whose own board could not be read is neither judged nor cleared.

**Hands-on cards stay on the sub-ferret** because only that session can consume the answer: a request with `input`,
`phoneApproval`, `copyPlan`, `taskPlan`, `signInRuleSuggestion`, `signInRuleSuspended` (on an existing item), `twoFactorSeed` or `confirms`, and any raise with
the cause `harness-prompt`, `input-request`, `phone-approval`, `secure-copy` or `login-recipe`. A password, a code or an
approval the daemon asks for is the only thing that reaches the owner from a sub-ferret.

**One-time migration.** At boot, once (`agenda-homes-migration.json` in the daemon's home; written only when every
session was read and every item moved, so an unfinished start tries again), each open item that the **daemon** raised, and that is not hands-on, on a
session with a parent is raised on its home carrying its waiting time, snooze, conversation and history (`carried`, a
daemon-only field: an agent can never set it) and resolved where it was with "moved to !A<n> on <home callsign>'s
agenda". Gate items keep their `gate` and `sourceRef`, so duplicates collapse by the one-item-per-gate rule; other
items get the sub-ferret's callsign in front of the title, and a Warden notification is renamed to the scoped form
above. An item a ferret or the owner raised stays where it is (the daemon may not close it, and a copy would be
the daemon's, which the owner could not discuss); the ferret closes its own with `fy tidy`. A resolve that fails
after a move is logged with the session and the item and holds the marker back; an item the home refuses for good
(`forbidden`, `invalid`, `too-long`) is logged, stays, and does not. The boot log says how many moved.

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

The card is read cold, so it must stand alone: a title of about 40 characters, an ask that is a short
title-like line (about 80 characters at most, `AGENDA_ASK_TARGET_LENGTH`; the detail goes in `--body`), the premise, context and what is decided or still open as short bullets, every term of art
defined with `--term`, never a secret value. The daemon lints for this and answers with advice, never a
refusal — with one exception below. Agents close their own items as soon as the reason is gone: an open item
whose blocker has cleared is a bug.

**Every segment is short points, never a paragraph.** The premise, context, decided, still-open, question
answer, body, option details, ask, revision notes and terms all read as the same Markdown on the card: bullets
(`-` or `•`), numbered lists, **bold**, `code`, references, and a single line break kept as a line
(`segmentMarkdown` in the app owns that, so no segment flattens its lines, and a label line directly above a list that starts at 4 still reads as a label and a list). Writing follows: answer first, one
idea per line. `fy agenda add` and `agenda edit` warn, never block, when a segment is a single paragraph over
280 characters (`AGENDA_SEGMENT_PARAGRAPH_LENGTH` in `@ferretry/protocol`), saying to split it into short points
or bold the answer first. Lists, tables, headings and fenced code are not counted as paragraphs.

**No Markdown headings in the ask or a segment.** A `#` heading draws as a huge title inside a card (the "What I need from you" card read as one wall of H1s), so the ask and every segment — premise, context, decided, still-open, question answer, impact, recommendation and option details — are short points or a bold lead, never `# …` to `###### …`. `fy agenda add` and `agenda edit` warn, never block, when the ask is over about 80 characters (saying to move the detail to `--body` or `--context`) and when the ask or any of those segments holds a heading line (outside fenced code; `#812` is a reference, not a heading). `--body` is left alone: it is where longer instructions go.

**A bunch of bugs or asks heard at once is not a pile of new items.** When the owner reports several bugs, or asks several things in one message, an interactive (Agenda-mode) ferret adds each to the agenda it belongs with, by the three-part test ([One channel per topic](#one-channel-per-topic)), and opens a new one only for what fits none. The prompt says it in one line — "Bug batch: ONE agenda, line each + where tracked." — a line per bug and where each is tracked. Sub-ferrets do not (Agenda mode is left out of their prompt) and report to their lead instead. The rule follows from the test the Agenda-mode instruction teaches (`AGENDA_INSTRUCTION`).

**A segment never draws a heading.** A Markdown heading (`#` … `######`) a ferret writes inside any segment is drawn
as bold text at the segment's own size, never an h1–h6: the card's own labels (Premise, Context, **What I need from
you**) are its only headings. Chat messages keep their headings; only agenda segments demote them
(`demoteHeadings` on `Markdown`, set once by `AgendaProse`).

**A card's title is one line, and never ends mid-word.** The open card's head stays ONE row: a title too wide for it
scrolls to its end and back (the marquee), as before. Where motion is reduced it does not move: it ends at the last
whole WORD that fits, then "…" (`wordCut`, drawn in `data-cut`; the whole title stays in the DOM for a screen reader
and a tap shows all of it). Only a gate item or a machine notice folds onto two lines. A card's who/where line
("ferret · task · card · machine") puts a dot only between parts that have words (`joinMeta`): a missing part leaves no
leading, trailing or doubled dot.

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

## The kind chip

Every card wears one chip that says what the OWNER does with it, in plain words. The words live in ONE place —
`AGENDA_KIND_LABELS` in `@ferretry/protocol` (`agenda-card.ts`, with `agendaKindLabel(item)` to read it) — and the
app's card pill, the Inbox chip, the card header and the row's meta line all read it; the app keeps only the tone.

| Kind (`--kind`)   | Chip     | The owner…                                      |
| ----------------- | -------- | ----------------------------------------------- |
| `reply`           | Question | answers in words                                |
| `choice`, `yesno` | Decision | picks an option                                 |
| `task`            | To do    | does the steps (with steps or without)          |
| `permission`      | Approve  | says yes or no to a request                     |
| `info`, a notice  | FYI      | reads it and says Got it                        |
| `review`          | Review   | reads the work and approves or asks for changes |
| `form`            | Fill in  | fills in the card's fields                      |
| `input`           | Type in  | types in what the card asks for                 |

A **gate item** waiting for the owner to try the work wears **Test** (`TEST_KIND_LABEL`), and a plan waiting for a
go-ahead wears **Approve**, whatever kind the item was raised with. Peer-message kinds are another thing and keep their own words.

## What I need from you

**Every card has one answer shape, and it says it in one place.** Under the premise and the context, before any
optional section, every open card draws a segment headed **What I need from you**. It holds exactly the ask and
ends with one plain instruction, so the owner always knows what to do. The ask itself is a short **bold line at body size** — never heading-sized, however long it is; a long ask wraps
and the card stays the card:

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
- **No swipes** except ↓ Skip. Recommended values start picked and carry a "Recommended" tag; what is picked is the
  filled row (or the filled Yes/No half, with a check), so a recommendation never reads as a pick.
- **What is left is said.** A required field with nothing picked says "Needs an answer", and a foot pinned to the bottom
  of the open item counts the fields answered on the card ("2 of 3 answered") above how to send, so neither hides under
  the composer. Once the answer has gone, the Inbox's undo toast and the chat's "Sent to …" line name what was picked
  ("Region: US · Alerts: Page, Mail").
- **In the chat** the item's view is the Inbox's: the same fields, the same picks (one key per item, so a pick made in
  one place is there in the other), and the chat's reply box is the form's one Send. The view stays open until the
  answer lands, so a refusal is read on the card. Only a form nothing can answer from here (settled, or a chat without
  an agenda client) is drawn read-only, with "Open this in the Inbox to fill it in, or answer in the reply box, numbered."
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
- **Each card has its own draft.** The composer under an item is **not** the chat's composer: its unsent text is a
  synced draft of its own, keyed by machine + conversation + **slot** — the slot is `chat` (the chat box, exactly
  today's draft) or the item's id (`A5`). Typing in a card never shows in the ferret's chat, typing in the chat never
  shows in a card, and two cards of one ferret hold two drafts, each in step across the owner's devices (route
  `…/shared-draft?item=A5`, advertised as the daemon feature `shared-draft.slots.1`; a daemon without it gives the
  card a local-only draft, never the chat's). Sending from a card empties **that card's** draft only, and the quick
  replies take their note from it. When an item closes (any `addressed` change) its draft is deleted; a replied
  (parked) item keeps what is still typed. A conversation holds at most 100 item drafts.

- **A reply moves the Inbox on at once.** When a message typed in an open item's composer is accepted by the machine
  (the send resolved: queued, delivered or revived), the item is marked **replied here, at once** — an overlay on what
  the boards say (`lib/agenda-replied.ts`), the same fact the daemon records as `parked: { reason: 'replied' }` a board
  read later. It leaves Stopped on you, Needs you, Answer quickly and the badge, appears under Replied, and the deck
  deals the next card (past the last one, the end card). A failed send changes nothing: the card stays and the box keeps
  its words and shows the error. A form item's Send is an answer, not a reply, and a notice is not parked by a reply, so
  neither moves. The chat's own composer keeps today's behaviour: the daemon parks the item, with no toast.
  - **The overlay never outlives the boards.** It drops when a board read shows the item parked or gone, or open under a
    new ask (`waitingSince` moved: the ferret brought it back — its new ask wins), and at the latest after 30 s.
  - **Toast: "Moved to Replied · Undo"**, the answer toast's look and five-second window; a polite status
    (`role="status"`) for screen readers. It sits in its own row **between the open
    card and the composer** (on a phone and on a wide screen alike), so it never covers the input, the send button or the
    keys hint; where no composer row is drawn (the end of the run, a to-test step) it floats at the bottom as the answer
    toast does.
  - **Undo** brings the card back at once (the owner `unsnooze`, "Back to my list"), opens it, and puts the words back
    in **that card's** composer — once, and only when the ferret has not read the message: the message is taken out of
    the session queue by the route the chat uses to cancel a waiting message (`DELETE /v1/sessions/:id/queue/:messageId`;
    a message still on this device is cancelled in the outbox). If the ferret already took it (the transport delivered
    it at once, or the queue answers 409/404) Undo only brings the card back and says so: "Back on your list — Zoe
    already read your reply." (words are never duplicated). If the queue cannot be reached the card still comes back
    and the toast says the reply may still reach the ferret. The words are put back before the card is asked back, so a
    failed unsnooze loses nothing.
  - **Keys and focus.** The wide-screen run keys keep working after an advance. When focus was in the composer that went,
    it lands on the next card's frame — never on a removed node; reduced motion drops the fly-off as everywhere.
- **The open items are a deck**, on a phone and a wide screen alike. Swipe with a finger — from the item's head or its
  who-and-what line; the body scrolls — or press the arrow keys. **Only touch swipes, on every screen size** (decided by
  the gesture's `pointerType`, never by width): a mouse or trackpad drag never swipes or pulls down anywhere — Inbox
  cards, Answer quickly, the side-panel cards — and stays the reader selecting text; a mouse uses the buttons and keys:
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

- **A machine whose boards could not be read says so on its own line, and why** — "Couldn't read 3 items on Liftoff
  EC2 — the machine hit an error. Trying again." The reason is the last failed read's: `the machine hit an error` (a
  5xx), `the machine is busy` (429), `refused` (401/403), `not found` (404), `unexpected answer` (another 4xx, or a board the app cannot read),
  `timed out` or `no answer`. Boards on one machine that failed differently list each reason, the one covering the
  most items first. A read that only ended (the machine was paired again meanwhile) adds none.

### The roll-up: every conversation, and a count that is the list

The Inbox lists **Open, Snoozed and Replied for every conversation**, not the most recent ones, and a count it shows
(each filter's badge and the page's header) is **the length of the rows listed under it** — the rows the machine,
Ferrets and Find filters keep, never a total taken before they applied.

- **`GET /v1/agenda/open`** (`agenda.open.1` in `GET /v1/health` features) answers every session's open AND parked
  (snoozed, replied) items on the machine: `{ sessions: [{ sessionId, items }], next? }`, in session-id order, paged
  with `?after=<next>&limit=` (default 200 items, at most 500; a conversation is never split across pages and one with
  nothing on its board is left out). It is read from the boards the agenda service already holds — no new store.
- **Who may read it**: the same grants as one conversation's board (`operator`, no capability, gated by who asks —
  [grants.md](grants.md)) with one narrowing: `caller: 'person'`. A board read names one session; this names every
  session and item on the machine, which a ferret has no use for, so a ferret credential gets 403. `noStore`, as a board is.
- **The app ships first**: the Inbox asks a machine for the roll-up only once its health lists `agenda.open.1`. It reads
  every page on mount and when the owner opens Snoozed, Replied or Resolved, and keeps the last good read if a later one
  fails. A board this device already holds is newer than the roll-up and wins for its conversation. An older machine
  keeps the window it had — the 30 most recent conversations — and the list says so ("From your 30 most recent
  conversations"); the caveat is shown only while some machine is not read to the end. Resolved stays windowed to those
  30 conversations on every machine, and its footer says so.
- **Rows name the owner's thread.** A sub-ferret is named for a piece of work ("Revive Button Flaky") or a callsign
  ("Vena"); the owner talks to the thread that started it. Every Inbox row — an agenda item, a parked item, a resolved
  record and a card to test — names the **root of the conversation's lineage**, found client-side by walking
  `SessionConfig.parent` through the session list the app already holds (a parent that is gone ends the walk at the
  topmost session that is held; a loop ends where it repeats). Find also matches the sub-ferret's own words.

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

A **gate item** is a board card waiting on the owner at a gate, raised as an ordinary Inbox item (never for a sub-card: the owner tests its parent, and a sub-card [closes itself](board.md#sub-cards-close-themselves) instead of waiting in a verify lane) (`item.gate`: the card, its lane and what each option does):
the owner meets one stream, not a question list and a separate to-test list. It is
the card's ONE head row (the title, ‹ n/N ›, ⓘ, the snooze clock, ✕ — `CardHead`) under ONE quiet meta line: **what it is** — the **Test** chip
(a card in a verify lane; its ask reads "Try it: …") or the **Approve** chip (a plan awaiting approval; its ask reads "OK to build?") — the project, the ferret and "Open chat ›". It repeats
nothing: no summary line, no chip, no restated ask. Its body is the card's _How to test_ as numbered tick-steps, and its
options are the gate's own, laid out as every choice is (the first ←, the second ↑, the third →) and then MIRRORED left/right for a gate, so the forward option is always on the right.

- **→** is the forward option (Done, OK to build, Yes), the same as the side panel's Cards view and the to-test rows; **←** is **Not good**, which reopens the card with an agenda item; **↓** is Skip. The buttons read Not good (left) · Done (right).
- **Not good needs words.** Pressing it (or ←) answers nothing yet: the "why" box opens where the answer row was, and
  Send back stays disabled until something is written. The words go as the answer's note. Cancel (or Esc) changes nothing.
  The box is the chat's own composer — the same field, mic, Enter to send and Shift+Enter for a new line — with the same
  inset as the card above it, so it is exactly as wide. It is the one send-back box ([board.md](board.md#done-and-not-good)).
- On a **one-option gate** the left answer is **Not yet** — not one of `gate.options`: the card stays where it is, and words
  are welcome but not required.
- Answering is a plain choice, `{ kind: 'multiple-choice', choice: <label> }`, held in the undo window like any answer. A
  refusal (the card moved on, or the gate was not reached) shows beside the buttons, as for every answer.
- **Question items keep their sticky options and composer exactly as they were.**

**The app ships before the daemon.** A machine that advertises `board.gate-items.1` on its health sends gate items, and the
Inbox then drops the _synthesized_ to-test rows those items replace. A machine that does not keeps today's rows. A person-asked
card in a gate lane **with no open gate item** keeps its to-test row even on a machine that advertises gates, so no card
waiting on the owner is ever lost between the two lists.

**Not good takes pictures and files.** The resolve request carries optional `attachments: { from, ids }` — the same shape as
the board's move back (`docs/board.md`) — and only on the answer to a gate item. The app uploads each file to the **item's own
session** (`from` is that session; the daemon refuses any other), then names the ids with the answer. The daemon carries
them to the card's ferret (its assignee, else its owner ferret) **before the board is touched**, so a file that cannot be
carried leaves the card where it is and the item open, saying so; it then reopens the card with `{ from: <that ferret>, ids }`,
and the ferret reads them as it does on the Board. Only a Not good takes files: "Not yet" and the forward option are
refused with them, and the Inbox draws no "+" on "Not yet". A resolve with files on anything that is not a gate item is
refused `400 invalid` rather than dropping them. Repeating an answer the owner already gave (a lost response replayed, or the same request twice at once) answers success with the item unchanged and the card moved and the ferret told **once**, but only when the repeat is the SAME answer: the same choice, the same words (spacing aside) and the same files (`from` and ids). The same choice with other words or other files is a stale tab, refused `409 gate_moved_on` ("was already answered, differently: nothing was sent") rather than a success that drops them, and a repeat is still held to a first answer's rules (the owner, the grant, words for a Not good, files from this session). The full answer is kept with the answered item, so an exact repeat succeeds even after a restart. A repeat from anyone else is not a replay. A daemon reports `agenda.gate.attachments.1` on `GET /v1/health` when it
takes them; the app draws the "+" only there, and an older machine keeps Not good as words alone.

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

### One bad entry

A ledger is read **entry by entry**. One entry that does not read as an item no longer makes the whole board
unreadable (that answered every board read with a 500, and the Inbox could only say "Couldn't read" for every item on
it):

- **It is set aside, never dropped.** The other items read as usual; the bad entry is written back exactly as it was
  read on every later write, and it is counted as the snapshot's `parseErrors`. The CLI, the chat's agenda and the
  Warden already say a board has unreadable entries when that count is above zero.
- **It still counts as what it was.** Its id is never reused, and an id another item holds refuses the board. It
  holds its place under the caps (open items, a ferret's open items, and the closed history, which is pruned short by
  as many). A raise does not go beside it: an open one keeps its `sourceRef`, and a gate's closed one keeps its
  "raised once". So the board stays one that reads whole should the entry read again.
- **Only the Warden's own words are fitted.** An item the Warden raised whose only fault is text past a limit reads
  with that text cut at a word to the limit, its line breaks kept, and the next write keeps the cut. Every other item
  is left as written, the daemon's other items included, since those can quote a person or a ferret (an input card's
  prompt, a gate's card title): such an item is set aside as above.
- **What is written reads back.** Every item a change makes or changes is checked against the schema the reader uses,
  and a change that would not read back is refused (`invalid`) instead of written. The Warden's notices fit their
  subject to the limit themselves, and carry the whole of it in their reason; one the agenda still refuses is
  journaled as `fleet.warden_notice_refused`, never lost silently.

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
