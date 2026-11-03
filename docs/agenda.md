# Agenda

The agenda is what the owner has to decide or do, and what each item blocks. It replaces "Attention"
as the name of the feature (`fy attention …` still works, deprecated). A plain notification with
nothing to decide is a **notice**, not an agenda item (see [Notices](#notices)).

**An agenda is one channel of the owner's attention** ([One channel per topic](#one-channel-per-topic)): a ferret
opens one only for what the owner alone can give — information, a decision or an action — and only when no open
agenda passes the three-part test; otherwise it adds to the closest. It never opens one just to track or check its
own work: no "please test X", "please verify Y" or "try it after the release". Testing a card is the board's job
today: a finished card reaches its Released or Ready to try lane, its agenda asks the owner, and they press **Done** or **Not good**
([board.md](board.md)). The ferret's instruction says all of this (`AGENDA_INSTRUCTION`,
[notifications.md](notifications.md#agenda-mode)).

**A question the owner asks is answered on the agenda too.** The owner reads the agenda, not every reply, so an answer
given only in chat can be missed. When the owner asks a question ABOUT an open item ("[re !A163 …] what is X?"), the
ferret answers ON that item: `fy agenda answer !A163 "<text>"` brings it back to the owner's list, in its old place, with an "Answer to your
question" block above its own options, which stay visible and answerable. **A question item keeps its own answer shape
until the ferret closes it with `done`**: the owner's answer rests it, waiting on the ferret ([States](#states)), and
never closes it. The owner's reply never turns
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
  expected. `agenda answer` (or `edit --question-answer`) brings it back; `agenda rest --why` takes it on quietly:
  [States](#states).
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
  replied to is brought back by the same edit with `--question-answer '<the new ask>' --summary '<the new ask>'`, the old subject kept as a
  still-open line. A **structured ask** (options, an approval, a form, questions, steps, a body, `--blocking`,
  `--will-block`, `--by`, links, terms, an answer of its own such as `--up`, its own `--why` or `--resolve`, a different card, `--offer-close` onto an agenda that does not already offer the Done button) is never squeezed in:
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
only derives from the agenda: the open agendas that carry it are its asks, and while one carries its open
[card ask](#card-asks) the card is never stale — nothing is written to the card. A card never shows "waiting on
you": its ask is on the agenda. A notice is context, never an ask.

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
  the lane `release.published` enters ("Released"), the one notion the board's lane facts already use. A
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

## Card asks

**Cards show progress; their asks ride the card's agenda.** A card never asks the owner itself. When a card the owner
asked for reaches a stage that needs them — a plan to approve (**OK to build**) or a release to try (**Done / Not
good**) — the daemon puts a **card ask** on the agenda that carries the card, and the owner answers it there
([board.md](board.md#cards-show-progress-their-asks-ride-the-agenda) owns the rules: which agenda, who passes, what
each answer does to the card).

- **`cardAsks`** (`AgendaCardAskSchema`, oldest first, at most 16): each one carries its `gate` (`cardId`, `laneId`,
  `laneName`, `entry` — the card history's `seq` that put it there —, `projectId`, `projectName?`, `cardTitle?`, and
  the lane's `options`: `id`, `label`, `outcome` of `next`, `lane`, `reopen-with-agenda` or `close`), `at` (when it
  was put on this agenda), the card's **How to test** (`howToTest`, Markdown as written), and once answered its
  `answer` (`at`, `response`, `note?`, `receipt` — a SHA-256 of everything the answer said —, `askVersion?`). A "Not
  yet" leaves it open with `notYet`. Only the daemon writes one; an add or edit that carries one is refused. Its name is
  its gate's reference, `gate:<card>:<lane>:<entry>`.
- **Which agenda.** The open agenda that carries the card (it is about the card, or carries one of its asks), else the
  one that carries its parent card, else ONE new agenda the daemon opens on the card's ferret's home, named after the
  card, raised on that ferret's behalf (`sourceRef` `card-agenda:<card>`), stage `test` or `plan`. That agenda's own ask
  is only a reply; the ferret works and closes it as its own.
- **It needs you.** A new card ask puts its agenda in Needs you, fresh — even out of a snooze, because it is a blocker
  of its card — and it stays one entry in the unique queue, blockers first. Its stage moves to `test` (its gate can send
  the card back with words) or `plan`. While it is open, its ferret cannot rest the agenda, and nobody but the owner
  closes it: their bare done is refused (answer the ask, or Not needed).
- **Swipes and labels.** → the first option that moves the card on (Done), ← the reopen-with-agenda option (Not good),
  ↑ a third (the owner's decision !A205). A gate with one option gets a second answer, **Not yet**: the card stays, and
  the ask stays open (`gateAskOptions`, `gateAnswers`, `gateChoice` in `@ferretry/protocol`).
- **Answering** is `resolve` with `{kind: 'multiple-choice', choice: <label>}`, `cardAsk: <its gate reference>` and
  the owner's words as `note`; Not good needs words (the note, or `{kind: 'other', answer}`) and may carry files. The
  card moves FIRST; a refusal leaves the ask open (`400 invalid`, `403 forbidden`, `409 gate_moved_on`,
  `409 gate_not_moved`). An exact repeat comes back unchanged and moves nothing; the same choice with other words or
  files is refused. **After the answer the agenda RESTS, waiting on its ferret**, which is told; the answer never closes
  it, and the ferret marks it done once nothing more is expected.
- **Who.** The owner at the machine, or a paired device the `fleet` grant lets use the board (the same grant guards
  Not needed on an agenda with an open card ask). A ferret, its lead and the daemon's other producers are refused.
- **Leaving.** A card that leaves the gate some other way has its open ask withdrawn quietly. When no open ask
  still waits on the owner (the last one went, or only ones they said Not yet to are left), the agenda stops being a
  blocker: it rests waiting on its ferret, or, if it is the daemon-opened card agenda (`card-agenda:`) and holds no
  conversation, it closes. **One rule decides whether the daemon may move a thread when it withdraws an ask: only a
  thread exactly as the daemon left it.** The daemon seals the thread (`cardAsksSeal`): a digest of everything on it
  but the card asks and their mirror and the Warden's nudge clock (`resting.nudgedAt`, `nudges`, `nudgeSend`: a nudge
  of a rest nobody touched does not make it a different thread), taken of the thread **as it is stored** (after the
  history is cut to its bound, with the seal's own room counted, so a thread with a full history still matches). Anything else written on the thread afterwards — the owner's reply,
  answer, Needs info or snooze, the ferret's edit (its revision), hand-back, rest or new question, and the daemon's own
  other lines — makes the digest differ. The seal is renewed only by a card-ask write (put an ask on, restate it,
  answer it, Not yet, withdraw another) that finds the thread still matching it. **A thread that no longer matches is
  never sealed again by a restate, a second ask, an answer or a Not yet**: the mismatch lasts for as long as asks are
  on it. The one fresh seal is for the FIRST ask put on a thread that has no open ask, which starts a turn of its own
  (the ask remembers the turn it woke the thread out of, `woke`; a second ask joining it keeps that turn).
  When the last ask that waits on the owner goes from a thread that matches, it rests, as any answer rests it, if the
  owner answered or said Not yet to ANY ask on it since the withdrawn one was put on — in whichever order the answer
  and the withdrawal came — and otherwise goes back to the turn the ask woke it out of (the owner's, with the question
  it had, or the park, rest or wait it was in). A thread that does not match stays as it is, in Needs you — the
  daemon-opened card agenda too, once it is sealed (an owner's reply already rested it; a ferret's answer is in front
  of them): a
  leftover question the owner can read costs nothing, a ferret's answer hidden behind a "waiting on ferret" costs the
  answer. A thread from before the seal (none is stored) is never moved, and the daemon-opened card agenda from before
  it keeps the older rule (a conversation line, or an owner's answer on it, is talk, and it rests). The stage the ask moved the
  agenda to is not undone: the stage is a log of what changed.
- **It buzzes once**, when the ask is put on. An agenda is left out of a stop's push only while its sole open items are
  card asks; a question the ferret asks on the same agenda is counted ([notifications.md](notifications.md)).
- **Not needed.** The owner's Not needed on the card's own agenda (`card-agenda:`, or a converted gate item) means they
  have seen the ask and want it left: it counts as asked. On any other thread that carries the ask it means "drop this
  thread", so the ask is put on the next carrier, or on a new card agenda.
- **An older app** reads `gateAttached`: the daemon mirrors the FIRST open card ask's gate there on every write, so an
  app that predates card asks still draws Done / Not good on the agenda, and answers it with `gate: true` and no
  `cardAsk`. Such an answer is to the ask the mirror shows. The app sends `cardAsk` from this version on, naming the ask it
  drew; one that does not is guarded by the daemon: while an ask on that agenda was answered with the same receipt (the
  choice, words and files) in the last two minutes, a no-`cardAsk` answer is never applied to another ask, whenever
  that ask was put on — it is refused `409 gate_moved_on`. The same goes for any no-`cardAsk` answer in the two minutes
  after the shown ask took another one's place or went (answered or withdrawn elsewhere; the item's
  `gateAttachedChangedAt`, kept when a new ask appears after it, never set on an agenda that was never mirrored): the
  screen that sent it may still draw the first. The refusal says to
  answer again in two minutes. When several asks were answered in that time, the repeat is read against the one whose
  receipt it matches, else the latest. With no ask left to show, an exact repeat of that answer
  comes back unchanged, on an open or a closed agenda, so a retry after a lost response succeeds. A
  daemon that puts card asks lists `agenda.card-asks.1` on `GET /v1/health`; an older one raised standalone gate items
  (`gate`, deprecated), which no daemon raises any more.
- **The migration** is read-time, total and idempotent, like the channel's: a thread's bare `gateAttached` becomes its
  open card ask (a "Not yet" in its history becomes `notYet`); an open gate item whose card has an open thread here puts
  its ask on that thread and closes, its note naming the thread (the thread takes the gate item's place in Needs you if
  only the gate item was there); a gate item whose card ask cannot be read stays as it is, and a plain answer to it is
  refused (it would close the item without moving the card); any other open gate item BECOMES its card's agenda in place — the same id, history,
  snooze and turn — its gate now its card ask, raised on its ferret's behalf. Closed items stay as they were, so an
  answered gate keeps its receipt and a replay still finds it. A thread carries asks only when the engine would let it
  (`canCarryCardAsk`, one predicate for both: not an input, confirm, plan, 2FA, phone-approval or sign-in item).

  **GAP: one ledger.** The migration folds a gate item and a thread only inside one home's ledger. A card that changed
  hands can keep two agendas, the converted gate item and a thread on another home, until one is closed.

## One ask per thing

The owner is asked about one thing **once**:

- **One agenda carries a card's ask.** The daemon puts it on the agenda that already carries the card rather than
  opening another (above), and a second open copy of the same ask is withdrawn.
- **A second add is refused.** `fy agenda add --task <card>` by an agent, for a card whose ask is open, answers
  `invalid`, pointing to the agenda that carries the card: on the agent's own agenda `&F12 already asks the owner on !A3,
which carries the card; put yours on it: fy agenda edit A3 --where "<each existing point>" --where "<what you need>" (--where replaces them all, so repeat the ones already there)`, else naming that agenda and
  `fy task note F12 "<text>"`. An add with no `--task` that would take the focus card while that card is asking is
  raised **without** the card link, and the response carries `notes` (the CLI prints each as `Note: …`). If the card's
  ask cannot be read, the add is raised without the card, with a note saying so. Notices are never refused.
- **`--thread` only links.** `fy task create --thread !A12` sets the `task` of the caller's own open thread to the
  new card (refused when that thread is already linked to another card): that thread then carries the card's asks.
- **The duplicate sweep.** At boot and on every Warden sweep the daemon reads every agenda (pure `findDuplicates`) and
  closes only what is provably the same ask. Every rule is scoped to **one lineage** (one home): one card with more than
  one open owner item; one `source` + `sourceRef`; identical normalized titles. It keeps the **oldest** (the first
  ask) unless a newer one is on the owner's turn, and closes the rest with the note `duplicate of !A<n>` — only when
  both were raised by the **same session**, and for identical titles only when the ask and body match too (else it
  reports). It never closes an item the owner has begun to talk about, a hands-on card, a gate the owner answered, or
  an agenda that carries a card ask, and closes nothing while any agenda is unreadable. What it leaves is listed by
  `fy doctor` ("N possible duplicate asks left open"). `GET /v1/health` gives an unauthenticated caller only the
  **count** (`duplicateAskCount`); the list (`duplicateAsks`) is for the privileged loopback path.

## States

**An agenda item is a channel: the owner and its ferret talk on it until the ferret says it is done.** Its STATE is
who it waits on, derived by one function (`agendaState`, `packages/protocol/src/lib/agenda-state.ts`) from the
fields every item already carries, so an item from any daemon reads as exactly one:

| State         | When                                                                                     | Notifies? |
| ------------- | ---------------------------------------------------------------------------------------- | --------- |
| **Needs you** | A new ask, or the ferret answered on it. It is in the Needs-you queue.                   | Yes       |
| **Resting**   | It waits on work. Sub-state **waiting on the ferret** or **working** (below).            | Never     |
| **Snoozed**   | The owner put it away until a time ([Snoozed](#snoozed)).                                | Never     |
| **Done**      | Closed, by the ferret's `done` or the owner's explicit done or dismiss. Notices read so. | —         |

**The rules (the owner's decisions on !A304):**

- **Any reply or answer from the owner RESTS the item, waiting on the ferret.** A chat message naming it
  (`[re !A5 …]`), an answer to its ask (a choice, Approve, a typed answer, a form) and a request for more
  information all do. **An answer never closes an item**: it is kept on the open item (`ownerAnswer`) and
  delivered to the ferret as `[answer to !A5 …]`, and the item leaves the owner's queue.
- **The ferret's answer brings it back to Needs you, in its OLD place.** `fy agenda answer A5 "<text>"` (the same
  request as `fy agenda edit A5 --question-answer "<text>"`) shows the answer above the item's ask and puts it back
  where it stood in the queue: the item's `waitingSince`, which is when it last STARTED needing the owner
  (`agendaNeedsYouSince`), is left as it was.
- **A genuinely new ask re-enters fresh** (`waitingSince` is now): a replaced ask ([Editable asks](#editable-asks)),
  or the ferret's answer after it took the item on as `working`.
- **`fy agenda rest A5 --why "<what I'm doing>"`** takes an item on without asking anything yet: Resting, sub-state
  **working**, quiet, never nudged. Refused on an item the owner snoozed.
- **Only the ferret marks it Done** (`fy agenda done`), once nothing more is expected; the owner's own done or
  dismiss closes it too. `fy agenda ls` shows each Resting item's age, so a finished one gets closed. A ferret's
  `done` on an item the owner answered needs no `--reason`: the question was answered.
- **A blocker wakes a snooze.** A ferret's edit that newly sets `--blocking` on a snoozed item wakes it, fresh, as
  `--now` does — but it is its own reason, outside the once-an-hour limit that `--now` keeps, so an item that woke as
  urgent a moment ago still wakes for a new blocker.
- **The silence nudge.** An item waiting on its ferret that the ferret leaves silent for **30 minutes**
  (`AGENDA_REST_NUDGE_MS`) gets the Warden's nudge (`rest-nudge.ts`): ONE message per ferret naming every item due,
  `[attention check] The owner replied on !A5 «…» and is waiting on you…`, then again on a doubling backoff (1 h,
  2 h, … at most a day). It is off with the turn-end check (`attentionNudge` in `machine.yaml`), journalled as a
  nudge with the items named. Its send id names the resting episode (`resting.at`), not just the nudge count, so a
  later reply cycle never reuses a delivered nudge's id; the batch is recorded on each item (`resting.nudgeSend`)
  BEFORE it is sent, so a restart, or a failure after the first item was recorded, resumes that very message and
  never sends a second; and the completion is checked against the episode and count it was decided on, so a reply
  that arrives while the send is in flight keeps its own full 30 minutes. A `working` item and a snoozed one are never nudged; nor is a card the daemon raised.

**What a Resting item stores.** The field every app reads stays `parked: { reason: 'replied', at }` (or
`waitingOn: 'ferret'` for a request for more information), so an app from before Resting lists it under
**Replied** and never as needing the owner. Beside it, `resting: { sub, at, why?, nudgedAt?, nudges?, nudgeSend?, migrated? }`
says what that field cannot: the sub-state, what the ferret is doing, and the nudge clock. `parked` is what says
the item rests; a `resting` with nothing parked is dropped on the next write.

**Who is exempt.** An answer still CLOSES what the daemon acts on: a held configuration change (`--confirms`), an
input card, an old gate item read before the migration, and every item the daemon raised for itself
(`restsOnAnswer`). A card ask is no exception to resting: its agenda rests on the answer ([Card asks](#card-asks)).

### The Needs-you queue

**Needs you is one queue, and each item is in it at most once.** `needsYouQueue(items, keyOf?)` (protocol) is the one
selector: every `needs-you` item, the first of any repeat of its key (`keyOf` names an item across boards: its
session and id), **blockers first, then by when each started needing the owner**, then by key. The daemon's badge
count (`agendaBadgeCount`, the queue's length) and its stop push (`ownerTurnItems`: the queue, so a push opens at
a blocker first) read it. The app's Inbox adopts it with the side-panel Agenda tab.

**The Resting list** (`restingQueue`) is every resting or snoozed item, each once: those **waiting on their ferret
first**, then those it is **working** on, each oldest rest first, then the snoozed ones by when they wake.

### Stage, where we are, and the detail

- **`stage`** is what the item needs from the owner right now — `explainer`, `question`, `plan`, `tracker`, `test`,
  then `done` — separate from its state (a question can rest; a tracker can need the owner). A ferret sets it with
  `--stage` on `add` and `edit`; without one it is read from the kind (`agendaStageOfKind`: info is an explainer, a
  permission or review a plan, a to-do a test, the rest a question).
  Every stage the item entered is kept, oldest first, in `stages` (at most 64); closing it adds `done`.
- **`whereWeAre`** (`--where`, point form or Markdown) is where things stand now. Anything the owner asked for to
  complete the item — an explainer, a report — lives here.
- **`detail`** (`--detail`) is the context explained from zero, for a reader new to the topic; the app draws it
  folded away.

The app draws all three in the item view ([The item view](#the-item-view)): the stage on the head's chip, where we
are as its own part, the detail folded, and every earlier stage in the folded activity log.

### Editable asks

**A ferret's edit may REPLACE the ask**: its `ask`, `kind`, `answers` and `questions` (their options too). On the
command line `fy agenda edit A5 --kind <kind> --option … --question …` composes the new ask as `add` does.

- **What is a replacement.** An edit that names a `kind` (even the one the item already has: `--kind reply
--summary "…"` is the ferret saying "this is a different question"), or that changes the options (`ask`,
  `answers`, `questions` with other options or another shape, or a form's `fields` added, removed, retyped or given
  other options), replaces the ask. Rewording alone — the summary, body, context, `questions` text over the same
  options, a field's label, `--blocking` — is an ordinary edit: the ask, its version and the item's place in the
  queue stay.
- **A replaced ask is a new ask.** The item re-enters the queue as its one entry, fresh; `askVersion` moves on (1
  when absent); the edit is recorded as a revision (and a stage change when the kind moves). The owner's answer to
  the old ask (`ownerAnswer`) goes, and so does the ferret's old answer to their question unless the edit gives a
  new one. An answer that failed to deliver (`undelivered`, which the app offers as Retry) goes too: its payload
  answers the old ask and must never be blessed with the new version. A new kind with no ask of its own drops the
  old one (an explainer has no options).
- **A replacement drops the shape of the ask it replaces.** A kind change drops the old `ask`, `answers`,
  `questions`, `optionDetails`, `fields` and `steps` (a question becomes an info card, a todo a reply, a form
  anything else). A new ask of the same kind (an explicit `--kind`, or a new `ask` or `answers`) drops the old
  `questions` and `optionDetails`, which described the ask it replaces and would otherwise sit beside the new one
  or name an option it no longer offers. The replacement is validated as the composed item, and the revision records
  what was removed. The edit may give the new ask its own.
- **An answer to the old ask is refused `409 ask_changed`**, never applied to the new options: an answer request
  names the `askVersion` it was given to, and one that names an older version is refused (a stale tab, the undo
  window, a held send). **The app always names it**: it stamps the version of the ask on screen when the answer
  action is created, keeps it through the undo window and the outbox, and sends it with the dispatch (to a daemon
  that reports `agenda.asks.1`; an older daemon never receives the field, and has no replaced asks to confuse).
  An answer that names none is checked only where it cannot be stale: a **human's** answer with no version is
  refused `409 ask_changed` once the ask has been replaced, so an older app is locked out of a replaced ask
  until it reloads; the answer of a ferret's own `done --choice`, and any answer to an ask never replaced, are
  taken as before.
- **A Done or a Skip given from the ask is checked the same way.** A to-do's Mark as done, and any answer that closes
  the item, is an answer to the ask on screen: the app names its `askVersion` on the `resolve` or `dismiss`
  request, so a Done held in the undo window never closes the question that replaced the to-do (`409
ask_changed`, the new question stays open). A close that names no version — the owner's own explicit closing of
  the item as it stands, an older app, the ferret's `done` — closes whatever the item asks now.
- **A stale "Answer to your question" clears**: `fy agenda edit A5 --clear-question-answer`.
- A configuration change's ask is fixed (Allow, Deny, Discard change), and a notice or input card has none: those
  are refused.

### No size limit

There is no size limit a reader meets: **an item may weigh up to a transport bound of 1,000,000 characters of
JSON** (`MAX_AGENDA_ITEM_LENGTH`), and each field keeps its own explicit bound under it — the body, where we are,
the detail and an answer to the owner's question 200,000; the context and every reply or answer of the owner's
64,000; a point-form segment and a step 16,000. Nothing is cut on the way: a reply is kept whole in the history,
and the app cuts nothing either — a long report, every reply and every line an edit changed are drawn whole.
The wire history (20 entries) and the revisions (10) stay bounded: the full conversation and every version live in
their own stores ([the conversation](#the-conversation), [versions](#versions)). Before an owner record leaves that history, it is durably appended to the session's
`agenda-history.jsonl`, keyed by item id. The sidecar has no eviction policy and stays off the wire. Pruning a
closed item removes its hot view, retaining all its owner words in this file: its conversation, and the closing note
and any structured answer, as the item's complete last snapshot (a `version` record). History is read only when
explicitly requested; an ordinary transaction never rewrites the committed sidecar and rereads it only for one
fallback: a thread leaving the hot ledger whose item has no version in the version store takes its last snapshot from
a `version` record **inside the committed cursor** (a line past the cursor, or in a ledger with no cursor, is never
used; the transaction fails closed instead). A pruned item's `version` record holds the snapshot with only the
bounded recent tail (8 KB) of its thread; the whole thread is in the version store.

**Storage layout.** Each line is an `owner-history` record (`id`, `entry`) or a `version` record (`id`, `item`).
`agenda.json` holds an `archive` cursor with a UTF-8 byte offset and record count rather than embedding that
history. Its current entries stay bounded; the version-4 full-conversation map ([the conversation](#the-conversation))
grows with an open item's thread and is committed with state. Transaction-local `archivePending` records are appended
and synced before the hot ledger is atomically written without them; that ledger write is the commit. Every byte
past the committed cursor was never committed (a rolled-back command's records, or an append a crash tore, split
UTF-8 characters included), so history reads stop at the cursor and the next append cuts that tail before it
writes: a retried command's records land once, and a different command never adopts another's. Before it writes,
an append puts down a `agenda-history.jsonl.pending` mark saying where it began, and every successful ledger write
lifts it, so a mark on disk means "this append was not committed". The cursor decides wherever there is one; the
mark matters to a ledger with none (below). Existing in-ledger `ownerHistory` records move here on the next
transaction, including an unchanged one, with the same rule: a migration whose ledger write fails is cut and
written again, never twice.

**One writer, one reader rule per file.** This sidecar is the hot ledger's history and nothing else: only the
ledger write appends to it, and every read (`readArchive`, the version-4 migration's seed of archived owner words,
and the fallback that finds a pruned item's last snapshot) stops at the committed cursor. Full versions and full
conversations are not kept here; they live in the per-item version store ([versions](#versions)), which reads
this file but never writes it.

**A ledger with no cursor** reads as version 1 (no `version`, or 1): one a daemon before the cursor wrote, or one an
older daemon rewrote after a downgrade. Its sidecar's complete lines are adopted as committed history (the cursor
then covers them), stopping at the mark when one is down, so an append whose ledger write failed is never
served or adopted, and a torn last line is left out and cut by the next append. The conversation migration seeds
from exactly those adopted lines, in the same read. A ledger of version 2 or later with no cursor has no history
yet and adopts nothing.

**Older ledgers are decoded before today's wire budgets are applied.** An old-valid item whose escaped versions
exceed the transport bound keeps its complete original snapshot as a sidecar `version`; its served view sheds
the oldest versions to fit. Its current words stay readable and actionable. Read-time normalization is
idempotent, and the sidecar is committed before the migrated view replaces the old file.

**An item can always be closed, rested, edited shorter and answered.** What the item says (its fields; `MAX_AGENDA_CONTENT_LENGTH`,
560,000) is bounded well under the transport bound. A response alone is at most 70,000 characters of JSON, and the
**complete response plus note** is at most 136,000 (`MAX_AGENDA_REPLY_ENVELOPE_LENGTH`), including JSON escaping.
Three retained envelopes (latest answer, Retry, closing response/note) take at most 408,000, leaving 32,000 for
control metadata. Non-evictable gate receipts use at most 16,000 of that reserve. The reserve includes all
transition-only fields: request counters, waiting state and timestamps, stage and step progress never consume
the item's own content budget. Requests and stored reply
envelopes share this check; a 64,000-character printable answer plus a printable note fits, while a note whose
escaping exceeds the envelope is refused before writing. The complete merged closed item also checks the
1,000,000-character bound, including all resolution fields.

A request that raises or edits an item past the content bound is refused, naming it. When versions or history
would push an item past the transport bound, the machine removes oldest retained versions first, then oldest
history entries (never a gate receipt), **archiving owner records in the same write before removing them**. The
20-entry wire history limit uses that same archive path. Rebuildable activity and version metadata can be shed;
owner responses and notes remain durable.

An owner's earlier answers are kept: each `replied` history entry carries the `response` (the choice or typed
answer) next to its note, because `ownerAnswer` keeps only the latest.

### The migration (ledger version 2)

The board file says its shape (`version`; absent reads as 1). The channel migration introduced version 2;
the conversation migration now brings it to version 4 as it is read
(`toChannel`, pure, total and idempotent: a board already in the shape is the same object), and the next write
persists it; nothing on an item is dropped.

- An open item parked as `replied` rests as **waiting on the ferret**, its reply time the nudge clock. One from a
  version-1 file is marked `migrated`: the Warden nudges it **once** after the upgrade and never again, and every
  item of one ferret goes in one message, so a backlog of old replies is never a burst.
- An item with no stage gets the one its kind says (`done` once closed), as the first of its stages.

## Turns

The turn is the older view of the [state](#states), kept for every app that reads it: `agendaTurn(item)` (protocol)
is its one definition, and a Resting item reads as `parked` through its `parked: replied`.

| Turn       | When                                                                         |
| ---------- | ---------------------------------------------------------------------------- |
| **owner**  | Needs you: a new ask, or the ferret answered on it.                          |
| **ferret** | The owner asked to talk it through (Discuss), or asked for more info.        |
| **parked** | Resting on a reply, an answer or the ferret's work, or snoozed.              |
| **done**   | Closed by the ferret's done or the owner's done or dismiss, or it is notice. |

A new ask is the owner's turn. Nothing starts "in discussion": the ferret raises it, the owner reads it.

Internally the ferret's turn is `waitingOn: 'ferret'` with `waitingFor` either `'discussion'` (the owner
asked to discuss it) or `'info'` (the owner asked for more information). Clients read the turn, not those two
fields. **A chat reply is not a turn at all: it parks the item** (see "Parked items").

## Handing it back

On the ferret's turn there are a few ways out. An item RESTING on the owner's reply or answer (see [States](#states))
is off their list: a plain `edit` updates the card and leaves it resting, `fy agenda answer` brings it back to its old
place, and a bare `surface` is refused there. **None of them pings the owner.**

- `fy agenda answer <id> "<text>"` — answer the owner on it: it is theirs again, in its old place.
- `fy agenda edit <id> …` — change the card (settled answers, what is still open, its stage). Any edit by the raising agent on its own turn for more information hands the item back to the owner,
  even one that changes nothing. (Not an item resting on a reply: that edit keeps it resting, unless it answers on
  it. `--back` is retired: the CLI refuses it and names the verbs above.)
- `fy agenda rest <id> --why "…"` — take it on, quiet, while working.
- `fy agenda surface <id> [--why "…"]` — hand a discussed item back as it stands.
- `fy agenda done <id>` / `dismiss <id>` — close it, once nothing more is expected.

A human's edit never changes whose turn it is.

## Chatting about items

The owner can mention open items in a chat message: type `!A5`, or attach "re:" chips (several are fine).
The ferret receives the message as

```
[re !A5 «title», !A7 «title»] <text>
```

**A reply is not an answer, and it is not "still open" either.** Each referenced item RESTS at once, waiting on
the ferret (next section). The message itself is the delivery: the ferret reads `[re !A5 …]` in its chat,
and the daemon sends nothing else (a `replied` change that no observer reacts to). A notice is never
referenced. If the ferret finishes a turn without touching a referenced item (an `answer`, `rest`, `edit`, `done`,
`dismiss` or `surface` naming it), the daemon nudges it once (nudge-once keys on the `[re !A…` opener); after that
only the 30-minute silence nudge ([States](#states)) speaks. The turn-end nudge says: "Owner replied about !A5; it
rests, waiting on you. Answer on it: `fy agenda answer A5 "<text>"` (back on their list), or `fy agenda done A5`
when nothing more is expected." It never says it is the ferret's turn to hand the item back.

Picking an option on the card (`respond`) answers the item and rests it, waiting on the ferret ([States](#states));
it no longer closes it. `--other "<words>"` remains on the CLI and in the app for "none of the options"; chat no
longer guesses it.

## The conversation, versions, merge and split

### The conversation

Every word the owner and the ferret say about an item is stored **oldest first and whole**, with no count or text
cap. Full threads live in the ledger-level `conversations` map in `agenda.json`, keyed by item id, outside the bounded
current items. The existing atomic ledger write and session lock commit words, logged message ids and state together.
This avoids a separate sidecar commit that could keep the words but lose the state change, or the reverse. The trade-off
is that a write rewrites the full ledger; there is no cap and no truncation of the durable thread.

Each entry is `{ at, by: owner | ferret | daemon, text, via, fromChat?: { messageId, at } }`. Insertion is chronological;
timestamp ties keep insertion order. Chat text keeps its exact indentation and trailing whitespace. A backdated log
inserts at its source time. A merge interleaves both full threads, keeping the survivor's entries first on ties.

The optional item fields `conversationCount` and `conversationLastAt` describe the full thread. `conversation` is only
a recent tail of complete entries, at most 8,192 JSON characters; an entry larger than that remains available through
the conversation route. These fields do not count toward the bounded own-content budget. Items and version snapshots
stay schema-valid under the item transport bound regardless of how much conversation accumulates.

`GET /v1/sessions/:sessionId/agenda/:id/conversation?index=0&offset=0` reads the full thread in bounded fragments.
The response has `total`, `index`, `offset`, an optional `entry`, and an optional `next: { index, offset }`. Each fragment
holds at most 16,384 UTF-16 code units of one entry's text; concatenate fragments of the same index verbatim. Follow
`next` until absent. An empty thread has no entry. Cursors describe the current chronological thread: restart at zero
if the item changes while paging, because a backdated entry or merge can change indices. Add `version=<n>` to page
a frozen historical thread instead; its order and text remain fixed even after a later merge or backdated log. The route requires
`operator`, serves `any` caller allowed to read the session, and never treats relayed loopback as host arrival.

Every path that carries words writes the conversation in the same transaction as its state change: a chat
`[re !A5 …]` reply, the Inbox composer, textual owner answers (including free text without a note), optional notes,
`fy agenda answer`, `needs-info`, `discuss`, `rest --why`, `surface`, gate notes and closing notes.

**Migration.** Earlier ledgers read as version 4. A stored embedded conversation is moved intact into the full-thread
map; otherwise the migration seeds both archived owner-history records and live history notes and textual responses,
the owner's answer and note, the ferret's
answer and the closing note. The resulting current item is bounded and validated before it is returned. Migration is
pure, lossless and idempotent; the next atomic write persists both the thread and the item. If new metadata
displaces bounded history or revisions at the transport limit, `carriedEntries` retains the original valid snapshot
in the ledger, and it becomes the first carried version on the next change. History already dropped
by an earlier daemon cannot be recovered. The existing PWA `item-conversation.ts` continues reading session transcripts;
the item view draws the stored thread on a machine that reports `agenda.conversation.1` (see [The item view](#the-item-view)).
That feature stays the health flag, and the new fields are optional for older apps.

### `fy agenda log`

`fy agenda log A5 --reply "<text>" | --rest "<what I'm doing>" [--message <id>]`

The ferret never retypes the owner's words. The daemon copies them **verbatim** from the session's own message store
(its queue and send ledger): the owner's latest message, or `--message <id>`, tagged `fromChat` with the message id
and time. The owner's words rest the item. `--reply` then answers them: the item goes back to the owner's list in its
old place, as `answer` does. `--rest` says what the ferret is doing, and the item stays Resting, working.

Refused: a message that is not the owner's (`forbidden`), a message that is not in this session (`not-found`; no other
session's messages are visible), a message id already logged on the item (the log is idempotent per message id), and an
item the caller may not edit (the sub-ferret rules below apply).

### Versions

Every change that writes an item keeps the **whole item** as it was left, numbered from 1, in a sidecar beside the
board: `agenda-versions/<id>.sqlite`. Each version holds a bounded `snapshot` and ordered references to immutable
conversation entries, shared by SHA-256 content address. The references preserve the full historical thread and its
order, including backdated insertions and merges, without copying the same long text into every version. Whole snapshots rather than diffs, because a version is read
on its own (the app puts any two side by side) and a diff chain is only as good as its oldest link — one lost line
would corrupt every version after it. The board file holds the item as it is now, within the bounds an older app reads
(20 history entries, 10 revisions); the sidecar holds how it got there, uncapped. An item from before versions is kept
as it stood first (change `carried`) when it is next changed. A merge or a split makes a version of each item it
touched. Before writing versions, the repository syncs the exact mutation drafts and next ledger to
`agenda-versions.pending.json`, with `base` (a digest of the `agenda.json` it was prepared from, taken from the read
the change already made), `ledger` (the exact text of the `agenda.json` it commits, with the history records to append
and the cursor they append from) and `result` (the digest of that text). An archive failure rejects the request and leaves that intent for
recovery; the current ledger stays unchanged until every draft is acknowledged. Reads and transactions replay an
outstanding intent before proceeding, **but only when `agenda.json` is still its `base` or already one of its
`result`**. Replay writes that text as it is. Once the `agenda.json` write lands the intent is rewritten, as early as
it can be, to just `{"committed": true}` plus the change event still owed (the drafts and the ledger text are no longer
needed). A committed intent is finished whatever `agenda.json` holds later: its history mark is lifted and its change
event copied, never replayed. An intent whose `agenda.json` is already its `result` appends nothing and cuts nothing
(a crash after the write left the history appended and the mark in place): it only lifts the mark. Any other file was
written by someone else since (a previous release, after a downgrade), and replaying would overwrite their writes and cut
their sidecar lines. Such an intent is first checked against that file: if its changes **did reach it** (the one window
the committed rewrite cannot close is a crash between the `agenda.json` write and the rewrite), the versions and the
change event are kept, the intent is finished and a warning says so. Landing is decided for the whole intent, because one
`agenda.json` write commits all its drafts: one draft whose mark is on the file (a created item by its subject; any
other change by its time among the item's history, revisions, owner answer or closing, with the item's subject or raiser
unchanged) is enough, which also covers drafts that leave no time on an item, such as a link. Otherwise the intent is set
aside as `agenda-versions.pending.json.stale` (a second one beside it as `.stale-<digest>`, never over the first), a
warning says so, and nothing is replayed. **What a set-aside intent had recorded is voided**: for each of its drafts the
store holds, its version is taken off the end of the item's versions, by the draft's mutation id, so it is not an item's
latest version, never shows in its history, and the number is reused by the next change. A version that a later change
recorded after it is left alone, and the conversation words the voided version referenced stay in the content-addressed
words table (harmless: the table is keyed by content and nothing refers to them). A retry after an uncertain acknowledgement uses the same per-item transaction identities,
so partial merge/split batches and commits whose replies were lost never duplicate or omit a version. The intent is
removed only after the hot ledger commit and an idempotent copy of its original change event to
`agenda-changes.pending.json`. That event keeps the actor, origin (`board` or `conversation`), affected items and
snapshot. The service drains these events through its ordinary raised/change observers after a read or mutation,
outside the repository transaction queue, so a projection can read the board without deadlocking. A critical reply
delivery is acknowledged only after the reply queue durably accepts it. Presentation observers remain isolated:
their failure cannot acknowledge a failed delivery or hold an accepted one. Each acknowledged event is removed
durably. A failed delivery stays pending with its original event and a persisted retry count, deadline and error.
Delivery is attempted at most five times, with delays of 1, 2, 4 and 8 seconds between attempts; reads and unchanged
retries before the deadline do not attempt it again. A pending, backing-off or parked event is a FIFO barrier for
its item: later events for that item wait until it is durably accepted. Merged items share that barrier with their
survivor, including through successive merges; a split child is an independent item. Unrelated eligible events
continue past a failing event. Every
failure is logged. After the fifth failure the event stays parked in `agenda-changes.pending.json`, with a warning
naming the session, event and file; it is never silently dropped. After repairing delivery, an operator can remove
that event's `retry` field to rearm it. Later events remain behind a parked barrier, and each drain logs their
session, event and blocking parked event through the same warning sink as the parking diagnostic. An operator who
explicitly decides that the old instruction is superseded can instead remove that event from the pending array;
the later instructions then proceed on the next drain. Stop the daemon before editing this file so the drain
cannot overwrite the repair; restart it and read the agenda to drain again. Recovery followed by an unchanged retry therefore still delivers an owner's answer or
closure to the ferret. A crash before acknowledgement can repeat an event; reply delivery uses its existing durable
per-item/request keys to make that replay idempotent. This outbox keeps the original effects with the intent instead
of trying to infer them from later state, which cannot reconstruct who answered or how their words arrived.

Snapshots use an integer primary key; append numbering reads its largest value without parsing earlier snapshots.
Conversation references are indexed by version and position, and words by content hash. A historical read loads just
that version and its entries. The store caches one immutable read version and its thread, so later fragments parse
no archive text; changing versions releases that cached thread. Listing reads only small summaries. Appending writes
the new snapshot and its ordered references in one SQLite transaction, with new words inserted once. Its work depends
on the current thread, not the number or size of historical versions; unchanged words take no additional text storage.
This avoids repeated full-archive scans while keeping independently readable complete snapshots and uncapped words.

Earlier draft sidecars (`<id>.jsonl`), both bare snapshots and snapshot/conversation envelopes, import once inside
the database's initialization transaction. The old file stays untouched. Complete records survive, including a final
record without a newline; malformed records and torn tails are skipped. The next append numbers from the durable
imported records, so it cannot join onto a torn tail or swallow the next version. Interrupted database writes roll
back as a unit; a failed import is retried on the next open. These earlier files were never deployed.

Pruning a closed item cold-archives its complete thread, final snapshot and any carried legacy snapshot before
removing its `conversations` and `carriedEntries` keys from the hot ledger. Previously orphaned keys follow the same
path on the next change. Preserved unreadable entries are live: their conversation and carried-snapshot keys stay
in the hot ledger until the entry is actually pruned, even when it has no archive yet. Active threads remain uncapped. The unchanged conversation route reads a pruned item
from its latest archive version, and historical version reads remain available. A crash between archive and hot
commit replays the durable intent without losing words. Merge and split still require open items.

The `agenda-versions` worker owns SQLite opens, initialization, legacy JSONL parsing, reads and commits. The session
transaction queue awaits each archive request before committing the ledger; no version writes run behind that queue.
A busy disk delays that session's next change while other routes and streams keep running. Worker failures reject
the request without falling back to disk IO on the main thread. The worker closes connections after each operation
and ends after a minute idle. Both ends cache at most one immutable read version for fragment paging.

`GET /v1/sessions/:id/agenda/:itemId/versions` lists them (and this device's last seen version),
`GET …/versions/:version` fetches any one in full, and `PUT …/seen` records that this device opened the item at a
version. The mark is per device (`agenda-seen.json`, `{ deviceId: { itemId: version } }`), monotonic (a device that
has seen a later version keeps it), and refused for a version the item does not have.

Declared GAPs: rolling a daemon back leaves the sidecar in place, and an older daemon does not write to it, so versions
made meanwhile are missing; a snapshot is the item, so an item at the 1 MB transport bound writes a snapshot that size.

### Merge

`fy agenda merge A2 A5` merges A5 **into** A2 (`POST …/agenda` with `{ action: 'merge', id, from }`). The two
conversations are interleaved by time, and all cards, card asks and links of both are kept (a merge that would pass a
bound is refused, never trimmed). A2 keeps its state and its ask. A5 closes as `merged into !A2`, and the two point at
each other (`mergedFrom` on A2, `mergedInto` on A5), A5's versions kept.

[Card asks](#card-asks) move to A2, and A5 closes carrying none:

- **One ask per card and entry.** When both carry the ask of the same card's same entry into its lane, A2 keeps one:
  the one the owner got further with (an answer, then a Not yet), else A2's own. Every receipt is kept.
- **Still asking.** An ask still waiting on the owner does to A2 what putting it there does: a resting or snoozed A2
  wakes into Needs you, at stage `test` or `plan`.
- **Refused.** More asks than one agenda carries (16 in all, answered or not: no answer or receipt is dropped to fit), or an A2 that cannot carry a card's ask (an input, a
  confirmation, a task plan, …).
- **Answering.** The owner answers the ask on A2 as before: owner only, the card moves first, the same receipt and
  replay. An answer that names its ask (`cardAsk`) but reaches A5, from a screen that still shows it, is answered on
  A2. An answer from an app that names no ask finds nothing on A5 and is refused.

Who may: the owner, or a lead over its own items and its sub-ferrets'. A merge is within one board, so across sessions
only items in the same agenda home (one lineage) can be merged. Refused: an item with itself, into or from a done item,
a gate item from before card asks, a notice or a card the daemon acts on, and a caller the item is not theirs to
address.

In the app, an open plain conversation shows **Merge with…** beside its lineage lines. The picker is headed with the open
agenda by id and title and marked "this one" ("Merge !A5 "Queue choice" (this one) with which open agenda?"), and lists
the other open plain conversations on the same board by id and title. A confirm step says what will happen before
anything is sent, naming BOTH agendas by id and title and marking the open one "this one", because an id alone does not
say which agenda it is: "Merge !A2 "Pick the queue" into !A5 "Queue choice" (this one)?", then "!A2 "Pick the queue"
closes as merged into !A5 "Queue choice" (this one). Both conversations and all cards are kept, and nothing is cut."
The viewed item survives by default, and "Keep !A2 "Pick the queue" instead of this one" flips it (the button then
reads "Merge into !A2 "Pick the queue""). A long title is cut at a word with "…". There is no grant to gate on: the daemon decides by who acts, so the app offers the button
only when the machine reports `agenda.conversation.1`, the host can send a merge, and the item is an open plain
conversation, and a refusal from the daemon is shown in the panel in the daemon's own words. A merged item shows
**Merged into !A2 (its title)** as a link, and the survivor shows **Merged in from !A5 (its title)**. A merged-away agenda is closed, so
its title is read from the board's resolved records as well as its open items. A machine with no merge never shows the
button, and the machine's own agenda (`machine-agenda`) offers none.

### Split

`fy agenda split A5 --title … --premise … --context … "<ask>" [--move-cards F12,…] [--stage …]` raises a new item for
the part of A5 that stopped passing the one-agenda test. The new item is the same ferret's, with its own ask and its own
place in the owner's queue (one Needs-you entry per item); it and A5 point at each other (`splitFrom`, `splitInto`),
and the cards named in `--move-cards` go along. A5 keeps its state, ask and conversation. Refused: a card A5 does not
hold, a gate, a notice or a card the daemon acts on, and a request an open item of the ferret already makes.

A card A5 carries only through its [card ask](#card-asks) can be moved too. A moved card's asks go with it:

- **The new item carries them,** answered or not, at stage `test` or `plan` when one still waits on the owner.
- **A5 keeps the rest.** When A5 asked the owner nothing but the asks that moved, it does not sit in Needs you with
  nothing to answer: a ferret's thread goes back to the turn the first of them woke it out of, and the card's own
  agenda rests on its ferret.
- **Refused:** a new item that cannot carry a card's ask. A split off the card's own agenda is the daemon's item, not
  the card's agenda, so moving its card is refused; merge the two instead.
- **Answering.** The owner answers on the new item as before. An answer that names its ask but reaches A5 is answered
  on the new item.

The app shows both links as references through the one reference renderer: **Split from !A3 (its title)** on the new
item and **Split into !A7 (its title), !A8 (its title)** on the original, each `!A…` opening as it does in a message.
Each target carries its title when the board holds it, so a link never points outside the agenda without saying what it
points at; a target the board does not hold is the bare id. The app has no split button: a
split is a ferret's act, and a plain "Split off…" can follow once the owner may split by route.

## Parked items

A parked item is still open, but it is **nobody's turn** for now: it leaves the owner's open list, the Inbox's open
sections, the badge counts and "Needs you", and the session summary does not count it. It carries
`parked: { reason, at, until? }` and reads as the `parked` turn (`agendaTurn`). There are two reasons, one
mechanism: why it is parked, and its way back.

### Replied

An item the owner replied to in the chat (`[re !A5 «title»] …`), or ANSWERED on its card, RESTS the moment the
message or answer is accepted: it is **parked as `replied`** (the field every app reads) and its `resting` says it
waits on the ferret ([States](#states)). Otherwise an item a ferret never touches would hang on the owner's list for
ever, and closing it would lose it when the ferret still needs something.

- **The words are kept.** The reply text, or an answer's note, is a `replied` entry in the item's history, whole up
  to the reply bound. A reply with no words (a bare chip) records the entry without a note. Any wait (more
  information, a discussion) ends: the reply answered it.
- **It stays off the list until the ferret answers on it.** A plain `fy agenda edit <id> …` by the ferret updates the
  card (the living summary) and **leaves it resting**: no `waitingSince` bump, nothing unread, no badge.
  `fy agenda answer <id> "<text>"` brings it back to the owner **in its old place** (`waitingSince` unchanged); a
  replaced ask (`edit --kind …`) brings it back fresh. `fy agenda done <id>` / `dismiss <id>` closes it **without
  telling the owner** (no push, no buzz, no badge change): the CLI prints "A5 closed; the owner is not notified
  (they had already replied)", and the item shows under Resolved as usual.
- **`--back` is retired** from the CLI, which refuses it and names `agenda answer` and `edit --kind`. The daemon
  still takes it from an older CLI: a `--back` with the whole card refreshed (`--summary`, `--premise`, `--context`)
  brings the item back fresh, and one that leaves one out is refused (`invalid`, naming the missing flags); so is a
  bare `fy agenda surface <id>` of a resting item.
- The app lists it under **Replied (n)**; the owner can bring it back themselves ("Back to my list"). The Inbox does not wait for the next board read: a reply sent from an open Inbox item is shown as replied at once, with an Undo (see "In the Inbox").
- **Warden items follow the same rule.** A daemon-raised item the owner replied to parks like any other; it is
  not raised again for the same anomaly while the Warden's "already told" record holds.
- **Discuss is separate.** The owner's explicit Discuss (and a request for more information) still puts the item
  on the ferret's turn and counts as a request; it rests too, waiting on the ferret, and any edit of the ferret's
  hands it back.

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
  (`urgentAt`; a second try inside the hour is refused as `rate-limited`). A **newly blocking** edit (`--blocking`)
  wakes it on its own, outside that throttle: an item that woke as urgent half an hour ago still wakes for a new
  blocker.
- Only the owner snoozes and unsnoozes; only the daemon's own timer wakes. A notice is read, not snoozed.
- **The app ships first**: a daemon reports `agenda.snooze.1` on `GET /v1/health`, and the app sends snooze or
  unsnooze only to a machine that lists it. To an older machine it sends nothing and says the machine needs an
  update; a machine not yet read that refuses the request as an unknown action is told apart the same way.

**Migration.** Replies used to close items (`disposition: 'replied'`), and before that they left an item on the
ferret's turn. When a board is read, an item still waiting on the ferret only because of an owner reply is
parked as `replied` at the reply, and an item closed as `replied` is open again, parked as `replied` at its
close — newest first, and only while the board has room (the per-session cap, and the agent cap for a ferret's
item); the rest stay closed, and `surface` or `edit` still reopens one. It is pure and idempotent
(`parkOwnerReplies`), and the next write persists it. Every item it parks then rests, as the [ledger version 2 migration](#the-migration-ledger-version-2) says.

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

`fy agenda add | edit | answer | rest | log | merge | split | step | show | ls | history | surface | snooze | unsnooze | done | dismiss | needs-info | discuss | send-now`

| Verb                                | Does                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `add`                               | Open an item with `--title` and its ask; `--stage`, `--where`, `--detail`. Lists open candidates; `--new "<why none fits>"` opens another. |
| `add --offer-close`                 | With `--task`: the owner may close the card with the same tap that resolves it.                                                            |
| `add --task <card>`                 | Refused for an agent when the card is already asking the owner ([One ask per thing](#one-ask-per-thing)).                                  |
| `edit <id>`                         | Rewrite the card, its stage, `--where`, `--detail`; on the ferret's turn hands it back. A resting one stays.                               |
| `edit <id> --kind <kind>`           | Replace the ask (with `--option` / `--question`): it asks again, fresh ([Editable asks](#editable-asks)).                                  |
| `edit <id> --clear-question-answer` | Take a stale answer to the owner's question off the item.                                                                                  |
| `answer <id> "<text>"`              | Answer the owner on it; a resting item goes back to their list in its old place.                                                           |
| `rest <id> --why "<what>"`          | Take it on without asking anything: Resting, working, quiet, never nudged.                                                                 |
| `log <id> --reply\|--rest`          | Copy the owner's chat words onto the item verbatim, then answer or rest ([`fy agenda log`](#fy-agenda-log)).                               |
| `merge <into> <from>`               | Merge `<from>` into `<into>`: one conversation, every card kept ([Merge](#merge)).                                                         |
| `split <id> …`                      | Split a new item off `<id>`, linked both ways ([Split](#split)).                                                                           |
| `edit <id> --back`                  | Retired: refused, naming `answer` and `edit --kind`.                                                                                       |
| `surface <id>`                      | Hand it back to the owner, unchanged (silent). Refused for a resting item.                                                                 |
| `snooze <id>`                       | The owner's: put it away `--for 4h` or `--until 17:00`; it comes back fresh.                                                               |
| `unsnooze <id>`                     | The owner's: bring a snoozed or resting item back to the list now.                                                                         |
| `done <id>`                         | Close it, optionally answering its ask (`--choice`, `--yes`, `--other`…). Quiet on a resting item.                                         |
| `dismiss <id>`                      | Close without answering; agents only their own. Quiet on a resting item.                                                                   |
| `ls` / `show`                       | Open items with their stage, turn, how long each has rested, and blocking fields / one item in full.                                       |
| `needs-info`, `discuss`             | The owner's side, kept for old clients. They make it the ferret's turn.                                                                    |

`edit` and `surface` take `--now` when it is urgent: it wakes an item the owner snoozed, once an hour per item.

**Sub-ferrets raise nothing.** A session another ferret started (`config.parent`) is refused `add`, `edit`,
`surface`, `done` and `dismiss` (and `fy notify`, the same owner-facing channel) with `forbidden`: `You are a sub-ferret, so you can't
raise agenda items or notify the owner. You may read the agenda and report to your lead. For anything else ask your lead: fy send <lead-callsign> "…"`. They report to the lead with
`fy send` (labelled `--kind blocker|action|fyi`, [message-delivery.md](message-delivery.md#labels-and-combined-delivery)); the lead decides what the owner must see. `AgendaService.apply` is the one choke point; reads stay open.
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
items on the board of a session it started (never an open [card ask](#card-asks)): `fy agenda done !A1 -s <sub-session>`. `AgendaService.apply` proves the
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

**Every link says what it is.** A link is a label, a target and a plain `meaning` (`AgendaLink`, at most
`MAX_AGENDA_TERM_MEANING_LENGTH` characters, the bound a term's meaning has), because the item is
self-contained: its terms-and-references table lists every term and every PR, card or link with a plain meaning,
and an address explains nothing. `fy agenda add|edit --link "label=target=meaning"` gives one; `label=target` (new
with meanings) and a bare target (the only form before) are read too, and the `--json-file` form takes
`{"label", "target", "meaning"}`. The label is read only when it looks like one: a word or two without `/`, `?`, `&`
or `\`, so a bare target with an `=` of its own (`https://host/page?a=b`) stays a target. A target may hold an `=`
too (a query, `docs/a=b.md`), and an address never holds a space while a meaning is a sentence: the meaning starts
after the last `=` whose tail holds whitespace (`Run=https://ci/run?id=7=The failing run`), and an `=` inside a
meaning (`Fix=#1440=Sets retries = 3 for the job`) is skipped while the target before the first `=` holds no space.
With no sentence, the first `=` opens the meaning (`Docs=docs/a.md=Notes`, `PR=<pull request URL>=Fix`) unless it
belongs to the target: a `?` comes before it (`Run=https://ci/run?id=7`) or an address comes after it
(`Docs=docs/a=b.md`); one trailing `=` is an empty meaning. A one-word meaning after a query target
(`Run=https://ci/run?id=7=Failing`) is the case no rule can settle: it is read whole as the target. So whenever a
labelled link keeps an `=` in its target and no meaning was read, the CLI says so on standard error ("read … as the whole target of …; if
"Failing" is its meaning, give the link through --json-file"), and `--json-file` gives it unambiguously. The daemon lint warns, never refuses, for a link with no meaning ("say what it is, in
plain words"). The item view shows the meaning in its terms-and-references table once it lands, and falls back to
the label for an item raised before meanings existed. The daemon reports `agenda.link-meaning.1` on
`GET /v1/health`; the CLI sends a meaning only to a daemon that lists it, and when the daemon lacks it (or its
features cannot be read) sends each link as `label=target` and says it could not confirm the daemon takes link
meanings. A card the daemon raises on a ferret's behalf (an input form) links its closest agenda with a meaning of
its own.

**Every segment is short points, never a paragraph.** The premise, context, decided, still-open, question
answer, body, option details, ask, revision notes and terms all read as the same Markdown on the card: bullets
(`-` or `•`), numbered lists, **bold**, `code`, references, and a single line break kept as a line
(`segmentMarkdown` in the app owns that, so no segment flattens its lines, and a label line directly above a list that starts at 4 still reads as a label and a list). Writing follows: answer first, one
idea per line. `fy agenda add` and `agenda edit` warn, never block, when a segment is a single paragraph over
280 characters (`AGENDA_SEGMENT_PARAGRAPH_LENGTH` in `@ferretry/protocol`), saying to split it into short points
or bold the answer first. Lists, tables, headings and fenced code are not counted as paragraphs.

**No Markdown headings in the ask or a segment.** A `#` heading draws as a huge title inside a card (the "What I need from you" card read as one wall of H1s), so the ask and every segment — premise, context, decided, still-open, question answer, impact, recommendation and option details — are short points or a bold lead, never `# …` to `###### …`. `fy agenda add` and `agenda edit` warn, never block, when the ask is over about 80 characters (saying to move the detail to `--body` or `--context`) and when the ask or any of those segments holds a heading line (outside fenced code; `#812` is a reference, not a heading). `--body` is left alone: it is where longer instructions go.

**A bunch of bugs or asks heard at once is not a pile of new items.** When the owner reports several bugs, or asks several things in one message, an interactive (Agenda-mode) ferret adds each to the agenda it belongs with, by the three-part test ([One channel per topic](#one-channel-per-topic)), and opens a new one only for what fits none. The prompt says it in one line — "Bug batch: ONE agenda, line each + where tracked." — a line per bug and where each is tracked. Sub-ferrets do not (Agenda mode is left out of their prompt) and report to their lead instead. The rule follows from the test the Agenda-mode instruction teaches (`AGENDA_INSTRUCTION`).

**A body over 200,000 characters is refused, never trimmed.** `body`, `questionAnswer` (`--question-answer`), `whereWeAre` and `detail` take at most `MAX_AGENDA_BODY_LENGTH`, `MAX_AGENDA_WHERE_LENGTH` and `MAX_AGENDA_FOLDED_DETAIL_LENGTH` (200,000 each), and a step at most `MAX_AGENDA_STEP_LENGTH` (16,000). One schema (`longProse`, `packages/protocol/src/lib/agenda.ts`) enforces it for every path that takes one — `agenda add`, `agenda edit`, `--body-file`, `--json-file` and the daemon's own check — so the CLI refuses before it sends and the daemon refuses with the same words: _the body is 200,001 characters; the most is 200,000. Do not trim it: put the full report in a file or artifact, add it with --link, and keep the body to a one-screen summary and the choice._ Nothing is ever cut to fit: a trimmed report loses its sections, and the agenda is a decision surface, not a document store. The same holds for a gate item's body (the card's _How to test_): over the cap, the body says how long it is and points at the card instead of showing a cut-off copy. The Agenda-mode instruction carries the one-line version.

**A segment never draws a heading.** A Markdown heading (`#` … `######`) a ferret writes inside any segment is drawn
as bold text at the segment's own size, never an h1–h6: the card's own labels (Premise, Context, **What I need from
you**) are its only headings. Chat messages keep their headings; only agenda segments demote them
(`demoteHeadings` on `Markdown`, set once by `AgendaProse`).

**The open item's title is always readable.** The open item's head stays ONE row, and its title wraps onto **at most
two lines** (which fit beside the row's controls — ‹ n/N ›, ⓘ, the clock, ✕ — on a 390px phone): it never scrolls and
is never cut at either side, with or without reduced motion. A title longer than two lines is drawn **whole at the top
of the body** as well, straight under the head (`data-agenda-full-title`), so the owner can always read the question.
Every item wraps this way — ordinary, gate or machine notice. Other card heads (a card to test in the Inbox) keep one
line: a title too wide scrolls to its end and back (the marquee), and where motion is reduced it ends at the last whole
WORD that fits, then "…" (`wordCut`; a tap shows all of it). List rows keep their own clamps. A card's who/where line
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
Inbox chip, the card header and the row's meta line read it; the app keeps only the tone. The open item's head says
its STAGE instead ([The item view](#the-item-view)), which is what it needs from the owner right now.

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

## The item view

**One item view everywhere** — the chat and the Inbox draw the same component (`AgendaItemView`). It
reads top to bottom in nine parts; the order is `ITEM_VIEW_PARTS` in `packages/pwa/src/lib/agenda-item-sections.ts`,
and a part the item does not carry is not drawn:

| #   | Part                   | What it holds                                                                                                                                                                                                            |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Title, state and stage | the title row; the STATE chip (Needs you · Resting · waiting on Zoe · Resting · working · Snoozed until … · Done), the STAGE chip (Explainer · Question · Plan to approve · Tracker · Test · Done), and the version slot |
| 2   | Premise and context    | the two tinted blocks; long is fine                                                                                                                                                                                      |
| 3   | Detailed context       | `detail`, explained from zero — **folded**                                                                                                                                                                               |
| 4   | Terms and references   | ONE table of every term and every link (PR, card, file, page), a term says what it means; a link is named by its target (drawn by the one reference renderer) and means its label, or nothing when it has none           |
| 5   | Where we are now       | `whereWeAre` — the report or explainer the owner asked for — then the ferret's answer to their question, what is decided and what is still open                                                                          |
| 6   | Conversation           | the owner's and the ferret's words about the item, oldest first, each whole                                                                                                                                              |
| 7   | What I need from you   | the ask ([below](#what-i-need-from-you)), why the recommendation, the steps, the impact, then **every card ask with its own buttons** (test steps and Done / Not good, or OK to build)                                   |
| 8   | Body                   | `body`: More detail, or a review's Reasoning (Markdown with fy-render)                                                                                                                                                   |
| 9   | Activity               | the grey lines — each stage entered, each edit with what it changed, where it rests or sleeps now — **folded**                                                                                                           |

- **Folded parts remember.** The detailed context and the activity log start closed; opening one is remembered per
  item on that device (browser storage, read and written defensively — a private window simply starts closed again).
- **No cut-offs.** Nothing in the open item is clamped or truncated: a long report, every reply and every line an
  edit changed are drawn whole. The title wraps onto two lines in the head, and one longer than that is drawn whole at
  the top of the body too. Rows in a list may still be one line.
- **The conversation** is read from the chat for an item that has no stored thread (`itemHistory`: the owner's words
  that name the item and the parts of the ferret's replies about it). A machine with the stored conversation
  (`agenda.conversation.1`) feeds the same part from the item itself: the item's own tail when it is whole, else every
  entry read through `GET …/conversation`, in stored order. The item carries a bounded tail, so only the
  entries BEFORE the tail are read, once each, and the tail is drawn at once under one line, "Loading N earlier
  entries…". A reply that arrives reads only the entries the app does not hold yet, never the thread from the start.
  A merge interleaves the absorbed thread into this one by time, so the entries read before it are no longer a prefix:
  when the item's `mergedFrom` changes, what was read is dropped and the thread is read again from the first entry.
  A read that fails says "N earlier entries could not be read" and tries again whenever the stored count of the thread changes (a short reply that fits in the tail counts); a thread
  longer than one read takes says "N earlier entries are not shown: this conversation is longer than one read takes".
  A partial thread is never drawn as a whole one, and the rebuilt thread is never swapped in for it. An owner entry is the owner's bubble (an `answer`, `needs-info` or `discuss` keeps its form), a ferret
  entry is the ferret's, a daemon entry is drawn under "Ferretry", and an entry the ferret copied from the owner's chat
  (`fromChat`) carries a **from chat** tag.
- **Card asks live inside the item.** A card ready to test or approve is answered in part 7, with its own buttons,
  never as an item of its own. Today a card ask arrives as the thread's `gateAttached`; the part is drawn over a
  list, so a machine that carries several (`cardAsks`, `agenda.card-asks.1`) fills it unchanged. The item's own
  one-row answer is the sticky dock at the view's foot, in reach however long the item runs — until card asks
  share the view: then it sits inline right under the item's own ask, headed **Your answer for this item**, and
  every card ask has its own heading (**Card &F12: your answer for the card**, then a line saying where the card stands), so two button sets are
  never docked beside each other and never mistaken for one another. A card ask carries the card's **How to test**,
  read from the board the app already loads (`howToTestFor`), above its Done / Not good.
- **Opened at its ask.** A Needs-you push, and any link that names the item (`?agenda=A5`), open the view scrolled to
  part 7 with it focused. Each tap is a new request, so an item already at its ask is brought to it again. An item
  the owner opens themselves, or one paged to from the one a push opened, starts at its top.
- **The head keeps a slot** (`data-agenda-version-slot`) for the version picker and the diff control. Beside the diff
  control the picker counts the item's EDITS ("Edit 2 of 3"), because the diff's own numbers (v1, v2…) are the stored
  versions, which count more than the edits do; a machine with no stored versions keeps "v2 of 3".
- **Changes (the diff).** With two or more versions on a machine that keeps them, the slot gains a **Changes** button.
  It opens a panel under the head that compares "since you last looked" by default (this device's last-seen mark
  against the newest version) and lets the owner pick any two versions from **From** and **To**. Each changed section
  shows what changed, coarse to fine: equal lines stay; the lines between them are paired in order by how alike they
  are; inside a pair the same is done sentence by sentence, then word by word, with a short kept word between two
  changes ("the", "of") folded into them so one edit is not confetti. A pair that shares fewer than half of its words
  (`REWRITE_SIMILARITY`) is a REWRITE: the old block is struck through whole and the new block added whole, never
  woven word by word, while a small edit stays a word diff. A long text with a small edit stays word-level too: equal
  lines (and sentences) at both ends are kept first, and when the lines between are still too many to pair at once, the
  lines that stayed equal anchor the rest, and only the gaps between anchors are paired, each under its own cap of
  2,500 line pairs. Only a gap larger than that (about fifty lines changed against fifty others with nothing equal
  between them) is shown as the old lines out and the new lines in. Additions are underlined, removals struck through, with a
  status word (New, Changed, Removed) and +N/−N counts and a legend, so the diff is never read by colour alone. The
  sections compared are the title, the type, the question, the premise, the context, the detail, the terms, the
  references, where we are now, what is decided and still open, the ask, a multi-decision ask's questions, each
  option's explanation, a form's fields, the recommendation, the impact, the urgency, the steps, the cards, the body,
  the answer to a question, why it matters and how to resolve it, so a changed type (Question to Plan to Tracker) or a replaced form is never "Nothing
  changed". Sections that did not change fold
  under one line. Opening an item writes the seen mark (`PUT …/seen`) for its newest version, after the baseline is
  read, so "since you last looked" is the previous visit. A machine without the version routes shows no control.
- **The terms table** shows a link's own `meaning` (`agenda.link-meaning.1`), else its label.

## What I need from you

**Every card has one answer shape, and it says it in one place.** In the item view's seventh part, after where we
are now and the conversation ([The item view](#the-item-view)), every open card draws a segment headed **What I need
from you**. It holds exactly the ask and
ends with one plain instruction, so the owner always knows what to do. The ask itself is a short **bold line at body size** — never heading-sized, however long it is; a long ask wraps
and the card stays the card:

| Kind (`--kind`)                     | The segment shows                                   | The buttons                                            |
| ----------------------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| `choice`                            | ONE question, then each option with what it means   | the options (three on the row), recommended tagged     |
| `yesno`                             | one yes-or-no question                              | No · Yes (always: No ←, Yes →)                         |
| `permission`                        | what is being approved, and its effect (`--impact`) | Approve · Deny                                         |
| `review`                            | what to review (`--link`)                           | Approve · Request changes                              |
| `reply`, one question               | the question                                        | none: "Type your answer below."                        |
| `reply`, several questions or a mix | a numbered list of each answer wanted               | none: "Reply with your answers below, numbered."       |
| `form`                              | numbered fields, each answered where it is asked    | none: the card's fields, the reply box, one Send       |
| `todo`                              | the steps, numbered, each ticked                    | Mark as done                                           |
| `info`, and a notice                | the message                                         | Got it (quiet: a bare Got it does not wake the ferret) |

- **A button says its option's short label** ("No", "Only blockers"): never its description, never a bare letter.
  Markdown in a label is read as plain words. A label longer than 24 characters (20 on a row of three) is cut at a
  word, and the answer sent is still the whole label. A row of three counts every button drawn on it, so two answers
  beside "Done · closes" are a row of three. On a phone, a row of three gives each button a third of the width: a
  label that does not fit wraps onto a second line, between words, and the buttons grow taller to hold it; the row
  never grows wider than the screen, so only a single word wider than its whole button is split. The arrow keys'
  hints and `fy agenda list` say the same words, through one function. The options list may name long options by
  letter; the buttons never do.
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
| `yesno`                                | a No \| Yes segment                    | `Yes` or `No`                |
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
    (two options: ← and →) — wherever the recommendation sits. **Yes and No have one fixed place: No ←, Yes →**,
    whichever order the ferret listed them in and whatever its kind (`yesno`, or a two-way `choice` of Yes and No),
    as a gate is Not good ← · Done →: the forward answer on the right. The row, the docked row, a card ask's own answer,
    the deck's swipes and keys, a form's yes/no field and the CLI's `answers: ← No · → Yes` all read it from one rule
    in `@ferretry/protocol` (`yesNoOrder`);
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

### Card asks in the Inbox

Today's app draws a card ask from its mirror, `gateAttached`, as the agenda's second answer row (`attachedGateView`):
the same labels and directions as below, naming the card by its title, tap only, and every answer sent with `gate: true`.
What follows is how it draws a card at a gate. A **gate item** (read from a daemon older than card asks) is a board card
waiting on the owner at a gate, raised as an ordinary Inbox item (never for a sub-card: the owner tests its parent, and a sub-card [closes itself](board.md#sub-cards-close-themselves) instead of waiting in a verify lane) (`item.gate`: the card, its lane and what each option does):
the owner meets one stream, not a question list and a separate to-test list. It is
the card's ONE head row (the title, ‹ n/N ›, ⓘ, the snooze clock, ✕ — `CardHead`) under ONE quiet meta line: **what it is** — the **Test** chip
(a card in a verify lane; its ask reads "Try it: …") or the **Approve** chip (a plan awaiting approval; its ask reads "OK to build?") — the project, the ferret and "Open chat ›". It repeats
nothing: no summary line, no chip, no restated ask. Its body is the card's _How to test_ as numbered tick-steps, and its
options are the gate's own, laid out as every choice is (the first ←, the second ↑, the third →) and then MIRRORED left/right for a gate, so the forward option is always on the right.

- **→** is the forward option (Done, OK to build, Yes), the same as the to-test rows; **←** is **Not good**, which reopens the card with an agenda item; **↓** is Skip. The buttons read Not good (left) · Done (right).
- **Not good needs words.** Pressing it (or ←) answers nothing yet: the "why" box opens where the answer row was, and
  Send back stays disabled until something is written. The words go as the answer's note. Cancel (or Esc) changes nothing.
  The box is the chat's own composer — the same field, mic, Enter to send and Shift+Enter for a new line — with the same
  inset as the card above it, so it is exactly as wide. It is the one send-back box ([board.md](board.md#done-and-not-good)).
- On a **one-option gate** the left answer is **Not yet** — not one of `gate.options`: the card stays where it is, and words
  are welcome but not required.
- Answering is a plain choice, `{ kind: 'multiple-choice', choice: <label> }`, held in the undo window like any answer. A
  refusal (the card moved on, or the gate was not reached) shows beside the buttons, as for every answer.
- **Question items keep their sticky options and composer exactly as they were.**

**The app ships before the daemon.** A machine that advertises `board.gate-items.1` sends gate items, and the
Inbox then drops the _synthesized_ to-test rows those items replace. A machine that advertises `agenda.card-asks.1` sends the
card's ask on the card's own agenda instead, and the Inbox keeps no to-test row for that machine at all (next paragraph).
Either way the owner answers through their authority and the card moves once; the other path is withdrawn. A machine that
advertises neither keeps today's rows.

**The Inbox has no To test list on a card-asks machine.** Once a machine advertises `agenda.card-asks.1` its cards leave the Inbox's To test section, the Answer-quickly run step and the snoozed to-test rows, and out of the Inbox's count: the card's ask is an item on an agenda, and that is the one place the owner meets it. The check is per machine (`AgendaWireDirectory.cardAsksOf`), so a machine that does not advertise it keeps every row it has today, and no card waiting on the owner is lost while machines are on different versions. A person-asked
card in a gate lane **with no open gate item** keeps its to-test row even on a machine that advertises gates but not card asks, so no card
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

### The side panel's Agenda tab

The info panel (the phone's sheet and the desktop's right panel) has an **Agenda** tab after Overview. It shows the
ferret's **lineage** — its agenda home is the lineage root ([The agenda home](#the-agenda-home)), where its sub-ferrets'
items live, so a lead's panel shows its sub-ferrets' items too — in four filters:

| Filter        | Rows                                          | Order                                                                       |
| ------------- | --------------------------------------------- | --------------------------------------------------------------------------- |
| **Needs you** | items waiting on the owner (`needsYouQueue`)  | blockers first, then by when each started needing the owner; each item once |
| **Resting**   | items resting, not snoozed (`restingQueue`)   | waiting on the ferret first, then the ferret working                        |
| **Snoozed**   | items snoozed (`restingQueue`'s snoozed tail) | by wake time                                                                |
| **Resolved**  | items that were answered or closed            | newest first                                                                |

Each filter's count **is the length of its row list** — read off the list, never computed beside it. A plain
notification is read, never answered, so it is on none of the four. A row shows the title, a **state chip** (Needs you ·
Resting · waiting on <ferret> · Resting · working · Snoozed until <time> · Done), a **stage chip** (Explainer, Question,
Plan to approve, Tracker, Test; a resolved row shows the last stage it had) and its age. Opening a row opens
`AgendaItemView`, the same view the Inbox and the chat show. The tab is the pure model `agendaTabModel`
(`lib/agenda-tab.ts`), drawn by `features/agenda/agenda-tab.tsx`.

**Overview** keeps one line — "2 need you · 1 resting · 0 snoozed · 5 resolved" — with an **Open Agenda** button into the
tab, so the two cannot disagree. The tab is hidden while the agenda has nothing on it and agenda mode is off.

The task panel has no Cards view: the Tasks tab is **Kanban** or **List** (List by default). A card's ask is an item on an
agenda, so it appears here and in the Inbox, and a card swipes as a gate item does (**→ Done**, **← Not good**,
**↓ Skip**) wherever its ask is drawn.

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
   item goes **back to the owner as an open card**. A done or dismiss reopens the closed item; an answer that
   rested a ferret's item brings it back from resting (each answer is its own delivery, keyed by the item's request
   counter, `A5~2`, so a second answer after the ferret replied is told too); a Discuss or request for more
   information ends that wait. The item carries
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

### The channel (`agenda.channel.1`)

A daemon that rests items on an answer and takes the channel's requests reports `agenda.channel.1` on
`GET /v1/health`; one that also takes [editable asks](#editable-asks) reports `agenda.asks.1`. Every new item field
(`resting`, `stage`, `stages`, `ownerAnswer`, `askVersion`, `whereWeAre`, `detail`) is optional, so an app or CLI from
before reads every item. The request fields are refused as malformed by a daemon without their feature, so the CLI
checks it first and says the daemon needs an update: `stage`, `whereWeAre`, `detail` and the `rest` action need
`agenda.channel.1`; an edit's `ask`/`kind`/`answers`, `clear: ['questionAnswer']` and an answer's `askVersion` need
`agenda.asks.1`; so does a Done or Skip's `askVersion`; a link's `meaning` needs `agenda.link-meaning.1`. An older app that sends no `askVersion` is refused only for an
answer to a replaced ask (see
[Editable asks](#editable-asks)). `fy agenda answer` sends the edit every daemon takes (`questionAnswer`): an older one brings the
item back fresh instead of in its old place.

### An older app keeps reading the board

An app from before the channel parses a **whole** board with its own schema, so one item it cannot read makes the board
unreadable. Its limits were smaller (a point-form segment 1,024, the context and every note 2,048, a step 2,000, a body
8,000), and its revisions and history entries are strict, so an edit of `whereWeAre` or `detail` or a `response` on a
history entry is a key it refuses. A daemon therefore serves the items in two shapes, chosen by the **request header
`x-fy-agenda-channel: 1`** (the same version as `agenda.channel.1` on `GET /v1/health`):

- **With the header** — the whole shape, exactly as stored. The CLI and current PWA send it on agenda requests,
  including snapshot reads, actions, Send now and every roll-up page. Older daemons ignore the header (it is already
  allowed by the daemon's CORS preflight).
- **Without it** — the **legacy projection** (`legacyAgendaSnapshot`, in `@ferretry/protocol`): the same items, with
  every widened field cut to the older bound (ending in `…`), the channel-only keys (`resting`, `ownerAnswer`, `stage`,
  `stages`, `whereWeAre`, `detail`), a link's `meaning` (`links[].meaning`, also in a revision's `previous`) and the `response` of a history entry left out, and a revision that only changed a
  field the older app does not know dropped. The projection is a view: it is never written back, so nothing is lost on
  the machine. It covers the board, Send now, the roll-up of every conversation and the machine agenda, including
  `questionAnswer`, revision `previous` values and nested undelivered responses and notes. If an older app retries
  the exact clipped reply it received, the ledger transition restores the stored full reply before applying it;
  a legacy view never replaces the owner's words with a shortened answer.

### The conversation (`agenda.conversation.1`)

A daemon that stores the conversation, takes `log`, `merge` and `split`, and keeps versions reports
`agenda.conversation.1` on `GET /v1/health`. Every new item field (`conversation`, `mergedFrom`, `mergedInto`,
`splitFrom`, `splitInto`, `relatedTasks`) is optional, and the version routes are new, so an app or CLI from before
reads every item; the CLI checks the feature first and says the daemon needs an update. The app ships before the daemon:
an app talking to a daemon without the feature still reconstructs the conversation from session transcripts
(`item-conversation.ts`) and shows no diff or merge control.

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
- **The ledger says its shape** (`version`, 4 since stored conversations): it is read as 1 when absent and brought to
  4 as it is read ([the channel migration](#the-migration-ledger-version-2) and [the conversation
  migration](#the-conversation)).
- **Downgrading** goes to the previous release (the rollback target, "2a"). It reads a version-4 file as version 2
  and keeps the `version` and the `archive` cursor, but drops everything it does not know on its next write: the
  `conversations` map, `carriedEntries`, each item's `conversation`, `conversationCount` and `conversationLastAt`,
  `relatedTasks`, and the merge and split links (`mergedFrom`, `mergedInto`, `splitFrom`, `splitInto`). It also
  ignores `agenda-versions/` and `agenda-versions.pending.json`. What it keeps writing — owner replies in each
  item's history, owner-history lines in the sidecar under its cursor — is read back on the way up.
- **Coming back up** loses no owner word and repeats none (the declared limits below say where this stops). Each item resumes from its **latest recorded version**
  in the version store, which holds the whole tagged thread (verbatim, in order, chat tags included, and chat text
  over the history bound too) and the links 2a stripped, so merges, splits and related cards return. Only what the
  item's history says was said after that version is added, once, after the thread; a word already in the thread
  (same chat message, or same time, speaker and text) is never added again, and a second read finds nothing new.
  The ferret's answer to the owner's question has no time of its own: it is dated by the latest edit that changed it
  (2a keeps those edits), so an answer given on 2a comes after the owner words it answers, and never before the version's own time whenever that
  version's thread holds any words, even when the edit that dated the answer has since left the revisions. An
  item with no recorded version is seeded from its history and the sidecar only. Owner history that rejoining the
  thread makes fit under the item bound is queued to the sidecar first, so 2a dropping its copy loses nothing.
- **Declared limits.** An item with no versions is seeded from history only, so chat text over 64,000 characters is
  verbatim only where a version exists. A set-aside intent's versions are voided as above, but only while they are the
  item's latest; a version a later change recorded on top of one is kept. A set-aside intent whose changes did reach the
  file 2a wrote is not voided at all (see Versions), judged from marks that are present in the file; if 2a rewrote the
  item so that no mark survives, those versions are voided although the change committed, and the item reads from its
  earlier version. The ferret's answer is dated by the edit that wrote it, which
  lives among the 10 revisions an item keeps: once more than ten later edits push it out, the answer is dated by the
  ferret's last update instead.
  A `agenda-seen.json` that cannot be understood is set aside as `agenda-seen.json.corrupt-<id>` with a warning and the
  marks start empty (they are display hints); one that cannot be read at all still refuses a mark. A ledger that reads as version 1 with no cursor (an older
  rewrite) is upgraded by adopting the sidecar's complete lines as committed history up to any mark ([a ledger with
  no cursor](#no-size-limit)). An uncommitted tail a later commit outlived (it lifted the mark, and its cursor went
  with the downgrade) is adopted too, and a crash between a commit and the lifting of its mark, followed by a
  downgrade before that session's next write, leaves that last append out.
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
