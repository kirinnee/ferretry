# Agenda

The agenda is what the owner has to decide or do, and what each item blocks. It replaces "Attention"
as the name of the feature (`fy attention …` still works, deprecated). A plain notification with
nothing to decide is a **notice**, not an agenda item (see [Notices](#notices)).

**An agenda is one channel of the owner's attention** ([One channel per topic](#one-channel-per-topic)): a ferret
opens one only for what the owner alone can give — information, a decision or an action — and only when no open
agenda passes the three-part test; otherwise it adds to the closest. It never opens one just to track or check its
own work: no "please test X", "please verify Y" or "try it after the release". Testing a card goes through the card's own agenda — the board
runs itself and a card never asks (the owner, 2026-11-04: _"TASK no longer have user interactivity anymore! agenda
tracks all those and are the one request user to test so it can move it"_): a finished card reaches its Released or
Ready to try lane, the daemon asks on the topic's agenda item, and the owner's **Good** (Done) or typed **Not good** there
moves the card ([One model](#one-model-the-agenda-asks-the-card-shows)) ([board.md](board.md#cards-show-progress-their-asks-ride-the-agenda)). The ferret's instruction says all of this (`AGENDA_INSTRUCTION`,
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

## One model: the agenda asks, the card shows

**The one rule** (the owner, 2026-11-02 to 2026-11-06: _"TASK no longer have user interactivity anymore! agenda tracks
all those"_, _"how many times I said cards have no actions"_). Every other section, screen and prompt line follows it:

- **The agenda item is the only place the owner acts.** It has ONE "What I need from you" and ITS OWN answers: one
  row of buttons, or words typed below, never both said twice.
- **A card is read-only status.** It is never the one asking. No screen the owner sees heads a box "Card &F12", says
  "your answer for the card" or "card ask", or draws a second answer row for a card. The card may be named once, as a
  plain reference line ("For &F12 Badge colour").
- **Answering an item may move its linked cards.** That is the daemon's bookkeeping, invisible to the owner: the
  item's Done is what moves a tried card to Closed, its Not good sends it back with the owner's words.
- **The daemon asks only when there is something to ask** ([Try it only when there is something to try](#try-it-only-when-there-is-something-to-try)),
  and only on the topic's existing item, never a new item per stage.

**Words the owner sees** (and the only ones):

| Word            | Means                                                                       |
| --------------- | --------------------------------------------------------------------------- |
| **agenda item** | one thing the owner decides or does, with its own answers (`!A12`)          |
| **card**        | one piece of work on the board, and where it stands (`&F12`); it never asks |
| **ask**         | what an agenda item needs from the owner: its "What I need from you"        |
| **try-it**      | an ask to try something that shipped, answered Done or Not good             |

"Card ask", "gate" and "lane" are the daemon's words for its bookkeeping (below, and in [board.md](board.md)); they
never reach an owner-facing string. `scripts/validate/owner-surface-words.sh` fails the build on exactly these shapes
in a string a screen can show (comments and identifiers are not read): "card ask", "your answer for the card", a
"Card &F12:" heading, the card narrated as the one acting ("the card goes back", "the card stays"), the board's engine
words ("is the gate of", "at the gate", "the card's lane", "in the lane"), and narration of a second ask to come ("it is
asked here"). A new shape is added to its list with a test the day it is seen on a screen.

**Superseded.** From 2026-10-30 to 2026-11-01 the owner asked for Done / Not good buttons on cards ("embed button to
immediately mark a task as done", the Inbox's cards to test, "stage can have request user options"). The rule of
2026-11-02 replaces those asks: anything built for them answers on the agenda item, as the item's own ask, or goes.

## Try it only when there is something to try

At a try-it stage (the stage whose answers include **Not good**; the plan stage, "OK to build", is not touched) the
daemon decides one of three things, in one pure function (`tryItVerdict`, `gate-policy.ts`). It looks in this order:

1. **Wait.** The card is blocked: a dependency is still open, or a ferret blocked it by hand. Nothing is asked, nothing
   closes, the card stays where it is. An ask that was already live and unanswered when the block arrived is taken
   back from the item that carried it (the card stays put); when the card is unblocked, the next look at it asks
   again as usual. The daemon looks
   at every card at a stage again on each board write and on each Warden sweep (`GateItems.sweep`), so a dependency
   that ships frees its dependants within one sweep.
   **An umbrella card waits too**: while any of its live sub-cards is still being built (a backlog, active or review
   lane), a PR linked to the umbrella itself shipping does not make it ready to try. Nothing is asked and nothing
   closes; the next look after its sub-cards ship decides again. (The owner's case, 11-06: &C50 "Split fyd.ts" got a
   try-it when a prerequisite PR linked to it was released.)
2. **Nothing to try.** Any of these:
   - the card is **private** (stored `visibility`, else the daemon's default for who asked);
   - the card is **internal work**: its kind is `chore` (a refactor, a clean-up, a migration — nothing a person sees);
   - it has **no How to test**, or its How to test **as a whole** is one complete no-testing declaration
     (`saysNothingToTry`, a closed grammar — never a list of banned verbs). The whole text, trimmed, one sentence with an
     optional final period, is a **declaration**: "Nothing to try", "Nothing to test", "Nothing for you to try|test",
     "No user-visible change", "No behaviour|behavior change" (also "No PWA|app|CLI|user-facing … behaviour change"),
     "Docs only", "Tests only" or "Docs and tests only" — in either spelling and any case. It may carry ONE **reason**
     from a closed list ("docs only", "tests only", "docs and tests only", "internal refactor", "refactor only", "CI
     only", "unit suites pass", "no user-visible change"), or a second declaration, joined by ":" ";" "," or " — "
     ("Nothing to try: docs only.", "No user-visible change; nothing to try."). **Anything else is not a no-test
     statement and the owner is asked**: any other word after a declaration ("after", "while", "when", "until", "if",
     "in", "on", "during", "should" …), a second sentence, a list, a numbered or bulleted line, a step. "No PWA change
     after toggling the setting.", "No change in scrolling after switching tabs." and "Docs only, then check the page"
     all ask. When in doubt it asks, never closes;
   - **every merged PR of the card changed only docs, design or tests**, there is at least one, and the kind of each is
     known. An unknown kind counts as code.
3. **Ask.** Anything else: exactly what the daemon always did.

**Nothing to try closes the card, with one line and no button.** The daemon moves the card from the try-it stage to
Closed, reason `Nothing to try: <why>` (for example "its PRs change only docs and tests"), and withdraws any open ask of
it. If an open agenda item already carries the card, it gets ONE plain line (`&F12: Nothing to try: …`) in its activity;
its turn, stage and place in Needs you do not change. The line is an ordinary `updated` activity entry whose note is
exactly `&F12: Nothing to try: <why>` (`nothingToTryLine` in `@ferretry/protocol` reads it), so an app can show its
words instead of "<ferret> updated it". If none does, no item is raised: the card's history is the record.
The verdict is judged **again inside the card's own write**, against the card and its dependencies as they are then: steps
or a block that arrived at the same stage entry since the first look stop the close, and nothing is written.
**The daemon never raises an agenda item to say "nothing to try".** The exception to "only the owner passes a gate" is
narrow and named in [board.md](board.md#cards-show-progress-their-asks-ride-the-agenda): the daemon only, only out of a
try-it stage, only into Closed, only while the card still sits at that stage by that entry. A ferret still cannot pass a
stage.

**What a PR changed.** The GitHub watcher reads the files of each PR in its one GraphQL query and caches the verdict on
the PR link (`PrLink.changes`: `docs-tests` or `code`; absent means not read). A PR is `docs-tests` when it has at most
100 files and every one is a doc or a test: anything under `docs/`, any `*.md` or `*.mdx`, anything under a `tests/`,
`__tests__/` or `fixtures/` folder or a package's top-level `harness/` (the `harness/` folders under `src/` are shipped code), and any `*.test.*` or `*.spec.*` file (`pr-changes.ts`). More than 100 files
is `code`. A file list that GitHub cut short or did not give leaves the kind unknown. **A kind is bound to the commit it was read
at** (`PrLink.changesRevision`: the head commit while the PR is open, the merge commit once merged): a poll that cannot
read the files keeps the kind only for that same commit, so a docs-only PR that gets code pushed, or is merged, with
its file list unreadable goes back to unknown and is asked. A merged PR is polled until it is
released, so its kind is cached before its card reaches the try-it stage; a PR that shipped before the field existed has
none, and its card is asked.

**The ask goes on the topic's existing item, never a new item per stage.** See [Card asks](#card-asks) ("Which agenda"):
before the daemon opens an item of its own, it tries the item the card was made from.

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
- **No main type: the tabs hold any kind of content** — status, to-dos, steps, instructions, explainers, results —
  one tab per kind (the owner, 2026-11-04: _"now agenda doesn't have a "main" type any more"_). **Steps and explainers
  live in the tabs and stay there** (_"make sure that steps and explainers go the body tabs and kept there!"_), after
  their ask is answered too. What the item needs from the owner right now is still recorded as its **stage**
  (explainer → question → plan → tracker → test, [below](#stage-the-tabs-and-the-detail)), but the prompt no longer
  teaches it as the item's type.
- **Always current: read, then patch.** Every update reads the item whole first (`fy agenda show <id> --yaml`, with
  its revision), rewrites every part that is out of date — premise, context, the ask (what the owner is asked for),
  its options and how to reply, still-open and each tab — and writes it back as one patch
  ([Patch](#patch-the-item-as-one-document)), refused if the item moved on since the read (_"updating agenda should be read => edit, not just patch"_, _"make sure
  the chat ALWAYS update their asks, their body? they should ALWAYS check such that the asks, follow up, and all the
  different documents are updated."_); the chat only points at it.
- **Explainers are ADHD-friendly**, walked through with hypermedia the reader drives, with an example for each point
  ([hypermedia.md](hypermedia.md#the-injected-instruction)).
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
  then the agenda opens. `--new` always takes its reason; a bare or blank one is refused.
- **At a terminal** the question is asked ("Should this join !A7? [y/N]"). Only `y` joins (the edit is printed and
  nothing is opened). Enter, `n` or anything else opens nothing either: the two ways out are printed, and a new
  agenda needs `--new "<why>"`.

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
field, so the item is raised without it and the CLI says so. A to-do is `--todo`, and its kind is
named `--kind todo` — "task" means a board card. The wire value stays `task`, so a released daemon keeps accepting
the add.

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
- **The button is offered** for an item with a linked card of that machine that asked for it. The CLI sends
  `offerClose` only to a daemon that reports `agenda.offer-close.1` on `GET /v1/health`; to an older one it raises the item without and says so.

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
- **Which agenda.** In this order: the open agenda that carries the card (it is about the card, or carries one of its
  asks); the one that carries its parent card; **the card's topic item** — the item the card was made from, which is
  `task.approval` when the card has one, else the first `!A<n>` its ask's `source` names — when that item is open on one
  of the card's agenda homes and can carry an ask; and only then ONE new agenda the daemon opens on the card's ferret's
  home, named after the card, raised on that ferret's behalf (`sourceRef` `card-agenda:<card>`), stage `test` or `plan`.
  That agenda's own ask is only a reply; the ferret works and closes it as its own. This holds at both stages, OK to build
  and try-it. Whether a try-it is asked at all is [Try it only when there is something to try](#try-it-only-when-there-is-something-to-try).
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
  it, and the ferret marks it done once nothing more is expected. **Unless the item still asks something of its own**,
  with no `ownerAnswer`: a choice, yes/no, permission, task or review, or a question it asks in its own words beside
  its card asks. Then it stays, or goes back to, the owner's turn in Needs you, and only their answer (or reply) to it
  rests it. **One rule decides "asks something of its own", and the app reads the same one** (`itemAsksOwnQuestion` in
  `@ferretry/protocol`): the item has questions, form fields or steps, or its ask line (its subject) is neither the
  daemon's generated card agenda ask nor a line that only repeats one of its card asks. So a ferret's thread whose
  subject is a question ("Should the badge also change keyboard focus?") stays in Needs you after Good; a thread whose
  line only repeats the card ask ("Try it: <the card's title or one whole step of its How to test>",
  `askLineRepeatsCardAsk`) and the daemon-opened card agenda **while its ask is still the one the daemon generated**
  rest as always.
  - **"Still the one the daemon generated"** (`isGeneratedCardAgendaAsk`) is read from a stored fact, never from the
    revisions (they keep only the newest 10, so a ferret's rewrite would age out): every time the daemon raises,
    restates or carries over a card agenda it records the subject it wrote as `generatedSubject` (daemon-only; an app
    that predates it drops it). The ask is the daemon's while it is an open question with no questions, fields or
    steps and its subject still equals `generatedSubject`; once a ferret or the owner rewrites the subject — in any
    words, "Try it: …" included — it is the item's own question.
  - **A card agenda from before `generatedSubject`** is read conservatively by its words: its ask is the daemon's only
    while its subject provably repeats one of the card asks it carries or carried — the lane's own words ("Try it:",
    "OK to build?") and nothing but the card's title or one step of its How to test. A lane opening alone never hides a
    question ("Try it: Badge. Should keyboard focus change too?" is the ferret's). One whose daemon-written subject said
    more (the card's summary) reads as the item's own until the daemon next restates it and records `generatedSubject`.
  - **A reply in words answers the open question it was given to.** An ordinary reply (or a chat message logged on the
    item) sets no `ownerAnswer`, so the daemon records `ownAskRepliedTo` (daemon-only): a digest of the item's own
    ask as it stood — its ask line, questions, fields, steps, ask and ask version. While the ask still digests to it, the
    question is answered, so a card ask's Good rests the item, whether the reply came while that card ask waited or
    before it was put. Carrying the item to another agenda (the home migration) carries the digest and the ask version it
    was taken at with it, so an answered question stays answered there. Once a ferret rewords the question, adds to it or re-asks it, it no longer matches: no earlier
    reply ever answers a NEW question, which stays in Needs you after the card ask's Good. A choice, yes/no,
    permission, task or review still takes its own answer.
  - **The next ask takes over, in the same item.** "Does the item still wait on its own question?" is ONE function both
    ends read, `awaitsOwnAnswer` (`@ferretry/protocol`; it reads `ownerAnswer` and the `ownAskRepliedTo` digest, `ownAskDigest`,
    computed the same way on the daemon and in the app). While it holds, the question is the item's one ask and a try-it
    waits behind it as one "Next" line. The moment it stops holding — a permission the owner already approved, a reply to the
    question, a choice taken — the card's try-it is the item's ask: Good / Not good are drawn, the old question and its buttons are not,
    and the item says "Test" in the list and in the open item. So a topic whose feature reaches Released AFTER the owner
    answered it asks the try-it, not the old question again. **Answering the question never parks an item whose try-it still
    waits** (a reply, or a tap on its own buttons): the item stays in Needs you with the try-it as its ask, and rests
    only on the try-it's answer (or when the owner has said Not yet to it). If the try-it goes away first (the card moved
    on), the item rests on the answer the owner already gave.
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
- **An older app** reads `gateAttached`: the daemon mirrors there, on every write, the gate of the FIRST card ask in
  the order they are asked (`askedCardAsks` in `@ferretry/protocol`, the one order the app draws too): every ask still
  waiting for an answer, as they were put on; then the ones the owner said Not yet to, the one set aside longest ago
  first. So an app that predates card asks still draws Done / Not good on the agenda, and answers it with `gate: true`
  and no `cardAsk`. Such an answer is to the ask the mirror shows: a Not yet moves the mirror on to the next ask (which
  stamps `gateAttachedChangedAt`, below), so a deferred approval never traps an older app, and its next Not yet sets
  that one aside rather than the first again. The app sends `cardAsk` from this version on, naming the ask it
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

### Stage, the tabs, and the detail

- **`stage`** is what the item needs from the owner right now — `explainer`, `question`, `plan`, `tracker`, `test`,
  then `done` — separate from its state (a question can rest; a tracker can need the owner). A ferret sets it with
  `--stage` on `add` and `edit`; without one it is read from the kind (`agendaStageOfKind`: info is an explainer, a
  permission or review a plan, a to-do a test, the rest a question).
  Every stage the item entered is kept, oldest first, in `stages` (at most 64); closing it adds `done`.
- **THE TABS ARE THE ITEM'S LIVE DOCUMENT (&F923).** The owner: _"allow agenda's body to have TABS so they can
  create things like (overview, status, decisions) etc, like files that need to be updated"_, and _"where we are at
  now should be a tab -- the main tab. so it doesnt have to be constrained into a limited segment, and can be as
  expressive too"_. The protocol owns the order (`agendaTabs`); the app, the CLI and the Changes diff read it there:
  1. **"Where we are now" — the main tab**, always first and open by default; its name is fixed and it is never
     renamed, moved or removed. It holds, in this order: the ferret's **answer to the owner's question**
     (`questionAnswer`), **decided so far** (`decided`), **still open** (`stillOpen`), then **`whereWeAre`** — full
     Markdown with fy-render, as long and as rich as it needs to be (200,000), no longer a short status. A ferret
     writes it whole with `--where-file <file>` (`-` reads stdin), or as points with `--where` (repeat); both together
     are refused.
  2. **"The full picture"** (a review's **"Reasoning"**) — `body` (`--body-file`): the report, explainer or plan.
     It is unchanged: the gate's How to test, a notice's card and older apps all keep reading `body`. A notice draws
     it in its ask and a card gate's body is its How to test, so for those it is not a tab.
  3. **The ferret's own tabs** — `tabs: [{ id, name, body }]`, at most 6 (8 tabs in all): one per KIND of content
     (the rule below). `--tab-file "Name=file"` makes or rewrites one; `--rename-tab "Old=New"`,
     `--move-tab "Name=1"` (1 = first of the ferret's own) and `--remove-tab Name`. All of them, in one `edit`, are
     **one edit: one version, one revision** (`tabEdits`, at most 16, applied in order). A tab's `id` is its name's
     slug at creation and stays through renames. A name is 1–32 characters on one line, with no `=`, unique ignoring
     case, never a fixed tab's (nor `main` or `body`), and never another tab's id, so a name or an id always means one
     tab: a reference is read as a name first (ignoring case), then as an id. Their words share 200,000
     (`MAX_AGENDA_TABS_LENGTH`).
  - **SPLIT BY CONTENT TYPE, NEVER SERIAL CONTENT (&F946).** The owner: _"the "full picture", I think should not be
    cramped into 1 tab … ask the agenda what's the best way to breakup the topic. don't split serial stuff tho, split
    by content type, unless there's no serial dependency. for example, a long continuous report should STILL be 1 tab.
    but steps, tracking, status etc or different type of results or wtv etc can be different tabs"_. So: - **Where we are now stays the main tab.** - **Each kind of content is a tab of the ferret's own, named for what it holds**: the work's Steps, Status,
    Tracking, Results, Decisions, Risks, a second kind of result. - **Serial content is never split**: a long continuous report, explainer or argument, where each part builds on
    the last, stays ONE tab, "The full picture". Only parts with no serial dependency on each other are split. - **One kind of content is one tab**: a ferret never invents tabs to fill the row. - **With everything in tabs of its own, the body may stay empty** (an empty tab is not drawn). - **The daemon hints, never refuses**: `add` and `edit` print "the body has N sections in M characters: if they
    are different kinds (steps, status, results…), give each its own tab with `agenda edit <id> --tab-file
"Name=file"`; keep a continuous report, where each part builds on the last, as one tab" when the body is over
    4,000 characters with 3 or more top-level (`#` or `##`) headings outside fenced code
    (`AGENDA_MIXED_BODY_LENGTH`, `AGENDA_MIXED_BODY_SECTIONS`). Only the ferret knows whether its sections build on
    each other, so the decision stays its own.
  - **A tab with nothing in it is not drawn, and one tab draws no tab row**: an item with only a body reads as before.
  - **The brief previews the main tab**: the detail panel and the board's brief draw decided so far, still open, then
    **Where we are now** (`whereWeAre`), and one line **Also in the item: Decisions, Risks** naming the ferret's own
    tabs, so the brief never hides that the item holds more.
  - `fy agenda show <id> --tab <main|body|name>` prints one tab exactly as written, so a ferret can change it and write
    it back whole; `show` lists the tabs, `show --json` gives `whereWeAre`, `body` and `tabs` as stored.
  - The owner's model: _"the chat is the stream of log, the body is the DB, like an event store."_ So:
  - **The ferret rewrites a tab whole whenever it changes**, so the tabs always hold the whole current state; they
    are what the item's versions keep and what the Changes diff compares first.
  - **The conversation is only the log.** The ferret answers there briefly and points at the tabs; it never retypes
    a tab into the conversation.
  - **Explainer mode by default, in hypermedia**: fy-render charts, mermaid, an interactive `html` visual the reader changes (never a stepper), and `card` and
    `board` blocks for status. **Plain Markdown draws no fold** — raw HTML in prose stays inert — so a long part is
    folded inside an fy-render `html` block (`<details><summary>…</summary>…</details>`), whose contents are HTML.
    **GAP:** a fold written in Markdown (for example a fenced or directive fold block) is not built; it would take a
    remark plugin that turns that block into a `<details>` the agenda segment renders, with its own tests.
  - `fy agenda --help`, `add --help` and `edit --help` say this whole (`AGENDA_BODY_RULE`); the Agenda-mode prompt
    says it in short.
- **`detail`** (`--detail`) is the context explained from zero, for a reader new to the topic; the app draws it
  folded away.

The app draws them in the item view ([The item view](#the-item-view)): the stage on the head's chip, the tabs under
what the item needs from the owner (the main tab open), the detail folded, and every earlier stage in the folded
activity log.

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
  action is created, keeps it through the undo window and the outbox, and sends it with the dispatch.
  The CLI names none, so its answers are checked only as below.
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

### Patch: the item as one document

The owner: _"can you make it such that they modify agendas and tasks as YAML or JSON as patched?"_ (&F957),
_"make sure the WHOLE agenda … body, premise, context, current state, all tabs (todo, reports, explainers etc) and
what I need from you, the options and how to reply are ALL updated correctly"_, and _"updating agenda should be read
=> edit, not just patch. we need to read to know what needs to be updated, else there might be many segments that
might be outdated!"_. So an update is **read the whole item, update every part that is out of date, write it back as
one patch** — and the read is enforced, not only taught.

```sh
fy agenda show A5 --yaml > a5.yaml   # the whole editable document, with the item's revision
$EDITOR a5.yaml                      # update every part that is out of date
fy agenda patch A5 --file a5.yaml    # one atomic edit; --file - reads stdin; JSON works too
```

- **READ BEFORE WRITE: the revision is required.** `show --yaml` prints `revision:` first: a fingerprint of what
  the item says now (`agendaItemRevision`, owned by the protocol so the CLI and the daemon compute it alike). It
  covers every field the document holds, the ask's version (`askVersion`), the stage and the owner's latest answer
  (`ownerAnswer`), so the owner answering, the ask being replaced, or anybody rewriting any part moves it on. A patch
  without it is refused before anything is sent; a patch whose revision is not the item's is refused `stale` (409) —
  by the CLI against the item it just read, and by the daemon against the item as stored at the moment of the
  write, so a change that lands in between is never overwritten unseen. The answer is always the same: read it
  again, update what is out of date, patch it back. The revision is a concurrency check, not a credential: it is
  derived from words the reader already holds and proves nothing about who may write.
  **GAP:** the owner's chat in the conversation that has not become an answer (`ownerAnswer`) does not move the
  revision; and `fy agenda edit`'s single-field flags still write without one (they change one named field on
  purpose) — the teaching points every whole-item update at `show --yaml` → `patch`.
- **Semantics: JSON Merge Patch (RFC 7386), one level deep.** A key that is present replaces that field; a key
  that is absent leaves it alone; `null` removes it. `tabs` is the one map that merges by key: each **tab is
  addressed by its name** (or id, as `--tab-file` reads it): a name with Markdown makes or rewrites that tab, a name
  with `null` removes it. Every other value — a list (`decided`, `links`, `steps`, `questions`…) or an object
  (`recommendation`, `ask`) — is **replaced whole**, never merged: each is one small value a ferret rewrites as a
  unit, and merging inside a list has no stable key. A point list (`premise`, `context`, `decided`, `stillOpen`,
  `impact`) may be a list of plain lines or one Markdown string, as `--premise` and `--json-file` take it.
  New tabs go after the existing ones, in the patch's order; a rename or a move is `edit --rename-tab` /
  `--move-tab`, because a patch's key IS the name.
- **One patch is one edit.** The CLI parses the document (zod, `AgendaPatchSchema` in the protocol), compares it with
  the item as it stands, and sends ONE `edit` request carrying only what differs and the revision — the same action,
  route, validation, read-cold lint, governance (an agent edits only an item it raised; a sub-ferret raises and edits
  nothing) and hand-back rules as `edit`. So it is all or nothing: one version, one revision, or a refusal and no
  change. There is deliberately **no second write route**: a second path would be a second set of rules to keep
  equal.
- **Unchanged values are not sent.** A document written back as it was read changes nothing and sends nothing
  (`nothing changed`). This matters for the ask: `kind`, `ask`, `answers`, `fields` and the options of
  `questions` replace the ask only when they **differ** from the item's ([Editable asks](#editable-asks)), so a
  round-trip never re-asks the owner by accident. When the ask does change, the values it depends on
  (`questions`, `optionDetails`, `fields`, `steps`) that the document still gives are re-sent too, because the
  daemon drops whatever a replacing edit does not give again.
- **What the document holds — every part the owner reads that a ferret writes.** `revision`, `title`, `summary` (the
  one-line ask), **`why`** (the line saying why it is asked) and **`howToResolve`** (how the owner resolves it) — both
  editable since `agenda.patch.1`, so a line written for the item's first ask can follow the ask it carries now —
  `stage`, `premise`, `context`, `decided`, `stillOpen`, `terms`, `questions`, `recommendation`, `optionDetails`,
  `impact`, `urgency`, `blockingNow`, `willBlock`, `neededBy` (ISO, `in 3h` or `17:00`, as `--by`), `links`, `steps`,
  `questionAnswer`, `whereWeAre` (the main tab), `body` (the full picture), `tabs` (name → Markdown), `detail`, and
  the ask itself (`kind`, `ask`, `answers`, `fields`). `show --yaml` prints every one the item has, multi-line Markdown
  as YAML block text.
- **What stays fixed, and why.** The conversation and history (the log of what was said: only `answer`, `log` and the
  owner add to it), the owner's answer, the state, stage history, versions, the card asks a card carries (the card's,
  not the ferret's), who raised it and when, the source and the card it belongs to. They are records of what
  happened or belong to someone else, so no patch rewrites them; `show` prints them.
- **Unknown and read-only keys are refused**, each by name, with the keys a patch takes: a typo never silently does
  nothing. Every problem is said per field (`tabs.Status: a tab's words are 1 to 200,000 characters`), all at once.
- **What `null` may remove**: `decided`, `stillOpen`, `terms`, `recommendation`, `optionDetails`, `impact`,
  `urgency`, `blockingNow` (or `false`), `willBlock`, `neededBy`, `links`, `questionAnswer`, `whereWeAre`, `body`,
  `detail`, and any tab. It never removes `title`, `summary`, `why`, `howToResolve`, `premise` or `context` — a cold
  reader starts from them, so they are rewritten, never dropped — nor the ask's shape (`kind`, `ask`, `answers`,
  `questions`, `fields`, `steps`): a new ask replaces it.
- **It needs a daemon that reports `agenda.patch.1`**, which takes the edit's `revision`, `why` and `howToResolve` and
  widens its `clear` list; an older daemon is named before anything is sent (`fy daemon update`).
- **Never a secret.** The document has no token, digest or credential field and refuses unknown keys, so a patch
  cannot carry one; the read-cold lint still flags what a cold reader cannot follow.
- `--now` is a flag, as on `edit`: it wakes an item the owner snoozed.

An example — rewrite the main tab and the Status tab, drop the Risks tab, record a decision, and ask anew:

```yaml
revision: 1x9k2m3q0a7b
summary: Ship the patch command this week?
why: The command is built and reviewed; shipping it needs your yes.
whereWeAre: |
  ## Where we are now
  The patch command is built and reviewed; CI is green.
decided:
  - JSON Merge Patch, tabs by name
stillOpen: null
tabs:
  Status: |
    - Now: waiting for the merge
    - Next: teach it in the prompt
  Risks: null
kind: yesno
```

### No size limit

There is no size limit a reader meets: **an item may weigh up to a transport bound of 1,000,000 characters of
JSON** (`MAX_AGENDA_ITEM_LENGTH`), and each field keeps its own explicit bound under it — the body, the main tab
(`whereWeAre`), the detail and an answer to the owner's question 200,000; the ferret's own tabs 200,000 together
(6 at most, a name 32); the context and every reply or answer of the owner's
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
fields. **A chat reply is not a turn at all: it rests the item** (stored as `parked: replied`; see "Parked items").

## Handing it back

On the ferret's turn there are a few ways out. An item RESTING on the owner's reply or answer (see [States](#states))
is off their list: a plain `edit` updates the card and leaves it resting, `fy agenda answer` brings it back to its old
place, and a bare `surface` is refused there. **None of them pings the owner.**

- `fy agenda answer <id> "<text>"` — answer the owner on it: it is theirs again, in its old place.
- `fy agenda edit <id> …` — change the card (settled answers, what is still open, its stage). Any edit by the raising agent on its own turn for more information hands the item back to the owner,
  even one that changes nothing. (Not an item resting on a reply: that edit keeps it resting, unless it answers on
  it.)
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
the item view draws the stored thread (see [The item view](#the-item-view)).
`agenda.conversation.1` stays the health flag the CLI checks, and the new fields are optional.

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

In the app, an open plain conversation offers **Merge with…** in the item's ⋯ menu; it opens the picker under the head, by the lineage lines. The picker asks "Merge this item with
which open agenda?" and lists the other open plain conversations on the same board by id and title, each title once.
A confirm step says what will happen before anything is sent, and repeats no title (the picker just showed it): the
heading "Merge !A2 into this item?" (the `!A2` is a reference, opened as in a message), one line, "!A2 closes; this item
keeps its ask. Both conversations and all cards are kept.", and the checkbox "Keep !A2 instead". The viewed item
survives by default, and the checkbox flips it ("Merge this item into !A2?", "This item closes; !A2 keeps its ask. …").
The choices sit in the fixed order: Cancel on the left, **Merge** on the right; Cancel leaves the panel, and the
picker is reopened from ⋯ with **Merge with…**. There is no grant to gate on: the daemon decides by who acts, so the app offers the button
only when the host can send a merge and the item is an open plain
conversation, and a refusal from the daemon is shown in the panel in the daemon's own words. A merged item shows
**Merged into !A2 (its title)** as a link, and the survivor shows **Merged in from !A5 (its title)**. A merged-away agenda is closed, so
its title is read from the board's resolved records as well as its open items. An Inbox card that says it merged
another in, whose conversation board this device does not yet hold (only the machine's roll-up, which lists open items
alone), reads that one board once, so the title appears; until it lands, or if that read fails (it is tried again), the
line names the bare id. A machine with no merge never shows the
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
  agenda rests on its ferret. "Nothing but" is the one own-question rule above (`itemAsksOwnQuestion` and the reply
  digest): an item with a question of its own the owner has not answered — one its ferret added or reworded after the ask
  was attached — stays in Needs you, and so does a thread anybody has written on since the ask (the seal, as for
  withdrawing an ask).
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
- **The daemon still takes `--back`** from an older CLI: a `--back` with the whole card refreshed (`--summary`, `--premise`, `--context`)
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
4 hours, tomorrow 9:00 in their own time zone, or a time they pick. In the app it is **Snooze** in the open item's ⋯ menu, and the
clock in a card-to-test's head (never a button in the answer row), and on a phone the Inbox swipe-down compass offers the same four choices (one
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
- **The app always offers it**: snooze and unsnooze go to the daemon like any other action, and whatever the
  daemon answers is shown as it said it — the app adds no "needs an update" wording of its own for a snooze.

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
    nudge to a live owner ferret is unchanged. It carries `cards` (below), and an app that draws them answers the notice
    as **ONE form** ([One model](#one-model-the-agenda-asks-the-card-shows), &B165): each card is only named — its line
    and an **Open &B1** link — with one pick, **Start a ferret**, **Close it** or **Leave it** (the default), and ONE
    **Send** under them all does every pick, then answers the notice as **Got it**. There is no per-card button row and
    no second Got it, and no swipe or key answers Got it past the picks. Without the field (an older app), **Got it**
    dismisses the whole item as before.
    - **`cards`** is a structured field on an `info` item (1 to 12 rows, each `{ task: { id }, line }`, strict; refused
      on any other kind). The daemon sets it only for a machine that reports `agenda.cards.1`; an older app drops the
      unknown field and reads the same lines from the context instead, so nothing is lost. An app that draws `cards`
      hides the context, because it would say every line twice, and a lone card's line is not repeated under its own title.
    - **Open** goes to the card. **Close it** shows what it does as soon as it is picked — the card leaves the board —
      with the reason the board records, which the owner may edit, and Send drops the card with the board's own `POST /v1/board/tasks/:taskId` `{action:'drop', reason}`. The pick is the person's and nothing
      happens before Send; the drop underneath keeps the board's existing rules (`caller: any`, the planner ACL), which are
      unchanged, so a card's owner ferret or an ancestor may still drop it as before. **Start a ferret** is
      `POST /v1/board/tasks/:taskId/start` ([board.md](board.md#start-a-ferret-on-a-card)): it starts a NEW ferret on
      the card, and is the person's act only (operator minimum, `fleet` use). Each start carries its own action key
      (kept across a retry when no answer came back), so a lost response cannot start a second ferret.
    - **A card a live ferret already holds** is not offered a start: the daemon answers with that ferret
      (`started: false`); the row offers **Open its ferret’s chat**, and its line reads "… — a ferret has picked it up."
      in place of "no ferret is assigned".
    - **A refusal** is said on its card's row in the daemon's words; the notice stays open with the picks as they were,
      and the next Send only does what has not taken yet. Only when every pick took is the notice answered.
    - The work is the app's own authorized board calls, exactly as on the board page; the daemon reads no form answer.
    - There is no sentence under the notice telling the owner what the picks do; the picks say it.
  - `warden:input-stuck` — one item naming every ferret idle with a message of Ferretry's own typed in its box and
    never submitted, after the Warden's Enter did not submit it (the `input_stuck` flag,
    [message-delivery.md](message-delivery.md#b144-a-ferret-idle-behind-its-own-unsent-message)). A ferret leaves it
    once it takes a turn again; the item resolves when the list is empty.
  - `warden:inbox-stuck` — one item naming every ferret whose messages wait in Ferretry's own queue far past due,
    after the Warden's safe re-check did not move them (the `inbox_stuck` flag,
    [message-delivery.md](message-delivery.md#b148-a-ferret-whose-inbox-is-stuck)). A ferret leaves it once its queue
    is no longer stuck; the item resolves when the list is empty.
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

`fy agenda add | edit | patch | answer | rest | log | merge | split | step | show | ls | history | surface | snooze | unsnooze | done | dismiss | needs-info | discuss | send-now`

| Verb                                | Does                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `add`                               | Open an item with `--title` and its ask; `--stage`, `--where`, `--detail`. Lists open candidates; `--new "<why none fits>"` opens another. |
| `add --offer-close`                 | With `--task`: the owner may close the card with the same tap that resolves it.                                                            |
| `add --task <card>`                 | Refused for an agent when the card is already asking the owner ([One ask per thing](#one-ask-per-thing)).                                  |
| `edit <id>`                         | Rewrite the card, its stage, `--where`, `--detail`; on the ferret's turn hands it back. A resting one stays.                               |
| `edit <id> --kind <kind>`           | Replace the ask (with `--option` / `--question`): it asks again, fresh ([Editable asks](#editable-asks)).                                  |
| `patch <id> --file <f\|->`          | Change the item as ONE YAML or JSON document (merge patch; tabs by name): one atomic edit ([Patch](#patch-the-item-as-one-document)).      |
| `edit <id> --clear-question-answer` | Take a stale answer to the owner's question off the item.                                                                                  |
| `answer <id> "<text>"`              | Answer the owner on it; a resting item goes back to their list in its old place.                                                           |
| `rest <id> --why "<what>"`          | Take it on without asking anything: Resting, working, quiet, never nudged.                                                                 |
| `log <id> --reply\|--rest`          | Copy the owner's chat words onto the item verbatim, then answer or rest ([`fy agenda log`](#fy-agenda-log)).                               |
| `merge <into> <from>`               | Merge `<from>` into `<into>`: one conversation, every card kept ([Merge](#merge)).                                                         |
| `split <id> …`                      | Split a new item off `<id>`, linked both ways ([Split](#split)).                                                                           |
| `surface <id>`                      | Hand it back to the owner, unchanged (silent). Refused for a resting item.                                                                 |
| `snooze <id>`                       | The owner's: put it away `--for 4h` or `--until 17:00`; it comes back fresh.                                                               |
| `unsnooze <id>`                     | The owner's: bring a snoozed or resting item back to the list now.                                                                         |
| `done <id>`                         | Close it, optionally answering its ask (`--choice`, `--yes`, `--other`…). Quiet on a resting item.                                         |
| `dismiss <id>`                      | Close without answering; agents only their own. Quiet on a resting item.                                                                   |
| `ls` / `show`                       | Open items with their stage, turn, how long each has rested, and blocking fields / one item in full.                                       |
| `show <id> --yaml`                  | The editable document `patch` takes back: every field a ferret may change, tabs as name → Markdown.                                        |
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
title-like line (about 80 characters at most, `AGENDA_ASK_TARGET_LENGTH`; the detail goes in the body, `--body-file`), the premise, context and what is decided or still open as short bullets, every term of art
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

**A body over 200,000 characters is refused, never trimmed.** `body`, `questionAnswer` (`--question-answer`), `whereWeAre` and `detail` take at most `MAX_AGENDA_BODY_LENGTH`, `MAX_AGENDA_WHERE_LENGTH` and `MAX_AGENDA_FOLDED_DETAIL_LENGTH` (200,000 each), and a step at most `MAX_AGENDA_STEP_LENGTH` (16,000); the ferret's own tabs (&F923) at most `MAX_AGENDA_TABS_LENGTH` (200,000) together, refused "the tabs together" the same way. One schema (`longProse`, `packages/protocol/src/lib/agenda.ts`) enforces it for every path that takes one — `agenda add`, `agenda edit`, `--body-file`, `--json-file` and the daemon's own check — so the CLI refuses before it sends and the daemon refuses with the same words: _the body is 200,001 characters; the most is 200,000. Do not trim it: put the full report in a file or artifact, add it with --link, and keep the body to the current state and the choice._ Nothing is ever cut to fit: a trimmed report loses its sections. The body is the live document of the current state, not an archive: what no longer bears on the item moves behind a link. The same holds for a gate item's body (the card's _How to test_): over the cap, the body says how long it is and points at the card instead of showing a cut-off copy. The Agenda-mode instruction carries the one-line version.

**A segment never draws a heading.** A Markdown heading (`#` … `######`) a ferret writes inside any segment is drawn
as bold text at the segment's own size, never an h1–h6: the card's own labels (Premise, Context, **What I need from
you**) are its only headings. Chat messages keep their headings; only agenda segments demote them
(`demoteHeadings` on `Markdown`, set once by `AgendaProse`).

**The open item's title is always readable.** The open item's head stays ONE row, and its title is **one line**: a
title too wide scrolls to its end and back (the marquee), and where motion is reduced it ends at the last whole WORD
that fits, then "…" (`wordCut`), with the whole title a tap away. It is never wrapped and never drawn a second time in
the body: the room under the head is the premise's. Every item does this — ordinary, gate or machine notice — and so
does every other card head (a card to test in the Inbox). List rows keep their own clamps. A card's who/where line
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

A **gate item from before card asks** waiting for the owner to try the work wears **Test** (`TEST_KIND_LABEL`), and a plan waiting for a
go-ahead wears **Approve**, whatever kind the item was raised with. Peer-message kinds are another thing and keep their own words.

## The item view

**One item view everywhere** — the chat and the Inbox draw the same component (`AgendaItemView`). It
reads top to bottom in eight parts: the four that say what the item is and what it needs from the owner come first,
then the tabs — its live document ([Stage, the tabs, and the detail](#stage-the-tabs-and-the-detail)) — and
the log, the conversation and the activity, at the bottom. The order is `ITEM_VIEW_PARTS` in
`packages/pwa/src/lib/agenda-item-sections.ts`,
and a part the item does not carry is not drawn:

| #   | Part                                | What it holds                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Title, description, state and stage | the title row (ONE line, a marquee when too long; the quiet controls behind ⋯); on the line under it two small chips, the STATE chip (Needs you · Resting · waiting on Zoe · Resting · working · Snoozed until … · Done) and the STAGE chip (Explainer · Question · Plan to approve · Tracker · Test · Done); then the **description** — the item's summary (its ask, `subject`), drawn whole |
| 2   | Premise and context                 | the two tinted blocks; long is fine                                                                                                                                                                                                                                                                                                                                                           |
| 3   | Detailed context                    | `detail`, explained from zero — **folded**                                                                                                                                                                                                                                                                                                                                                    |
| 4   | Terms and references                | ONE table of every term and every link (PR, card, file, page), a term says what it means; a link is named by its target (drawn by the one reference renderer) and means its label, or nothing when it has none — **folded**                                                                                                                                                                   |
| 5   | What I need from you                | the ask ([below](#what-i-need-from-you)), why the recommendation, the steps, the impact, then **its first card ask as its own ask** (the steps and ONE answer row; any other named as next); **marked out** (a heavier accent frame and a tint, the heading in the accent) while the item needs the owner                                                                                     |
| 6   | The live document (tabs)            | **Where we are now** first and open (the answer to the owner's question, decided so far, still open, then `whereWeAre`), **The full picture** (`body`; a review's Reasoning), then the ferret's own tabs — each drawn open and whole, Markdown with fy-render                                                                                                                                 |
| 7   | Conversation                        | the owner's and the ferret's words about the item, oldest first, each whole: the log, at the bottom — **folded**                                                                                                                                                                                                                                                                              |
| 8   | Activity                            | the grey lines — each stage entered, each edit with what it changed, where it rests or sleeps now — **folded**                                                                                                                                                                                                                                                                                |

- **The head says what it is, whole.** The description (`data-agenda-description`) is drawn on the card under the
  title, never behind ⓘ, so ⓘ holds only a host's quiet tools (the Inbox's Skip). A gate item from before card asks,
  which repeats nothing, keeps its summary behind ⓘ, and so does a machine notice drawn with its cards, whose rows say
  its lines once. The ask in part 6 still leads with the same words when the item has no question of its own, on
  purpose: the head says what the item is, and part 6 — where a push lands — reads whole on its own.
- **The one thing that needs the owner stands out.** While the item is Needs you, part 6 is marked out
  (`data-agenda-needs-you`): a heavier accent frame, a tint and its heading in the accent — never a left rail, which the
  app draws nowhere, and never colour alone, since the head's "Needs you" chip says it in words. A form on a phone keeps
  no frame (three nested boxes would squeeze its fields), so there only the heading and the chip mark it. A resting,
  snoozed or settled item draws it quiet.
- **One menu for the quiet controls.** The head is ONE row: the title, how urgent it is, ‹ n/N ›, **⋯** and ✕. Everything
  the owner reaches for only now and then is behind ⋯ (`agenda-item-menu.tsx`), so on a 390px phone the premise starts
  in the top quarter of the screen: the version picker and **Changes**, **Snooze** (1 hour · 4 hours · Tomorrow 9:00 ·
  Custom…), **Merge with…**, **Not needed** (or the host's own quiet tools — the Inbox's Skip and Not needed — said
  once), and a gate item's or card notice's summary under "About this item". On a phone (under 768px) the menu is the
  app's bottom sheet; wider, it is a popover under ⋯. Esc, a tap outside and the sheet's swipe close it; every choice
  that does something closes it, and Esc never closes the item under it. Only what the item has is offered, and an item
  with nothing to put there draws no ⋯. The two chips sit small on the line under the title, and an earlier version on
  screen adds a third, **Showing v2**.
- **The tabs (&F923).** With more than one tab: wider than a phone, a real ARIA tablist that **wraps onto a second
  line** rather than scroll or cut a name (arrows, Home and End move); on a phone (under 768px) **the same tablist on
  one line, scrolling sideways** (&F946, the owner: _"make it such that the tabs are not drop-down, but horizontally
  tabs so ppl are aware there's tabs"_): an end that hides more tabs fades out with the next name cut, so the row
  always shows there is more, and the open tab is scrolled into the row (sideways only, never moving the page). No
  dropdown and no sheet. Only the open tab is in the page. A tab that changed **since this device last
  looked** carries a dot and the word "Changed" (never colour alone): when the machine keeps versions and this device
  saw an older one, that version is read and compared with the item now, so a tab edit stays marked when a later edit
  only touched the title; otherwise (no versions, never opened, or the newest already seen) the marks are what the
  item's last edit changed. Each tab ends with **Next: … ›**, so a reader at its bottom never
  scrolls back up to switch. When the ferret answered the owner's question, part 5 says **Answered: see Where we are
  now**, which opens the main tab and brings it into view, so the answer is never missed. One tab draws no tab row: the
  part is drawn under that tab's name.
- **Folded parts remember.** The detailed context, the terms and references, the conversation and the activity log
  start closed, each saying how much it holds ("2 entries", "4 messages"); opening one is remembered per
  item on that device (browser storage, read and written defensively — a private window simply starts closed again).
  So is the open tab (`fy.agenda.tab.v1:<item>`): the main tab is the default, and a remembered tab the item no
  longer has falls back to it.
- **No cut-offs.** Nothing in the open item is clamped or truncated: a long report, every reply and every line an
  edit changed are drawn whole, once opened. The title is ONE line in the head: a marquee when it is too long, and
  where motion is reduced it ends at a whole word with "…" and a tap shows all of it (`MarqueeTitle`), so the whole
  title is always one tap away. Rows in a list may still be one line.
- **The conversation** is read from the chat for an item that has no stored thread (`itemHistory`: the owner's words
  that name the item and the parts of the ferret's replies about it). The stored conversation
  feeds the same part from the item itself: the item's own tail when it is whole, else every
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
- **The conversation looks like the chat (&F921).** It is drawn with the chat's own rows, never bespoke ones: the
  owner's words are the chat's bubble (`OwnMessageRow`) with its time and its receipt ticks at the foot, and the
  ferret's are the chat's agent text (`TranscriptTextRow`), its name small above and its time below. The time is the
  chat's clock (`14:02`, the full date and time on a tap), not an age. The ticks are the chat's marks and claim only
  what is known (`itemWordsReceipt`): a send the chat's ledger recorded is drawn exactly as the chat draws it; words
  that are a row of the ferret's transcript, or that the ferret itself logged from the chat (`fy agenda log`), are **read** (four ticks); words
  stored on the item are **answered** (three accent ticks) once the ferret spoke after them, and **on the machine**
  (two ticks) until then. A chat reply the daemon stored on the item is stored once the queue accepts it, still
  queued, so its `fromChat` mark is no proof of reading. A stored entry records no delivery, so the item never claims
  more than that.
- **Card asks live inside the item, as its own ask.** A card ready to test or approve is answered in part 6, never
  as an item of its own and never as a second answer row: [One ask, in the lane's own words](#one-ask-in-the-lanes-own-words)
  says how each kind draws it. The item's own one-row answer is the sticky dock at the view's foot, in reach however long
  the item runs; when its card asks are its answer, their buttons are inside "What I need from you" and nothing docks.
  A card ask's How to test is the daemon's (`howToTest` on the ask), else read from the board the app already loads
  (`howToTestFor`).
- **A reply that already says yes is a reply, and nothing is said back (&B155, v4).** The owner who types "build" or "works now"
  has not pressed the card's button, so the card stays where it is. The ask does NOT draw a line above its button ("You wrote
  … tap Good"): that was a second prompt beside the one row, which read as a second ask. The words are a reply (see below), the
  one row's button is the answer, and a typed answer that WAS sent says what it sent ("Sent your words on !A404: “It scanned,…”"),
  never the label the words rode on.
- **Opened at its ask.** A Needs-you push, and any link that names the item (`?agenda=A5`), open the view scrolled to
  part 6, "What I need from you", with it focused. Each tap is a new request, so an item already at its ask is brought to it again. An item
  the owner opens themselves, or one paged to from the one a push opened, starts at its top.
- **The version slot is in the ⋯ menu** (`data-agenda-version-slot`): the version picker and the diff control. Beside the diff
  control the picker counts the item's EDITS ("Edit 2 of 3"), because the diff's own numbers (v1, v2…) are the stored
  versions, which count more than the edits do; a machine with no stored versions keeps "v2 of 3". Picking a version
  closes the menu and redraws the card as it read then, with "Showing v2" among the chips and the way back to the latest.
- **Changes (the diff).** With two or more versions on a machine that keeps them, the slot gains a **Changes** button.
  It closes the menu and opens a panel under the head (the menu's button then says **Hide changes**) that compares "since you last looked" by default (this device's last-seen mark
  against the newest version) and lets the owner pick any two versions from **From** and **To**. Each changed section
  shows what changed, coarse to fine: equal lines stay; the lines between them are paired in order by how alike they
  are; inside a pair the same is done sentence by sentence, then word by word, with a short kept word between two
  changes ("the", "of") folded into them so one edit is not confetti. A pair that shares fewer than half of its words
  (`REWRITE_SIMILARITY`) is a REWRITE: the old block is struck through whole and the new block added whole, never
  woven word by word, while a small edit stays a word diff. A long text with a small edit stays word-level too: equal
  lines (and sentences) at both ends are kept first, and when the lines between are still too many to pair at once, the
  lines that stayed equal anchor the rest, and only the gaps between anchors are paired, each under its own cap of
  2,500 line pairs. The anchoring has no size limit: a middle small enough is matched exactly, and a larger one is
  anchored in linear time on the lines (or sentences, or words) that occur once on each side, then each gap between
  anchors is matched the same way, so two one-word edits at the two ends of a 3,000-line report, or of a 3,000-sentence
  paragraph, stay two small edits. Only a gap larger than the pairing cap with nothing equal in it (about fifty lines
  changed against fifty others) is shown as the old lines out and the new lines in. The work is bounded so a large
  rewrite never freezes the page: one comparison has a budget of about twelve million word pairs to score how alike
  lines are and to match words exactly, and once it is spent, likeness is a cheap bag-of-words count and the matching
  uses anchors only, so fifty lines of 500 words each, all rewritten, come back in well under a second. A long
  unchanged stretch inside a changed section is cut to the three lines beside each change with one line saying
  "… 240 unchanged lines …". Additions are underlined, removals struck through, with a
  status word (New, Changed, Removed) and +N/−N counts and a legend, so the diff is never read by colour alone. The
  sections compared are, first, the tabs — the live document, the thing that is versioned — in tab order: where we
  are now, the answer to the owner's question, what is decided and still open, the full picture, then each of the
  ferret's own tabs matched **by id** (a rename reads "Open risks (was Risks)", a new tab New, a removed one Removed)
  and a one-line **Tab order** when the tabs both versions have moved. Each changed section that is a tab (or a part of
  the main tab) offers **Open tab ›**, which switches the tabs to it and brings them into view; then the title, the type, the question, the
  premise, the context, the detail, the terms, the references, the ask, a multi-decision ask's questions, each
  option's explanation, a form's fields, the recommendation, the impact, the urgency, the steps, the cards,
  why it matters and how to resolve it, so a changed type (Question to Plan to Tracker) or a replaced form is never "Nothing
  changed". Sections that did not change fold
  under one line. Opening an item writes the seen mark (`PUT …/seen`) for its newest version, after the baseline is
  read, so "since you last looked" is the previous visit. A machine without the version routes shows no control.
- **The terms table** shows a link's own `meaning` (`agenda.link-meaning.1`), else its label.

## What I need from you

**Every card has one answer shape, and it says it in one place.** In the item view's sixth part, right after where we
are now ([The item view](#the-item-view)), every open card draws a segment headed **What I need
from you**. It holds exactly the ask and
ends with one plain instruction, so the owner always knows what to do. The ask itself is a short **bold line at body size** — never heading-sized, however long it is; a long ask wraps
and the card stays the card:

| Kind (`--kind`)                     | The segment shows                                   | The buttons                                                         |
| ----------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| `choice`                            | ONE question, then each option with what it means   | the options (three on the row), recommended tagged                  |
| `yesno`                             | one yes-or-no question                              | No · Yes (always: No ←, Yes →)                                      |
| `permission`                        | what is being approved, and its effect (`--impact`) | Approve · Deny                                                      |
| `review`                            | what to review (`--link`)                           | Approve · Request changes                                           |
| `reply`, one question               | the question                                        | none: "Type your answer below."                                     |
| `reply`, several questions or a mix | a numbered list of each answer wanted               | none: "Reply with your answers below, numbered. Skip any you like." |
| `form`                              | numbered fields, each answered where it is asked    | none: the card's fields, the reply box, one Send                    |
| `todo`                              | the steps, numbered, each ticked                    | Mark as done                                                        |
| `info`, and a notice                | the message                                         | Got it (quiet: a bare Got it does not wake the ferret)              |

- **A button says its option's short label** ("No", "Only blockers"): never its description, never a bare letter.
  Markdown in a label is read as plain words. A label longer than 24 characters (20 on a row of three) is cut at a
  word, and the answer sent is still the whole label. A row of three counts every button drawn on it, so two answers
  beside "Done · closes" are a row of three. On a phone, a row of three gives each button a third of the width: a
  label that does not fit wraps onto a second line, between words, and the buttons grow taller to hold it; the row
  never grows wider than the screen, so only a single word wider than its whole button is split. The arrow keys'
  hints and `fy agenda list` say the same words, through one function. The options list may name long options by
  letter; the buttons never do.
- **Options are only for a choice; steps only for a to-do.** Several questions, or a question mixed with anything
  else, are `--kind reply` with one `--question` each: never option buttons. The owner answers them in one reply, by
  number, and may skip any (&F922). When the questions are a ferret's own question form (a harness prompt), the
  daemon reads a plain numbered reply (`1. EU`, then `3. yes`; a number with nothing, `skip` or `skipped` after it
  counts as skipped) as well as the board's own `1. <question>` then `→ <answer>` shape, and fills a skipped question in the
  form with `skipped`, so the whole form still goes in one go. It reads nothing from prose: a reply that does not
  start with a number, or whose numbers do not rise within the questions, is refused and the item is raised again.
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

### One ask, in the lane's own words

**An item that carries a card ask still asks the owner ONE thing, with ONE answer row**
([One model](#one-model-the-agenda-asks-the-card-shows); the owner, on !A404: _"if it's good, we just select good, if
not we type what's wrong or what needs changing. to try it, it should write all information needed to try it. if it
has preview env, we can try it there (even better)! … the agenda MOVES the card and acts as any gates for the card
movements"_). One pure rule decides it for every kind (`itemAskPlan` in `packages/pwa/src/lib/agenda-item-sections.ts`):

- **Every item draws its first card ask as its own ask**, inside "What I need from you". With several, the first is asked and each other is named,
  one plain line ("Next: try it, for &F13 Badge shape."), asked once the first is answered: one row, one thing at a time.
  1. **A heading in the lane's verb**: **Try it**, or **Approve** at a plan. Never "Card &F12", never "your answer for
     the card".
  2. **One plain reference line** naming the card once: "For &F12 Badge colour".
  3. **Everything needed to try it**, written by the daemon from the card for someone who knows nothing of it
     (`tryItText`, carried as the ask's `howToTest` and restated whenever the card changes): the preview link first —
     **Try it on the preview** — when the card links one, else "There is no preview for this one. Try it for real: the
     steps below say where."; then the card's own How to test (where / do / see) as written; then where the work stands
     (**shipped in Ferretry vX.Y.Z** with the PR and how to update to it — only for a PR of Ferretry's own release repository; another project's is **released in <owner>/<repo> vX.Y.Z** — merged but not released, or the PR still open). A preview is a card
     link that is a Cloudflare Pages preview (`https://<branch-or-hash>.<project>.pages.dev`, never the production
     host), recorded with `fy task link <card> --doc <url>`; nothing invents one. **No per-PR preview deploy exists yet**
     (`pwa-pages.yaml` deploys production from `main` only); once a card links one it is shown first.
  4. **Its answers.** The item's own ask line stays only when it says something the card ask does not (a ferret's own
     question); the daemon's "Try it: …" line that only repeats it goes, and "Type your answer below" is never said
     beside buttons. That is the daemon's own rule (`itemAsksOwnQuestion`, [Card asks](#card-asks)), so a line the app
     keeps on screen is one the daemon keeps in Needs you after Good. With one card ask, the swipes and arrow keys
     answer it too.
- **Good, and the words typed below** — when that one card ask is the item's WHOLE ask (the card's own agenda, or a
  thread whose ask line only repeats it, with no questions, form fields or buttons of its own) and the host draws the box under the item (the Inbox): **Good** is one tap (the
  lane's default "Done" reads Good; a label the lane wrote itself is kept), and what is typed in the box is the other
  answer: at a try-it the lane's fail, **Not good**, the card going back with the words as the reopen ask (files ride
  along as for any Not good); at an approval **Not yet**, the card staying while its ferret reads the words (words alone: a Send with files is refused, saying so, and the box keeps the words and the files). Elsewhere
  (the chat's agenda, which draws no such box) the ask keeps the gate's own buttons, Done and Not good: an ask is never
  drawn with "type what is wrong" and nowhere to type it.
- **An item that asks a question of its OWN answers THAT question** (a ferret's question, a choice, a permission, a review: the
  daemon's `itemAsksOwnQuestion`). Its answers are the one ask — typed words, or its own buttons — and a try-it on the same
  card is never squeezed in beside them. The card ask is named on one plain line ("Next: try it, for &F12 Badge colour. It is
  asked here once you have answered.") and takes the answer row when the question is answered (an item whose question was
  answered in words rests, and the daemon keeps it in Needs you while a card ask stays open). A **to-do's Done, an info's Got it
  and a notice** close the item, which the daemon refuses while a card ask is open, so there the card ask goes FIRST and the
  item's own buttons wait behind it ("First answer the try-it below; the buttons for this come back once it is answered.").
  Either way: one row at a time, one "What I need from you".
- **A finished item** (resolved or done) is a record: how it ended is said ONCE (the settled line, or the Done chip when the host
  draws none, and never a stage chip saying Done again), and it has no "What I need from you" box to repeat its headline. The
  question or ask is also said once while open: the block leads with it, so the head does not repeat it under the title.
- **A notice answered by a form of its cards** ("3 cards have nobody working on them": a pick per card, one Send) needs the owner:
  its chip says Needs you, its list row is a tile like any item, its picks are one compact row per card, and its one Send sticks to
  the foot of the view so it is always in reach.
- **Which card ask is first**: the first one still waiting for an answer. One the owner said **Not yet** to waits behind
  the others (still named, asked again once they are answered; of several, the one set aside longest ago first), so a
  deferred approval never blocks the next one. The app, the daemon's `gateAttached` mirror and an older app's unnamed
  answer read this one order (`askedCardAsks`).
- **The daemon's own ask line is hidden only while it is still the daemon's**: on the agenda the daemon opened for the
  card, in the lane's words ("Try it: …"), and not rewritten by a ferret since. A question a ferret puts there later is
  the item's own: it stays on screen, and typed words answer the ferret, never the card.
- **Nothing else answers beside it**: while a card ask is the answer, the item offers no Done · closes of its own, and an
  answer that did not land ("Not sent: …") is said beside the card ask, whichever of the item's rows waits.
- **Every surface answers the same ask**: the item view, the Inbox deck's swipes and arrow keys and the run's key
  hints read one function (`itemSwipeTargets`), so a swipe and a tap never answer different asks; the compact card (the
  Sessions page's Needs you, the pinned card) draws the same first card ask with its answers.
- **An old daemon's Inbox to-test row** (a daemon without `agenda.card-asks.1`, which raises no agenda item for a card
  to try) is drawn as that item: "What I need from you", "Try it, then tap Done or Not good.", the steps, and its one
  row. No card heading, no "Close card".

There is no second box, no "Card &F12: your answer for the card" heading and no exception for a ferret's own thread: a
thread whose own question stands keeps that question as the one ask, and the card ask under it waits, named on one line. `scripts/validate/owner-surface-words.sh` fails the build on the old words, and
`packages/pwa/tests/unit/features/agenda-one-answer-row.test.tsx` draws every kind with card asks and counts one answer
row.

**What the Inbox box does with typed words** — exactly one of two things, never a chat message about the item:

- **It answers the ask that was on the item when Send was pressed** (bound by the ask's reference). If that ask was
  replaced or answered before Send landed, Send fails with a plain line in the box ("That ask has changed. Read the card
  again, then send.") and answers nothing — never the replacement ask.
- **It is a direct call**, not a chat send: it bypasses the device send outbox and sends the words exactly as typed — no
  `!A404` reference prefix, no "See the attached files." stand-in, no location block.
- **One exception: words that CLEARLY approve a try-it** ("works now", "it works", "good", "lgtm", "tested, ok" — the
  vocabulary of &B155, read by `typedApproval`). Sent as Not good they would send a finished card back,
  so they go as an ordinary reply about the item. Nothing is said back above Good (no "You wrote … tap Good"). They never move the card by themselves, **and they never move the item:** the words are logged and the
  ferret reads them, but the card ask is still open, so the item **stays in Needs you** with its Good (the app does not hide it
  as replied, and the daemon does not park it — `replyKeepsCardAskOpen`). A reply on an item that asks its own question beside
  the card ask is that question's answer: while a try-it still waits, the item stays in Needs you and the try-it takes over as its ask. Anything not plainly positive (a "but", a
  negation, a question, a longer message, or any words at an approval) stays a Not good (or Not yet) with the words.

The wording lives in one place, read by the daemon and the app (`agenda-gate-wording.ts` in `@ferretry/protocol`, from the
gate's options alone), so a workflow's style is its lane's stage and nothing else.

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
recommended value; a trailing `optional` segment is still accepted (every field may stay empty); `Name~Question` sets the short word the numbered
answer uses (`Region~Which region?` → "1. Region: EU"). The same list can be the `fields` of a `--json-file`. Ids are short and
unique (`1`, `region`); a pick-one or pick-many needs 2–12 options, a text field none. `fy agenda edit <id> --field …` replaces
the whole list.

- **One Send.** The card's fields and the reply box are one answer. Send combines them — "1. Region: EU · 2. Alerts: Page, Mail · 3. Restart: Yes · 4. <typed text>" — and delivers that to the ferret as the answer to the item. A form that has no `text`
  field sends the typed words as a note instead.
- **No secrets.** There is no secret field kind and a form answer is plain text on the item, so a password, token or code is never asked here: it goes through an input request ([input-requests.md](input-requests.md)), which the agent never reads.
- **Recorded by field id.** The answer is stored on the item as `{ kind: "form", answers: [{ id, picked }] }` (a pick-many's
  picked is a list), so the ferret reads `fy agenda show <id> --json` instead of parsing prose.
- **Every field is optional (&F922).** The owner may answer any subset: Send goes through at once, nothing is asked
  about first, and what was skipped reads `(skipped)` in the one numbered answer the ferret receives. Words with nothing
  picked still go, as a plain reply to the form's ask (`{ kind: "open-question" }`), so a form answer
  always names at least one field and every older app and daemon still reads it. Only nothing picked
  and nothing typed is not sent. A field's `required` (and the CLI's trailing `optional` segment) is still accepted so
  older raises parse, and changes nothing the app enforces or shows. A recommended pick can be taken back: tap the
  picked Yes/No half again, or **Clear** on a pick-one field.
- **No swipes** except ↓ Skip. Recommended values start picked and carry a "Recommended" tag; what is picked is the
  filled row (or the filled Yes/No half, with a check), so a recommendation never reads as a pick.
- **What is answered is counted.** No field says it needs an answer; a foot pinned to the bottom
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
  - **Not needed is a button, or the far side of the compass** (below) — never a plain swipe. It is a button in the open
    item's ⋯ menu, into the same undo window as any answer. A notice has no Not needed
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

- **`GET /v1/agenda/open`** answers every session's open AND parked
  (snoozed, replied) items on the machine: `{ sessions: [{ sessionId, items }], next? }`, in session-id order, paged
  with `?after=<next>&limit=` (default 200 items, at most 500; a conversation is never split across pages and one with
  nothing on its board is left out). It is read from the boards the agenda service already holds — no new store.
- **Who may read it**: the same grants as one conversation's board (`operator`, no capability, gated by who asks —
  [grants.md](grants.md)) with one narrowing: `caller: 'person'`. A board read names one session; this names every
  session and item on the machine, which a ferret has no use for, so a ferret credential gets 403. `noStore`, as a board is.
- **The Inbox reads it** for every machine. It reads
  every page on mount and when the owner opens Snoozed, Replied or Resolved, and keeps the last good read if a later one
  fails. A board this device already holds is newer than the roll-up and wins for its conversation. The list says so ("From your 30 most recent
  conversations") only while some machine is not read to the end. Resolved stays windowed to those
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
gesture: behind every open card's ⋯ are plain buttons — **Skip** and **Not needed** — and **Snooze** (1 h / 4 h /
tomorrow / custom); the arrow keys are unchanged. Snooze is offered in the compass and in the menu alike. The touch rules stay: a drag never starts on a control, and the direction locks on its first move.

### Card asks in the Inbox

A card ask is drawn as the item's own ask, never as a second answer row ([One ask, in the lane's own words](#one-ask-in-the-lanes-own-words));
an item from a daemon that sends no `cardAsks` reads its mirror, `gateAttached`, the same way, and every answer is sent with `gate: true`
and the ask it names. What follows is how the Inbox draws a gate item from an older daemon. A **gate item** (read from a daemon older than card asks) is a board card
waiting on the owner at a gate, raised as an ordinary Inbox item (never for a sub-card: the owner tests its parent, and a sub-card [closes itself](board.md#sub-cards-close-themselves) instead of waiting in a verify lane) (`item.gate`: the card, its lane and what each option does):
the owner meets one stream, not a question list and a separate to-test list. It is
the card's ONE head row (the title, ‹ n/N ›, ⋯, ✕ — `CardHead`; its summary, Snooze and Skip behind ⋯) under ONE quiet meta line: **what it is** — the **Test** chip
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
agenda, so it appears here and in the Inbox, and a card ask swipes as a card's answer does (**→ Done**, **← Not good**,
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
   (`/v1/sessions/:id/agenda`). "Send now"
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

## Definition of done

The agenda-first redesign is done when these sixteen things are true. Each is proved by a test named
`DoD <n>: …` in [`agenda-dod.sit.test.ts`](../packages/cli/tests/sit/agenda-dod.sit.test.ts), on a temp `FY_HOME` with
no network and the daemon's real `AgendaService` over its real ledger, version and seen files. **Items 1, 2, 7, 8 (the
report), 10, 14, 15 and 16 are driven through the real `fy` command** over HTTP into the daemon's real agenda routes.
The rest are service-level checks, because the owner's side (a reply, a snooze, the clock, the push) has no `fy`
command: item 3's push runs the real `NotificationService` with a recording sender, and item 4's nudge runs the real
`AgendaRestNudger`. The items the app shows are proved by the page's own tests; the SIT checks that each file still
exists and still says the behaviour it proves. A page's pointer waits only while the PR that adds the page is open (its
source module does not exist yet), and fails the checklist once it does.

| #   | The claim (the spec's words)                                                                                                                                                                                                                                                                                       | Proved by                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A ferret only opens an agenda when no open one passes the 3-part test. Otherwise it adds to the closest.                                                                                                                                                                                                           | `DoD 1` (`fy agenda add` refuses without `--new` and prints the `fy agenda edit` join; the join and the `--new` path both run)                                                                                                                                |
| 2   | Things that depend on each other are always in one agenda.                                                                                                                                                                                                                                                         | `DoD 2` (`fy agenda add --task` lists the agenda carrying a card the new one depends on, or blocks, first: "carries &F1, which &F2 depends on"); a card that already asks points the second ask at its agenda                                                 |
| 3   | A Needs you item notifies you and opens straight at its ask. A Resting item never buzzes you.                                                                                                                                                                                                                      | `DoD 3` (the real notification service: one push, blockers first, opening at the ask; none for Resting or snoozed); the opening: `packages/pwa/tests/unit/features/agenda-inbox-notification-open.test.tsx` (PR 7)                                            |
| 4   | Any reply or answer from you moves the item to Resting ("waiting on <ferret>") and out of Needs you. The ferret's answer on it brings it back to Needs you automatically, in its old spot. About 30 minutes of ferret silence gets a Warden nudge. Needs you never lists an agenda twice, and puts blockers first. | `DoD 4` (reply and owner answer rest it; the ferret's answer returns it ahead of a newer item; one nudge at 31 minutes, none at 29); `DoD 3` (unique queue, blockers first)                                                                                   |
| 5   | Snooze keeps an item Resting until the time you picked, unless a blocker wakes it.                                                                                                                                                                                                                                 | `DoD 5`                                                                                                                                                                                                                                                       |
| 6   | A card that's ready shows its test steps and Done / Not good inside its agenda, never as a separate item.                                                                                                                                                                                                          | `DoD 6`, and the board's gate path in `packages/daemon/tests/unit/board/card-asks.test.ts` (the ask rides the open agenda, or opens ONE named after the card); the page: `features/agenda-item-parts.test.tsx` (PR 7)                                         |
| 7   | An explainer or report you ask for appears in that agenda's tabs, the main tab ("Where we are now") first and "The full picture" beside it (&F923). (It was "where we are now" until the owner made the body the live document, !A332.)                                                                            | `DoD 7` (`fy agenda edit --where` and `--body-file`, a second `--body-file` replacing the body whole); the page: `features/agenda-item-parts.test.tsx` (PR 7)                                                                                                 |
| 8   | A long report fits with no cut-off. Every reply shows in the conversation, in order.                                                                                                                                                                                                                               | `DoD 8`: a 200k report through `fy agenda edit --body-file` read back whole; replies and the ferret's answers in their full interleaved order; the page: `agenda-conversation.test.ts` (PR 8); a long report is the body (see below)                          |
| 9   | The activity log is folded. Diff mode shows what changed between any two versions you pick.                                                                                                                                                                                                                        | `DoD 9` (the versions list and any two can be fetched); the folds: `agenda-item-sections.test.ts` and `features/agenda-item-parts.test.tsx` (PR 7); the diff: `features/agenda-version-diff.test.tsx` (PR 8)                                                  |
| 10  | Merging two agendas keeps both conversations and all their cards.                                                                                                                                                                                                                                                  | `DoD 10` (`fy agenda merge`); the button: `features/agenda-merge-control.test.tsx` (PR 8)                                                                                                                                                                     |
| 11  | A sub-ferret can't create a card or agenda without permission.                                                                                                                                                                                                                                                     | `DoD 11` (a sub-ferret is refused a card and an agenda; its lead is not)                                                                                                                                                                                      |
| 12  | A ferret can show a live card or mini board inline, and it updates when the card moves.                                                                                                                                                                                                                            | `packages/pwa/tests/unit/fy-render-card-embed.test.tsx` (`DoD 12`, by pointer)                                                                                                                                                                                |
| 13  | The board shows public cards by default, each linked to its PRs and approvals.                                                                                                                                                                                                                                     | `DoD 13`; `features/board-page.test.tsx`, `board-private-preference.test.ts`, `card-visibility.sit.test.ts`. **GAP:** each linked to its PRs and approvals has no test here                                                                                   |
| 14  | One agenda can go from explainer to question to plan to tracker to test, with its type showing the current stage, and the history keeps each stage.                                                                                                                                                                | `DoD 14` (`fy agenda edit --stage` through every stage, then `fy agenda done`); the head: `features/agenda-item-parts.test.tsx` (PR 7)                                                                                                                        |
| 15  | When part of an agenda no longer passes the test, the ferret splits it into a new linked agenda.                                                                                                                                                                                                                   | `DoD 15` (`fy agenda split --move-cards`); the page: `features/agenda-merge-control.test.tsx` (PR 8)                                                                                                                                                          |
| 16  | A main-chat exchange about an agenda shows in that agenda's conversation, with your words verbatim and tagged "from chat", plus the ferret's reply. The chat reply links to the agenda, and the exchange moves the state as a reply would (it rests, and comes back on the ferret's answer).                       | `DoD 16` (`fy agenda log --reply` and `--rest`: verbatim, tagged, the same message never logged twice, the item rests and comes back ahead of a newer one). **GAP:** the chat reply links to the agenda — taught only (`link` in the Agenda-mode instruction) |

**A long report reaches the item through `edit`.** The main tab, "Where we are now", is written whole from a file
(`fy agenda edit --where-file`, up to 200,000 characters), the report is "The full picture" (`--body-file`, item 8),
and a part that changes on its own is a tab of the ferret's own (`--tab-file "Name=file"`); every one is read back
whole with `fy agenda show <id> --tab <name>`, and one edit of any of them is one version (&F923).

The teaching that makes a ferret follow these rules is held to the spec by
`packages/cli/tests/unit/agenda/teaching-spec.test.ts`.

## Compatibility

The agenda was called Attention. The app and the CLI dial the agenda names only; the `/attention` routes,
`POST …/notify` and `SessionState.attention` are gone. The app ships from `main` the moment a change merges while a daemon
changes only after a release and `fy daemon update`, so the CLI still checks the features below before sending a
request an older daemon would refuse.

### The channel (`agenda.channel.1`)

A daemon that rests items on an answer and takes the channel's requests reports `agenda.channel.1` on
`GET /v1/health`; one that also takes [editable asks](#editable-asks) reports `agenda.asks.1`. Every new item field
(`resting`, `stage`, `stages`, `ownerAnswer`, `askVersion`, `whereWeAre`, `detail`) is optional, so an app or CLI from
before reads every item. The request fields are refused as malformed by a daemon without their feature, so the CLI
checks it first and says the daemon needs an update: `stage`, `whereWeAre`, `detail` and the `rest` action need
`agenda.channel.1`; an edit's `ask`/`kind`/`answers`, `clear: ['questionAnswer']` and an answer's `askVersion` need
`agenda.asks.1`; so does a Done or Skip's `askVersion`; a link's `meaning` needs `agenda.link-meaning.1`; an item's
`tabs` and an edit's `tabEdits` need `agenda.tabs.1` (`--where-file` only writes `whereWeAre`, so it needs nothing more
than the channel). An older app that sends no `askVersion` is refused only for an
answer to a replaced ask (see
[Editable asks](#editable-asks)). `fy agenda answer` sends the edit every daemon takes (`questionAnswer`): an older one brings the
item back fresh instead of in its old place.

### The channel header

The CLI and the app send the request header `x-fy-agenda-channel: 2` on agenda requests, and the daemon allows it in
its CORS preflight. The daemon reads it for one thing only, the shape of a **list** read:

- **Channel 2** — active items in full and resolved headers on session agenda and machine agenda list reads. Opening a
  resolved item reads its full record through `GET …/agenda/:id`. Actions, Send now, roll-ups and one-item reads retain
  their full shapes.
- **Anything else** (no header, channel 1, an unknown version) — complete active and resolved records, exactly as
  stored. A cached PWA or CLI that cannot parse headers keeps reading its whole snapshot.
- Older daemons ignore the header (it is already allowed by CORS); a daemon that only understands channel 1 serves
  channel 2 readers its legacy projection — the same items with widened fields clipped — which they can still read.

### Tabs (`agenda.tabs.1`)

A daemon that stores an item's own tabs and applies an edit's tab operations reports `agenda.tabs.1`; the CLI checks
it before sending `tabs` or `tabEdits` and says the daemon needs an update. An item without `tabs` has the fixed tabs
only, so the ledger is unchanged (no migration).

- **GAP (downgrade):** a daemon rolled back to before the tabs drops `tabs` on its next write of that item; the
  version store still holds them, so Changes can show them, but they are not restored on the way up.
- **GAP (cached app):** an app cached from before the tabs parses a revision that changed `tabs` with its strict
  revision schema and cannot read it until it reloads.

### Patch (`agenda.patch.1`)

A daemon that takes an edit's `revision` (refusing `stale`, 409, when the item has moved on), `why` and
`howToResolve`, and the wider `clear` list ([Patch](#patch-the-item-as-one-document)) reports `agenda.patch.1`;
`fy agenda patch` checks it before sending anything. Every new field is optional on an existing request, so there is
no migration.

- **GAP (older daemon):** a daemon before it refuses those fields as malformed, so `fy agenda patch` stops with
  `update the daemon first`; `fy agenda edit`'s flags still work there.
- **GAP (cached app):** an app cached from before it does not know the `stale` error code and reads it as a generic
  refusal; the app never sends a revision, so nothing it does is refused this way.

### The conversation (`agenda.conversation.1`)

A daemon that stores the conversation, takes `log`, `merge` and `split`, and keeps versions reports
`agenda.conversation.1` on `GET /v1/health`. Every new item field (`conversation`, `mergedFrom`, `mergedInto`,
`splitFrom`, `splitInto`, `relatedTasks`) is optional, and the version routes are new, so an app or CLI from before
reads every item; the CLI checks the feature first and says the daemon needs an update.

### Lists and complete items

`GET /v1/sessions/:sessionId/agenda` and `GET /v1/machine/agenda` return
`AgendaListSnapshot`: active items (including resting and snoozed ones) in full, and every addressed item as a
`projection: header` record. A header keeps its id, title, kind, author, resolution time and disposition,
conversation count, card and reference links, the short reason searched by Find, and the outcome metadata the Resolved rows display. The document's
tabs, revisions, history, conversation text and full picture travel only on an item read. Stored ledgers and mutation
responses retain the full `AgendaSnapshot` shape. List readers also accept full records from older daemons.

`GET /v1/sessions/:sessionId/agenda/:id` returns one complete active or addressed item, with the same operator
minimum and caller policy as the session list. `GET /v1/machine/agenda/:id` does the same for a machine item and is
owner-only, exactly as its list is. Both are no-store reads; an unknown item is a 404. The existing conversation
cursor still reads words outside the item's bounded tail.

The PWA reads a resolved item's full document when it opens, before drawing its tabs, conversation and edits.
The Resolved lists need only header metadata; none of the last ten records needs a full-document exception.
Machine records open in the Inbox because they have no ferret conversation to navigate to. A failed item read keeps
a visible retry; it never presents a header as an empty document.

### Older names still read

| Older name                                | Agenda name          | Today                                                                      |
| ----------------------------------------- | -------------------- | -------------------------------------------------------------------------- |
| journal `attention.*` events              | `agenda.*`           | new names written; readers accept both                                     |
| `machine.yaml` `attentionNudge`           | `agendaNudge`        | both read, the new one wins; config check warns                            |
| `config/daemon.json` `attention.{…}`      | `agenda.{…}`         | both read, key by key the new one wins; a start notice names the old block |
| push kind `attention`, tag, `?attention=` | `agenda`, `?agenda=` | old still SENT; apps read both                                             |
| handover `references.attention` count     | `references.agenda`  | old still written; new accepted                                            |

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

### The removal release

One release removes the older names that remain and switches the rows still sent the old way (push kind, tag and link, the
handover count). It ships only when no app or CLI you run still reads them.
