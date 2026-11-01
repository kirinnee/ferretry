# The project board

The contract for the board: where a ferret's work is tracked when the owner wants it tracked. One board per project,
one card per piece of work, lanes the owner can rename, and a daemon that moves a card when a pull request or a
release does. **The board is opt-in** ([below](#the-board-is-opt-in)): most work needs no card. This page owns the
subject; the pages it links own their own facts.

| Subject                         | Owner                                          |
| ------------------------------- | ---------------------------------------------- |
| Importing the old task files    | [board-import.md](board-import.md)             |
| `&F412` and `!A48` references   | [reference-standard.md](reference-standard.md) |
| The agenda and its items        | [agenda.md](agenda.md)                         |
| Who may call the board's routes | [grants.md](grants.md)                         |

Where the board is on, most of it is automatic: a start makes the card, a PR and a release move it. The sections
below are the whole contract; the last ones are the part a ferret must do itself, and the backstop that catches it
when it does not.

## The board is opt-in

The owner's decision (2026-11-01): "board is overkill — most ferrets should not use tasks or boards — ask before
doing that". So each project's board has a switch, **off unless the owner turns it on**, and a ferret makes a card
only when

1. the owner asked for a card or the board,
2. its lead handed it one (`fy new` under a card the lead holds, or `--card <id>`), or
3. the project's board is on (`fy board status`).

Otherwise it asks first: one agenda yes/no, "Track this on the board?". A card a ferret holds works as it always did,
whatever the switch says.

| Where the board is off                                    | What happens                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `fy start`, the app's New session                         | no card is made                                                                                              |
| `fy new`                                                  | a card only under the card the lead holds (the brief names it, or its focus), or the one `--card` hands over |
| `fy task create`                                          | never refused (the owner may have said yes); a ferret is reminded that the board is off                      |
| the [turn-end check](#the-turn-end-check)                 | silent                                                                                                       |
| the sweep's stale and unblocked nudges, a PR or a release | unchanged: they only ever touch a card that exists, so only a ferret holding one hears them                  |

**Only the owner throws the switch**: `fy board on|off [--project <name>]` from their own terminal, or **Use the
board** on the project's page in the app. A ferret's `fy board on` is refused (`403 owner-only`), because the session
it runs in rides on every call. The switch lives in `<home>/board/switch.json`
(`packages/daemon/src/lib/board-projects/board-switch.ts`); a damaged one is refused and never overwritten, and a
board whose switch cannot be read is treated as off.

**Migration.** The first daemon with the switch decides every existing board once, at boot: **on** exactly where the
owner sent a card back (**Not good**, a `reopened` event by the owner) in the last 14 days, and **off** everywhere
else. Unfiled is always off. Only Not good counts, because it is the one act no ferret makes (see the GAP below); on
the machine this was built on that switched on Ferretry alone. The boot log says which
boards it switched on and off (`board switch: on for …; off for …`); the owner flips any of them afterwards. A board
registered later starts off.

**GAP: a ferret without its own credential has the owner's authority.** A call on the admin token with no session
(an older `fy` or harness without `FY_SESSION_ID`, a tool outside Ferretry) cannot be told from the owner at the
machine, so it passes every owner-only board gate — the switch included. It is no longer RECORDED as the owner: a
card's history says `admin-token` — "the admin token (the owner at this machine, or a ferret without its own
credential)" — and only a paired device's act reads as `owner`. A ferret on its own session credential is always
itself (`ferret`), never the owner. That is why the migration counts only Not good. Closing the gap for good is
`fy` presenting the session credential in every pane (RF-3, &F291).

## Boards, cards and lanes at a glance

- A **board** is one registered project, or the machine-wide **Unfiled** board for work outside any git repository.
- A **card** is one piece of work. Its id is `<B|F|I|C><n>`, the prefix set by its kind (bug, feature, infra,
  chore). Ids come from one machine-wide counter and are never reused.
- A **lane** is a column of a board. Lanes are arbitrary names, each in one of six fixed categories.
- Only the daemon and the CLI write cards. The types live in `packages/protocol/src/lib/board*.ts`, the rules in
  `packages/daemon/src/lib/board/`.

## The Board rules

Every agent runtime is told the rules, always on, in the appended system prompt after the Notify rule
(`BOARD_INSTRUCTION` in `packages/fleet/src/lib/account/fixed-layer.ts`, the `board` launch section). A running
ferret launched with older words is told the new ones on the owner's next message
([launch-settings.md](launch-settings.md#instructions-that-changed-since-the-launch)). Exactly this, with the binary's
name for `fy`:

```text
Board: opt-in; most work needs no card. Make one only if the owner asked, your lead gave one, or `fy board status` says on; else ask: `fy agenda add -k yesno` "Track this on the board?". First `fy search`; link a match, no duplicate. Make: `fy task create -k <kind> -t "<≤5 words>" --summary "<line>" --ask "<exact words>" --premise <point> --context <point>`. A card (&F412; agenda !A48): before To test `fy task edit <id> --how-to-test "<1. where 2. do 3. see; machine+version>"`; lane by the work (`fy board lanes show`): `fy task move <id> <lane> --reason "<why>"`. Blocked: `fy agenda add --task <id>` (owner), `fy task depend` (card), `fy task block`. Owner's bug: `fy task reopen <id> --to <lane> --ask "<their words>"`. PRs, merges, `fy signal done` self-move; owner closes. Gate? The daemon asks; raise nothing.
```

Tasks are `&F412` and agenda items are `!A48`; nothing prints the retired `#F412`
([reference-standard.md](reference-standard.md)). The card-writing part is the owner's (2026-10-31): a title of at
most five words, a one-line summary, premise and context as short bullets, and — before a card reaches To test — a
How to test written for the owner ([How a card reads](#how-a-card-reads)). Registering a project by hand is no
longer in the rule, because a ferret's first card registers its repository.

## Sub-ferrets: no moves, only reports

A **sub-ferret** is a session another ferret started (`config.parent`, e.g. `fy new` from a ferret); a **lead** has none.
The owner's decision (2026-10-30): only leads move cards. Weaker models writing to the board is a coordination
problem, and what a sub-ferret does is mostly report back to its lead. The daemon enforces it by the caller's
session identity — in `BoardService` (`create`, `act`) and on the lane route — so a prompt cannot talk past it
([pack-mode.md](pack-mode.md#sub-ferret-limits)).

| A sub-ferret may                                          | A sub-ferret is refused                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| read the board, `fy task note` on a card                  | `fy task create`, `move`, `drop`, `reopen`, `assign`, `depend` / `undepend`, `block` / `unblock`, |
| `fy task link --pr <url>` / `--branch <branch>` on a card | `reparent`, `focus`, `edit`, `file`, `order`, `refile`, `clarify`, `link --commit` / `--doc`      |
| `fy task trigger` (`deploy.done`) on its card             |                                                                                                   |
| `fy send` its lead (and peers the lead names)             | editing a project's lanes (`PATCH` of the lane list: `403 sub-ferret`)                            |

The refusal is `forbidden` and names the way out, e.g. `Sub-ferrets don't move cards; tell your lead: fy send <lead-callsign> "…"`.
The daemon still makes the sub-ferret's card when `fy new` starts it (that is the lead's act), enters its working lane
for it when the session starts (`work.started`, below), and a PR or release still moves it. A directory that cannot place a caller refuses nothing: the limit narrows a ferret known to be a
sub-ferret, it never locks one out it cannot find.

A sub-ferret's system prompt drops the Board rules above and the Notify rule and the Agenda mode section, and
carries these two lines instead (`SUB_FERRET_INSTRUCTION`, the `sub-ferret` launch section; the daemon writes
`FY_SUB_FERRET=1` from the session's `parent` at every launch, so a stored value cannot switch it off):

```text
Sub-ferret: you were started by a lead ferret. Report to it with `fy send <lead-callsign> "<message>"`; you cannot raise agenda items, notify the owner or move cards.
If you have a card: link your PR `fy task link <id> --pr <url>` (or `--branch`), progress `fy task note`; it moves itself (start, PR, merge, `fy signal done`). No card? Don't make one. Your final report says how the owner tests it.
```

Nudges about a sub-ferret's card — the turn that closes without a PR, a reopen — go to its **lead** instead
(`nudgeTarget`, `packages/daemon/src/lib/sub-ferret/index.ts`).

## Which board a card is on, and how a project gets one

A board is a registered project (`<state home>/projects.json`). A session's board is decided when it starts
(`config.projectId`): its parent's when it works inside that project, else the project its git repository
belongs to (worktrees included), else the registered folder that contains it, else **Unfiled**.

**The owner never has to register a project.** Projects get registered in two ways:

1. **Automatically, by a ferret's first card.** When a ferret on the Unfiled board makes a card (`fy task create`,
   or the card `fy start` / `fy new` makes) while it stands in a **git repository** whose main checkout is inside
   one of the daemon's `projectRoots` (`config/daemon.json`; default `~/Workspace` and `~/.config`), the daemon
   registers that repository, moves the ferret onto its board, and proposes the project's lanes from what the folder
   suggests. A project with no lanes has nothing to protect, so that first proposal is live at once; the owner gets
   one agenda choice to accept or edit it. A linked
   worktree registers the checkout it was made from. This is `ProjectAdoption`
   (`packages/daemon/src/lib/board-projects/project-adoption.ts`).
2. **By hand, with `fy project add <path> [--name <name>]`.** It registers a folder (`fy project add .` for the one
   you are in) and prints the project's name, id and folder. A folder, or a git repository, that is already
   registered prints the project it already is and changes nothing. `fy project ls` lists every project. Use it for
   a folder the automatic path leaves alone: one that is not a git repository, or a repository outside every
   project root.

The automatic path never registers the home folder itself, a temp or scratch folder (`/tmp`, a harness's sandbox),
a folder that is not a git repository, or a repository outside every project root. Those stay Unfiled. It is
idempotent and safe under races: the registry dedupes on the folder and on the repository, one repository is
adopted one session at a time, and a project that already has lanes is never proposed again, so two ferrets in the
same repository at once make one project and one proposal. A failure leaves the card Unfiled, as before.

**Unfiled is only for work outside any git repository** (an ad-hoc chat in `~` or `/tmp`). A card that belongs on a
project's board moves there with `fy task refile <id> --project <name>`. A refile keeps the card's state: a card that
is already closed lands in the other board's closed lane without the owner's gate, because the owner already closed
it; moving an open card into Closed stays the owner's.

**The daemon refiles Unfiled cards that belong on a board, at once** (`UnfiledRefiler`,
`packages/daemon/src/lib/board-github/unfiled.ts`): on every GitHub watcher tick and once at boot, an open Unfiled
card moves to a project's board when

1. a linked PR's repository is a registered project's, or
2. the folder its owner ferret works in belongs to one: the board that session was stamped with, else the board its
   folder resolves to now, else its repository registered by the automatic path above, with the same rules (never
   the home folder, a temp or scratch folder, a folder that is not a git repository, or one outside every project
   root).

The refile goes through `BoardService` as the daemon, and its history says which rule moved it. A refiled card whose
PRs say something lands where work resumes on the new board (its last active lane) and its PR facts move it on from
there — stopping at the first gate on the way, as every fact does ([Gates ask the owner](#gates-ask-the-owner)) — so a card merged but not released lands in Merged, never in Released · to test because it sat in the Unfiled
board's To test. A card with nothing to say lands by its lane's category, as a refile by hand does. It is idempotent
and safe under races: runs never overlap, a card someone (not the daemon) refiled to Unfiled on purpose stays there,
and a ferret whose folder names no board is asked again only after ten minutes.

A project registered before projects got lanes (or by hand, with none proposed yet) is given the lanes its folder
suggests first (`InferredLaneProposer`: unconfirmed, live at once, the owner's one agenda choice raised as the card's
ferret), and the card is refiled in the same pass. A project whose `origin` uses an SSH host alias
(`github-personal:kirinnee/ferretry.git`, with `HostName github.com` in `~/.ssh/config`) is known by its GitHub
repository too: the daemon asks `ssh -G <alias>` where the alias goes, which reads the ssh config and connects to
nothing.

`fy board lanes show|propose|edit --project <name|id>` and `fy board --project <name|id|all>` name a board by its
name or id, wherever the flag is written on the line.

## The lane design rule

**Lanes are about what the owner must DO, plus just enough progress to show work moves.** The owner, verbatim
(2026-10-30):

> remember the lane design is always about ACTION -- when user need to have action and INFORMATION -- its good for
> the user to feel like there is SOME progress, but action is more important. for example, in-progress tells the
> user its being worked on. merge/release tbh doesnt matter THAT much, but release tells user it can be tested. and
> closed keeps the board lean.

So every template, every proposal and every lane a ferret adds follows it:

- **A lane for each thing the owner does.** Approve a plan (Plan/Design), test a release (Released · to test).
  These are `emphasis: action` lanes, and the Board draws them prominent.
- **One lane that says work is moving.** In progress. Review and CI fold into it: they are the ferret's to finish,
  not the owner's to act on. A separate review lane is only for a project where the OWNER reviews (the `writing`
  template's Review). These are `emphasis: progress` lanes, drawn as ordinary lanes.
- **Information only where it costs nothing.** Merged is kept as a compact, de-emphasised lane (`emphasis: info`).
  A release is what the owner can test, so released IS "to test": one lane, never two.
- **Closed keeps the board lean.** It is hidden from the Kanban (`emphasis: info`), and only the owner's Done
  enters it.
- **No lane the workflow does not need.** A ferret proposing lanes starts from a template and renames; it does not
  add lanes.

This section is the one owner of the rule; templates and the lane editor implement it.

## Lanes and categories

A project's lane set is a list of lanes plus, per workflow, which of them a card walks. A lane is a name the owner
can change; its **category** is one of six fixed values that the rest of the system reasons about.

| Category  | Means                                      |
| --------- | ------------------------------------------ |
| `backlog` | not started                                |
| `active`  | a ferret is planning or building it        |
| `review`  | built, waiting on review and CI            |
| `shipped` | merged or released, not yet confirmed done |
| `verify`  | waiting for the owner to try it            |
| `closed`  | done; only the owner closes                |

Each lane has an `id`, a `name`, a `category`, and optionally:

| Field        | Meaning                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enterOn`    | triggers that move a card here ([the table](#workflows-gate-and-automatic-stages)): `work.started`, `pr.opened`, `pr.ready`, `ci.green`, `pr.review_approved`, `pr.merged`, `release.published`, `release.running`, `signal.done`, `deploy.done`                                                                                                            |
| `stage`      | the lane's stage in the workflow: a gate the owner answers, or automatic ([Workflows](#workflows-gate-and-automatic-stages)); absent, it is read from `enterOn` and `ownerGate`                                                                                                                                                                             |
| `ownerGate`  | only the owner moves a card into this lane (`owner-gate` for a ferret)                                                                                                                                                                                                                                                                                      |
| `staleAfter` | how long a card may sit untouched here before it counts as stale                                                                                                                                                                                                                                                                                            |
| `emphasis`   | how the Board draws it: `action` (the owner acts here: prominent), `progress` (work moving: ordinary) or `info` (information only: compact). Absent, it follows the category: `verify` and an owner-gated lane are `action`, `shipped` and `closed` are `info`, the rest `progress`. A `verify` lane is always `action` and the `closed` lane always `info` |

A lane set also names the two lanes the owner's verdicts send a card to: **`doneLane`**, where Done (or Works)
moves it, which is the set's `closed` lane, and **`notGoodLane`**, where Not good sends it back, which is an
`active` lane where work resumes (In progress, Fix, Draft, Doing; a backlog lane only in a set with no active lane).
Templates declare both, the Kanban, the Table and the card detail all read them, and a set stored before they
existed reads with them derived: the closed lane, and the last active lane. An edit that names neither keeps the
set's own while those lanes are still there, so an app that predates them never resets them.

**Templates.** A ferret proposes a lane set from a template, then renames lanes if the project calls for it
(`packages/protocol/src/lib/board-lanes.ts`). Each is built by [the lane design rule](#the-lane-design-rule):

| Template            | Lanes                                                              | Done → / Not good →    |
| ------------------- | ------------------------------------------------------------------ | ---------------------- |
| `pr-release-verify` | Todo, Plan/Design, In progress, Merged, Released · to test, Closed | Closed / In progress   |
| `pr-release`        | Todo, Plan/Design, In progress, Merged; Released closes            | Released / In progress |
| `pr`                | Todo, Plan/Design, In progress; Merged closes                      | Merged / In progress   |
| `ops`               | Todo, Investigate, Fix, Verify, Closed                             | Closed / Fix           |
| `writing`           | Todo, Research, Draft, Review, Published, Closed                   | Closed / Draft         |
| `quick`             | Todo, Doing, To test, Closed                                       | Closed / Doing         |

In the PR templates In progress keeps its old id `implement` and is entered on `work.started`, `pr.opened` and
`pr.ready`; Released · to test (id `released`, category `verify`, owner-gated) is entered on `release.published`,
and the owner's Done moves it on. A card that signals done with no PR goes to Released · to test for the owner to
check. In `quick` (the Unfiled board's lanes) To test (id `to-test`, category `verify`, owner-gated) is entered on
`pr.merged`, `release.published` and `signal.done`: quick work has no release step, so a merge is what the owner
tries, and only the owner's Done closes. No shipped template uses `release.running`; it stays a trigger for a
hand-made set.

**`fy signal done` with no PR** moves a card still in an active lane to the lane its variant enters on `signal.done`,
else the first review or verify lane ahead: a review lane where one comes first (today's behaviour on a board that
has one), else the verify lane where the owner tries it. It never moves a card into a closed lane, because only the
owner closes, never out of a gate, and stops at a gate on the way. A card with a PR is left where it is; its PR moves it.

**A session starting on a card fires `work.started`.** `SessionCards` does it, for a card it just made (`fy new`,
`fy start`) and for one handed over by `fy new --card`, so a sub-ferret, who may not move cards, still lands in the
lane its workflow works in (In progress / Doing; Plan for `design-first`). A card already past that lane stays
where it is, and a failed move only warns: the session still starts. A card the lead makes with `fy task create`
has no session yet, so it stays in Todo until the lead passes `--lane` or moves it.

**Which lane, by what the work is.** `fy task move --help` and `fy board lanes show` give the rule by lane category,
and `lanes show` adds a "use when" per lane (`laneUse`, single-sourced in `@ferretry/protocol`): planning or designing
in the lane the owner gates (the owner approves leaving it), building in the active lane, a PR, a merge, a release and
`fy signal done` move a card by themselves, and blocked is not a lane (`fy task block`, `depend`).

A card's **workflow** (`quick`, `design-first`, `research-first`, `investigate`) selects its variant of the lane
set and cannot change after creation. In the PR templates only `design-first` and `research-first` work walks
Plan/Design.

**Released and To test became one lane.** Boards stored before board v3 had a `shipped` Released lane and a
`verify` To test lane after it, entered when this machine ran the release. At every boot the daemon folds any set
that still has that pair into one Released · to test lane (`mergeReleaseLanes`): the Released lane's id and place,
category `verify`, entered on release, gated as To test was. The cards of both end up in it, each moved card's
history says "Released and To test are one lane now: Released · to test", the set's version rises, its confirmation
stands, and the owner is asked nothing. It is idempotent. Nothing else on an existing board changes: Review/CI
stays a lane there until the owner edits it out.

**Quick lanes gained To test.** A `quick` set stored before it (Todo → Doing → Closed, closing on `signal.done`) had
nowhere for a merged card to go: facts never enter Closed, so a card whose PRs all merged sat in Doing. At every boot
the daemon gives such a set its To test lane between Doing and Closed (`addQuickToTestLane`): every lane keeps its
id, name and place, Closed becomes owner-gated and is no longer entered on `signal.done`, every variant walks To test
where it walked Doing or Closed, the version rises, the confirmation stands and the owner is asked nothing. No card
moves in the migration itself; the cards whose PRs merged then move to To test on their facts, each with its own
history ("PR #985 merged"). It is idempotent. The Unfiled board with no stored set reads the new template directly.

A FIRST proposal, on a project with no lanes, is live at once but unconfirmed. The owner gets one agenda choice,
Accept or Edit ([agenda.md](agenda.md)); accepting confirms the set. Any later change a ferret makes waits for the
owner instead ([below](#a-ferrets-lane-change-waits-for-the-owner)). Edits are version-checked (a stale edit is a
`version-conflict`), and a lane cannot be removed without naming where its cards go. A project with no lane set
gets an inferred proposal: a repository with `v*` tags gets `pr-release-verify`, one
without gets `pr`, a folder with no repository gets `quick`.

### A ferret's lane change waits for the owner

Lanes are where the owner's gates live, so changing them is the owner's to decide. **A ferret's `propose` or
`edit` of a project that already HAS lanes never goes live.** The daemon stores it beside the live set as the
set's `pending` proposal (`LaneSet.pending`, `decideLaneChange` in
`packages/daemon/src/lib/board-projects/lane-set-policy.ts`), and the live set stays in force: no gate changes, no
card moves, nothing the board decides is different. A ferret could otherwise make Plan/Design or Released · to
test an automatic step and watch its card move on, or remove Released · to test with its cards sent to Closed.

- **What the owner sees.** One Accept / Edit choice on the proposing ferret's agenda, "Lanes for <project>: A →
  B → …", which says the board keeps its lanes until the owner accepts and names EVERYTHING the change would do
  that is the owner's to decide (`laneGateProblems`, `@ferretry/protocol`): each lane it removes and where that
  lane's cards go — into the closed lane (named by its category, never by a name the proposal gives it), into a
  lane that is new, or past a gate — each gate it makes automatic, whose `ownerGate` it drops or whose answers it
  rewires, each lane it makes the closed lane, and each gate a workflow would skip or reach from a different place.
  A warning is never cut short: the proposer's name is capped, and what does not fit on the card is counted and
  pointed at the lane editor. `fy board lanes show` adds one line, "Proposed by <ferret>, waiting for the owner",
  and the lane editor a banner with the same warnings, in the same words; when there are any, its Accept takes a
  second tap ("Accept these changes"), saying that cards move and may close.
- **Accept makes it live, as the owner.** The owner's Accept on that card (only a person's answer counts: a lead
  may answer the daemon's items on its sub-ferret's agenda, and the daemon its own, but neither accepts lanes), or a
  `confirm` of the proposal's version from the lane editor, makes the proposal the live set, confirmed, and only
  THEN moves the cards of the lanes it removes. Those moves are recorded as the owner's, so they may close a card.
- **One proposal waits at a time, and it is its proposer's.** Only the ferret that made it (`proposerSession`), a
  lead above that ferret, or the owner replaces it; any other ferret is refused `proposal-waiting` (409), naming
  whose it is. Every proposal is numbered above the live set and every earlier proposal, so an older card never
  names a newer one. A proposal also carries the live version it was made against: once the live set moves on,
  accepting it is a `version-conflict`.
- **A card goes when its proposal does.** A proposal replaced by a newer one, accepted in the lane editor, or
  dropped (the owner's own edit, a boot migration) has its card closed on the proposer's agenda with the reason
  ("A newer proposal replaced this one; its own card is on the agenda."), so the owner never answers a card that
  would do nothing.
- **The owner's own edit stays immediate** and drops a waiting proposal. The owner confirming the live set itself
  leaves the proposal waiting, for its own answer.
- **A ferret's propose on unconfirmed lanes** waits too, and is refused `relocation-missing` when the template
  drops a lane: a template cannot say where that lane's cards go, so the ferret edits instead. Once the owner has
  confirmed a set, `propose` is refused `already-confirmed` as before.
- **Nothing flips at boot.** A set a ferret proposed before this, unconfirmed and live, stays live; only a change
  made from now on waits. A boot migration that rewrites a set's lanes (the release merge, quick's To test) drops a
  waiting proposal, since it was made against the lanes before.

**No relocation but the owner's closes a card or passes a gate.** Every move of a removed lane's cards runs the
checks an owner-less move does (`relocationProblems`): a relocation that is not the owner's never puts a card in
a closed lane, never takes it forward out of a gate (even into another gate: that skips the owner's answer) and
never carries it forward past one, nor into a lane the set lacks; a move back is allowed. A ferret's change moves
no card at all (it waits, or it is a first proposal on a board with no cards), a boot migration that would need
such a move is reported and left undone, and `BoardService.relocate` runs the same checks itself on every move
that is not the owner's, judged from the lanes the cards were in: a card it may not move stays put, and the
diagnostics say why.

## Workflows: gate and automatic stages

A project's lanes are its workflow, and each lane is one **stage** of it, of one of two kinds:

- A **gate** asks the owner. It has one to three options, and each option has an outcome: `next` (the next lane of
  the card's variant), `lane` (a lane of the set, by id), `reopen-with-agenda` (back to the set's `notGoodLane`,
  with the owner's words, which a conversation about them follows) or `close` (the set's `doneLane`). The Inbox
  draws the options as →, ← and a button, so their ids are unique, at most one reopens with an agenda conversation,
  and a label is one line of at most 24 characters. A gate lane is still entered the way any lane is, on its
  `enterOn` triggers: its stage says how a card leaves it.
- An **automatic** stage moves a card in on its triggers. With none, the ferret moves it there.

Ferretry's own workflow is build → merge → release → **try it** (Done / Not good). A labelling project's is prepare
the PRs → **send for review?** → wait for approval (`pr.review_approved`) → merge and deploy (`deploy.done`) →
**confirm deployed?**. Raising one agenda item when a card reaches a gate, and answering it, is work in flight
([below](#gaps-and-work-in-flight)); this section is the model it is built on.

**A stage is optional, and `enterOn` and `ownerGate` stay its compatibility mirror.** `stage` is optional on the
wire and in storage. A lane without one reads the stage its other fields describe (`laneStage`, in
`@ferretry/protocol`, pure and total):

| A lane with no `stage`                        | Reads as                                                          |
| --------------------------------------------- | ----------------------------------------------------------------- |
| a `verify` lane, owner-gated or not           | a gate: Done (`close`), Not good (`reopen-with-agenda`)           |
| any other owner-gated lane but the closed one | a gate: OK to build (`next`), as Plan/Design                      |
| the `closed` lane                             | automatic on its own `enterOn`; only the owner enters a gated one |
| anything else                                 | automatic on its `enterOn`, or on nothing when it has none        |

A lane that states a stage keeps its mirror agreeing with it, settled where a lane is parsed (`LaneSchema`), so
either spelling round-trips. A gate is owner-gated: a lane that leaves `ownerGate` out gets `true` (a `verify` lane is
the owner's by its category, so its `ownerGate` is left as it is). An automatic stage enters on its triggers: a lane
that leaves `enterOn` out gets them. A field that disagrees is refused: a gate on the closed lane, a gate with
`ownerGate: false`, an automatic stage whose triggers are not its `enterOn`, an automatic lane that is owner-gated. So
an app that predates stages reads every lane right, and the helpers that read the mirror (`laneForTrigger`,
`laneUse`) answer as they did. `needsOwner` reads the stage as well as `ownerGate`: a move forward out of any gate
is the owner's, so a ferret's move out of a `verify` lane is refused `owner-gate` even where the lane is not
owner-gated (before stages it went through), and a move and a report agree on every gate. An app that predates stages drops the field when it saves a set,
and the lanes then read their derived stages again: only options the owner had changed are lost. The lane editor
drops a lane's stored stage when its category or its gate changes, or the triggers of an automatic one, so a saved
lane is never refused for a stage its fields no longer describe.

`gateOptions(lane)` lists a lane's options, none for an automatic stage. `gateOutcomeLane(laneSet, workflow,
laneId, optionId)` says where an option sends a card: `{ option, lane }`, or `not-a-gate`, `unknown-option`,
`no-next-lane` (a `next` from the variant's last lane) or `unknown-lane`. Who may answer a gate is the daemon's to
decide, not this function's.

**Triggers.** What moves a card into a lane by itself. Most are facts Ferretry sees; the **external** ones happen
where it cannot look, and somebody reports them (`EXTERNAL_LANE_TRIGGERS`).

| Trigger              | When                             | Who knows                                                                       |
| -------------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| `work.started`       | a session starts on the card     | the daemon                                                                      |
| `pr.opened`          | a linked PR opens                | the GitHub watcher                                                              |
| `pr.ready`           | it is out of draft               | the watcher                                                                     |
| `ci.green`           | its checks pass                  | the watcher                                                                     |
| `pr.review_approved` | a reviewer approves it           | **reported**: the watcher reads a PR's state, checks and merge, not its reviews |
| `pr.merged`          | it merges                        | the watcher                                                                     |
| `release.published`  | a release contains its merge     | the watcher                                                                     |
| `release.running`    | this machine runs that release   | the daemon                                                                      |
| `signal.done`        | the ferret runs `fy signal done` | the daemon                                                                      |
| `deploy.done`        | a deploy finished                | **reported**: it happens where Ferretry does not run                            |

**Reporting an external trigger.** `POST /v1/board/tasks/:taskId` with
`{ "action": "trigger", "event": "deploy.done", "reason": "deployed to production" }` (`reason` optional). Only an
external trigger is taken: any other is `400 invalid` before it reaches the board, because a merge or a release is
read from GitHub, never taken on a caller's word. The owner, the card's owner ferret, its leads and its assignee may
report one, and so may a sub-ferret on the card it is doing, since it is the one that saw the deploy; anyone else is
`403 forbidden`. The move is the daemon's, through the same `triggerMove` every fact uses: into the first lane of
the card's variant that enters on the trigger, recorded `auto` with the trigger and with `reportedBy` naming who
reported it (and `reportedVia: "admin-token"` beside it, as `actorVia` is beside an actor). It never goes back: a
card already there or past it is unchanged, and the answer is the card as it is. A dependency holds it as it holds a
move: a blocked card is not moved on to a later category (`409 blocked-by`, naming the blockers); sideways it moves,
and says what blocked it, and the owner's report moves it on as a fact would. A sub-ferret reports only on the card it
is doing (its assignee, else its owner): on any other card its standing reaches it is told to tell its lead. In the
card's history the move reads as by whoever reported it, never as Ferretry's own ("denisha · reported deploy.done →
moved In progress → Deployed"; the admin token is said for what it is), in the app and in `fy task show` alike
(`boardEventActor`). It is `400 invalid` for a dropped card or a board with no lane for the event. It is
`403 owner-gate` for a move into an owner-gated closed lane, whoever reports it, and, unless the owner is the one
reporting, for a move into any closed lane (a fact may close a set with no verify lane, a caller's word may not) or
past a gate the owner has not answered: the card's own lane, or one its variant walks between that lane and the
target. Entering a gate is not passing it.

So a report never takes a card anywhere the owner decides. A report after the owner's Not good may move the card on
again, and that is accepted: with every gate, every closed lane and every unshipped dependency out of its reach, it
only reaches a lane its lead could `fy task move` it to anyway, and the history says who reported what.

**Every lane's stage is written out at boot.** Every template lane states its stage. A set stored before stages has
none, so at every boot, after the two migrations above, the daemon gives each lane without one the stage it already
reads as (`stageLanes`): nothing a reader decides changes and no card moves, a lane that has a stage keeps it, the
confirmation stands and the owner is asked nothing. The VERSION STAYS, unlike the migrations above, because the set
means what it meant: an edit made against it still applies, and the Accept on a pending proposal's card still
confirms it. A damaged set is refused by the store, as on any read, reported, and the other projects go on, and a
staged set the next read would refuse is never written. It is idempotent: a set whose every lane has a stage does
not match.

## Cards and their fields

A card is stored as `BoardTaskSchema` (version 1) at `<state>/board/tasks/<id>.json`; the counters are in
`<state>/board/counters.json` and the lane sets under `<home>/board/lanes`. Reads return the **view**, the stored
fields plus the ones the daemon derives.

| Field                   | Meaning                                                                       |
| ----------------------- | ----------------------------------------------------------------------------- |
| `id`, `kind`            | `<B\|F\|I\|C><n>`; the kind is fixed because the prefix must match it         |
| `projectId`, `laneId`   | the board and the lane the card is on                                         |
| `title`, `summary`      | a short name, and the one line the card face shows                            |
| `ask`, `clarifications` | the owner's words verbatim and where they were said; later words are appended |
| `premise`, `context`    | why the work exists; what a newcomer needs to know                            |
| `terms`, `brief`        | glossary entries for the card; the full plan, or a sub-ferret's brief         |
| `howToTest`             | how the owner checks the result before Done; empty on a card stored before it |
| `owner`, `assignee`     | the accountable ferret; the one doing it now (none reads as the owner)        |
| `parent`                | the lead's card, possibly on another project's board; the roll-up follows it  |
| `dependsOn`             | cards this one waits on, each with an `until`                                 |
| `blocked`               | an external block with its reason, or none                                    |
| `dropped`               | why the card was dropped, or none                                             |
| `workflow`              | selects the lane variant; immutable                                           |
| `links`                 | PRs, branches, commits and documents                                          |
| `files`                 | advisory: the files the work expects to touch                                 |
| `order`                 | the owner's manual order within a lane                                        |
| `history`               | every move and note, each with who and why; at least one event                |
| `legacyRef`             | `<sessionId>:<oldId>` for a card imported from the old per-session files      |

The view adds fields that are never stored:

| Field                        | Meaning                                                           |
| ---------------------------- | ----------------------------------------------------------------- |
| `lastTouchedAt`, `touchedBy` | the latest real activity on the card or any descendant            |
| `activity`                   | `active`, `idle`, `stale`, `waiting` or `orphaned` (see below)    |
| `rollup`                     | a parent's children counted by category, and how many are working |
| `suggestedLane`              | the lane the children suggest moving a parent to                  |
| `waitingOnOwner`, `openAsks` | open agenda items against the card, blocking or all               |
| `blockedBy`, `blocks`        | dependencies not yet done; the cards that depend on this one      |
| `shippedIn`                  | the earliest release a merged PR of the card shipped in           |
| `origin`                     | `human` (the owner asked for it) or `agent`; see below            |
| `humanParent`                | the nearest ancestor card whose origin is `human`, or none        |

A card is referenced as `&F412`, an agenda item as `!A48`. The retired `#F12` is still accepted as input, and
never printed ([reference-standard.md](reference-standard.md)).

## How a card reads

Every text a ferret writes on a card — `summary`, `premise`, `context`, `brief` and `howToTest` — is Markdown,
drawn by the chat's one renderer (`ChatProse`), so `fy-render` hypermedia (mermaid, svg, html, chart, image…) draws
exactly as in a message or an agenda card ([fy-render.md](fy-render.md)), and references are read through the one
grammar and its proof-before-link gate ([reference-standard.md](reference-standard.md)). The card detail reads top to bottom
as an agenda card does, with nothing folded:

1. the title, with the **summary** as one line under it;
2. **premise** and **context** as two soft tinted blocks, each label above its points (the agenda card's own
   `Situation` and tokens); a repeated `--premise` / `--context` is one bullet each;
3. the owner's **ask**, verbatim, with its clarifications;
4. **How to test**: a list is drawn as numbered steps, each with a box the owner ticks as they go (on that screen
   only — a tick is a reminder, never a verdict); text that is not a list is drawn whole. On a card waiting to be
   tested, **Not good** (left) and **Done** (right) sit right under it, and a swipe right is Done, left is Not good;
5. the **brief**, then the **terms** — and each term is also a dotted tap tip where the card's text first uses it.

A good How to test says where to go, what to do and what the owner should see, on which machine and version:

```markdown
On the Mac, once it runs v4.157:

1. Open the Board and tap a card in Released · to test.
2. Scroll to How to test, and tick each step as you check it.
3. You should see Done and Not good right under the steps.
```

The kanban card face shows the summary as one truncated line under the title (not in the side pane, which keeps
one short line), a small **How to test** marker when the card has one, and a quiet **no test steps** on a card in a
`verify` lane that has none, so a missing one stands out to the lead.

`fy task create` and `fy task edit` take `--how-to-test <md>` or `--how-to-test-file <path>`; any ferret that may
edit the card may write it (it is not a re-plan). A sub-ferret cannot edit cards, so it puts the steps in its report
and its lead writes them.

## Human and agent cards

The Board shows what the OWNER asked for by default, and folds the rest away behind "Show agent tasks", each agent
card under its `humanParent` where it has one. `origin` is derived at read time by one pure rule, `cardOrigin` in
`packages/daemon/src/lib/board/origin.ts`, and never stored. A card is **human** when:

1. the owner made it (the Board page, a paired device, the admin CLI);
2. its ask's source names the owner (`owner`, "owner via lead jaeda", "the owner (fy task reopen)"), whoever wrote
   it down; or
3. a ferret recorded it from a session the owner started: the source's `session:<id>`, else the recording ferret
   itself. Only the owner talks in such a session.

Everything else is **agent**: the card of a sub-ferret a lead started (`fy new`, or `fy start` from a ferret,
whose ask is `session:<lead>`), the daemon's own cards (the board import's untriaged asks), and a card a
sub-ferret recorded from its own brief. Whether a session was started by a ferret is its `config.parent`, read once
per session per board read; a session this daemon cannot read counts as the owner's, so a card is never hidden on
a guess.

The rule cannot tell a top-level ferret's own idea from the owner's words in that ferret's chat; both read as
human, which errs toward showing the owner a card. Both fields are optional on the wire: a daemon older than the
split sends neither, and the app then shows every card and no toggle.

### Cards to test: a person asked

The Inbox's To test section, Answer quickly, and the chat task panel's Cards view list only the cards a PERSON asked
for, so the owner is not flooded with the follow-ups their ferrets file for themselves. That is `askedBy` on a card
(`person` or `agent`), and the card STORES it: the daemon decides it once, when it creates the card, and never from
the request (the create body has no such field, so a caller cannot claim it). `decideAskedBy` in `origin.ts` says
`person` when any of these holds:

1. the owner's own app made it (an owner caller that is not on the admin token, which a ferret can hold too);
2. the ask's source names the owner (`owner (board)`, "owner via lead jaeda");
3. the ask's text matches words the OWNER said to the session it came from (`wordsSessionOf`: the session id the
   source names, in any form — `session:<id>`, `session <id>`, a turn document's path — else the recording ferret),
   whoever wrote the card down: a ferret on the admin token is stored as `owner` and the board import as `daemon`.

Anything else is `agent`, including every card whose session is unknown. The owner's words
(`adapters/board/session-owner-words.ts`) come from three records of that session:

- its queue, in any delivery state, whose messages say who sent them;
- its send ledger (`channel/sends.jsonl`), which records every send's sender (`senderKind`, `by`) and the turn it
  started, back to before the queue existed;
- every turn document (`turns/turn-NNN.md`) no send accounts for — a revive's, or one older than the ledger. One with
  an author file (`turn-NNN.by.json`) is the owner's only when that file says so. The first turn of a session a ferret
  started is that ferret's brief and is left out.

A message with no recorded author is the owner's unless it is wrapped as a ferret's (`[message from ferret …`), less
any paragraph that is Ferretry's own notice (a board or Warden notice, "CI is red", "has had no activity", a turn-end
check): a busy session is handed those in the same delivery as the owner's next message. An agenda answer
(`[answer to !A…`, `[re !A…`) is the owner's. What was read is kept per session and read again only when the
turns directory changes, so a lead with thousands of turns is not re-read for every card.

Two texts match on their letters and digits alone (case, spaces and punctuation ignored, so a full stop joining two
lines or a mended "yo uhelp" still matches) when one contains the other and the shorter has at least 24 characters, or
when the ask is pieces of the owner's messages joined by `...`, `…` or `/`, each piece found in one of them and the
longest at least 24 characters. **A paraphrase does not match**: a ferret that rewrites the owner's ask in its own words
gets an `agent` card, which is still on the Board.

Every boot decides again each card not already `person` (`BoardService.backfillAskedBy`): a card from before the
field, and a card stored `agent` from fewer of the owner's words than are read now. It uses the same rule except that a
stored creator of `owner` proves nothing (it reads that way for a ferret on the admin token), so it is the source and
the owner's messages that decide. It only ever adds `person` — a stored `person` may rest on a fact it cannot see again
(the owner's own app made the card) — and writes only a card it changes. The pass writes no history event and does not
touch the card's last-touched time, is idempotent, and a card it cannot settle is reported and tried again next boot. A view reads the stored value,
and falls back to the ask's source (`cardAskedBy`) only for a card not yet backfilled. A daemon older than the field
sends nothing and the app reads that as `agent`. The cards left out are still on the Board, and each card shown names
its project beside its machine.

## Authority

Who may write a card follows from the card itself and from the lineage of the session asking; there are no roles to
grant. This replaced the old `task-boards` access list. The code is `packages/daemon/src/lib/board/authority.ts`.

| Standing      | Who                                                        | May                                                                               |
| ------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `owner-human` | the owner: loopback, or a device the `fleet` grant let in  | everything, including owner gates and dependency overrides                        |
|               | (on the admin token it is recorded as `admin-token`)       |                                                                                   |
| `owner`       | the card's owner ferret                                    | the assignee's writes, plus re-plan                                               |
|               |                                                            | and, on an INTERNAL card, passing its gates                                       |
| `ancestor`    | a ferret above the owner in the `parent` chain of sessions | the same as the owner                                                             |
| `assignee`    | the ferret doing it                                        | move, note, link, block, edit files, clarify, reopen, report an external trigger  |
| `daemon`      | the daemon's own automation                                | trigger moves, link cache, refile, relocate a removed lane's cards (never closed) |
| `reader`      | any other ferret                                           | read; depend, but only from its own card                                          |

Re-plan means retitle, rewrite the brief, reassign, drop and reorder. The one re-plan write an `assignee` has is handing the card DOWN: it may assign it to one of its own descendants (`fy new --card`, `fy task assign <child>`), recorded as "handed down by" the assignee; never sideways, upward or to nobody. A sub-ferret that is the assignee may do it too: it is the one reassign the sub-ferret limit lets through. A ferret never moves a card on out of a gate
or past one (a lane whose stage is a gate, owner-gated or a `verify` lane), and only the owner closes — except on an internal card, whose owner ferret and its leads pass its gates
and close it ([Gates ask the owner](#gates-ask-the-owner)). A ferret's change to a project's lanes waits for the owner
([above](#a-ferrets-lane-change-waits-for-the-owner)). Reaching the routes at all is a `fleet` capability matter for a caller
who is not on this host ([grants.md](grants.md)).

## Done and Not good

The owner's two answers about a card, on every surface that shows one (Kanban, Table, card detail):

- **Done** moves the card to the project's Closed lane, and its ferret is told in one plain line.
- **Not good** opens a small composer: the words, plus any images or files. It is the owner's move back, so it
  is a reopen: the card goes back to the rework lane, the words are added to its clarifications, and the
  ferret is sent them through its queue as the owner. The `reopened` history event names the files, so the
  card reads "reopened Released → Implement … with 2 images".

The files travel as ordinary chat attachments. The app uploads them to the card's ferret (its assignee, else
its owner ferret) through the session attachment route, then names them on the move (`attachments: { from,
ids }`). The daemon refuses files from anyone but the owner, files in any other session, and files on a move
that sends nothing back. Whichever ferret the reopen reaches gets a copy in its own session; if the copy
fails, the line still lands with a sentence saying the files did not. A daemon reports
`board.reopen.attachments.1` on `GET /v1/health` when it takes files; the app offers attaching only there.

The upload rides the same carrier as every other call to that machine (the router's fetch), because a paired
device holds no bearer value: the device key that opened the session is the credential, and a request sent over
the raw network reaches the daemon as nobody and is refused `401 unauthorized`. The session attachment store
keeps files by session id and does not require the session to be running, so a card whose ferret has stopped or
finished still takes files; they wait in that session until the reopen carries them to whichever ferret it
reaches. A `401 unauthorized` on an upload reads "pair it again from Settings", not the bare word.

While a move is in flight, the pressed button shows a spinner and both answers are disabled; a refusal is
shown next to them.

## Gates ask the owner

A lane whose stage is a **gate** waits on the owner (Plan/Design's OK to build, Released · to test's Done / Not good;
a lane stored without a stage reads with one, `laneStage` in `@ferretry/protocol`). The owner is asked on the agenda,
never by the ferret: a card that reaches a gate raises **one** agenda item, and that item is the gate's only signal.
The code is `GateItems` (`packages/daemon/src/lib/board/gate-items.ts`); the wire is `AgendaItem.gate`
([agenda.md](agenda.md#gate-items)).

**Entering.** After every committed write of a card, by any path — a move, a trigger, PR facts, a refile,
`fy signal done`, a lane edit's relocation — a card the owner asked for (external, below) that sits in a gate lane
has its one item: raised by the daemon on its ferret's agenda (the assignee's, else the owner ferret's, running or
stopped), `task` naming the card, kind `choice`, the gate's options as its answers, `sourceRef`
`gate:<card>:<lane>:<entry>` where `entry` is the history `seq` of the event that put the card there. The same
entry is never raised twice, open or closed, so a restart, a second write or the owner's Not needed asks nothing
again. At boot every card already waiting at a gate gets its item once, in the background. A card none of whose
sessions the daemon knows gets no item and the daemon log says so.

**Answering** is the owner's alone: at the machine (the admin token, recorded `admin-token` on the card) or from a
paired device the `fleet` grant lets use the board — exactly who could have moved the card on the Board. The card
moves FIRST, through `BoardService` as the owner, so authority, history and the done and reopen ladders are the
board's own; only a move that went through answers the item, and a refused move leaves it open with the reason
(`409 gate_not_moved`).

| Option outcome          | The card                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `next`, `lane`, `close` | moves there, reason "<option> (from the Inbox)"; Done tells the ferret in the done ladder's one line                      |
| `reopen-with-agenda`    | needs the owner's words (`400` without): reopened to the set's Not good lane as the owner's Not good is, the words a      |
|                         | clarification and sent to the ferret by the reopen ladder, and ONE follow-up conversation (below)                         |
| "Not yet"               | the extra answer of a gate with one option: the card stays; words, if given, are a clarification and reach the ferret     |
| Not needed (dismiss)    | the owner's choice: the card stays where it is, quietly; that entry asks nothing again (a device needs the `fleet` grant) |

**The follow-up.** Not good opens one conversation about the card: a `reply` item raised by the daemon on behalf
of the card's ferret (`sourceRef` `gate-followup:<card>:<entry>`), on the ferret's turn in discussion, raised only once the
reopen went through (a refused Not good opens none). The ferret answers it like its own: `edit` or `surface` hands it to
the owner, `done` closes it (a sub-ferret's lead does that, as with every item on a sub-ferret's agenda). The owner's
answer reaches the ferret as on its own item. It closes by itself when the card next reaches the gate.

**Leaving.** A card that leaves the gate any other way — the owner's move on the Board, a drop, a refile —
has its open gate item resolved quietly: "the card moved on".

**Only the owner passes a gate.** Their answer to its item, or their own move or report (and, on an internal card,
its owner ferret's or a lead's move, below). Every other path may bring a card INTO a gate and move it between
automatic stages, never out of one or past one: a ferret's `fy task move` (refused `owner-gate`, naming the lane),
a daemon trigger (`work.started`, a PR, a release — it stops in the first gate on its way, and the history says
"stopped at <lane>, which waits for the owner"), PR facts (they never pull a card back out of a gate for an open PR
either), `fy signal done` (held, or stopped at the gate) and a refile's facts. A refile by anyone else never lands a card
past a gate of the other board's variant: it stops in the first one on the way, and a lane named past one is refused;
and a card waiting at a gate lands at a gate of the same stage or earlier, never a later one; a dropped card is reopened by anyone else only where it was dropped, or earlier. Leaving a gate is
`needsOwner`'s and a gate on the way `gatesBetween`'s (`card-actions.ts`), both from each lane's stage
(`laneStage`), so a `verify` lane with no `ownerGate` is a gate too. A ferret may still move a card back out of a
gate, with a reason. A card's workflow never changes, so no variant can skip one.

**Lane changes.** A ferret's lane edit or proposal over a live set never goes live: it waits for the owner
([A ferret's lane change waits for the owner](#a-ferrets-lane-change-waits-for-the-owner)), and what it would do to a
gate (`laneGateProblems`, `@ferretry/protocol`) is what its Accept card and the lane editor say: remove a gate lane,
make it automatic, drop its `ownerGate`, move it among the lanes a variant walks, let a variant skip it, rewire its
options, or send cards into a closed lane, into a new lane, or past a gate of the new layout.

**Answers, one at a time.** Answers to one card's gate take turns, and each move is written only if the card still sits
in that gate by the entry the item asked about; anything else is `409 gate_not_moved` and the item stays open. A
bare done (`resolve` without an answer) is refused: the owner answers it or says Not needed. Clearing the agent
ferrets' backlog never touches a gate item, and a chat message naming one never parks it (one parked before is
brought back on the card's next write).

**A PR opened while the card waits.** The card stays at the gate; its item says so in its context ("A new PR is open
for this card: <url>", one line per open PR), refreshed in place when the PR opens or closes, so the owner waits or
says Not good. Done while it is open closes the card as usual.

**Nobody else answers.** A ferret, a lead over its sub-ferret (`overSubFerret`) and the daemon are refused every
verb that would answer, close or reword a gate item (`answer`, `done`, `dismiss`, `edit`, `surface`); a ferret's
raise that carries a `gate`, a `gate:` reference or a discussion start is refused too. The agenda's state machine
holds this, not the app.

**Notifications.** The gate item buzzes the phone once, at its raise, and is never counted in a stop's push
([notifications.md](notifications.md#when-the-phone-buzzes)). Nothing else announces the gate: no task notice, no
second push. A daemon that raises gate items lists `board.gate-items.1` on `GET /v1/health`, and the app hides its
own to-test rows only for such a machine.

**Internal cards.** A card that is positively a ferret's own errand never raises a gate item, never buzzes and is not
in the Inbox. Only what the daemon recorded decides it, never what a ferret wrote: the daemon made the card (`createdBy`
`daemon`: a board import, or the card `fy new` makes for a sub-ferret — written by that start alone, kept by every
hand-over, refile and reopen), or the session that wrote it was started by a ferret (a sub-lead's own card); AND no
person asked for it (`askedBy` is not `person`). Anything else — a top-level ferret's `fy task create`, whatever its
ask's source says; a lineage that could not be read — is EXTERNAL. One function decides it for the gate items and for
who passes the gate alike (`BoardService.audienceOf`, `cardAudience` in `origin.ts`), so an external card at a gate
always has its item, and an internal one always has someone who may pass it. By design a lead's `fy new` sub-card is internal even when the lead is top-level: the owner's own session card
stays external and gated, so the owner still passes the gate that matters. An imported legacy task that recorded no
creator is read as the owner's.

| Standing             | External card's gate | Internal card's gate |
| -------------------- | -------------------- | -------------------- |
| `owner-human`        | passes               | passes               |
| `owner`, `ancestor`  | refused              | passes               |
| `assignee`, `reader` | refused              | refused              |
| `daemon`             | PR facts only        | PR facts only        |

**GAPS.** Every guarantee here holds against a ferret on its own session credential. The admin token with no session
(an older `fy`, `fy --as-owner`) still has the owner's authority and is only RECORDED as `admin-token`
([The board is opt-in](#the-board-is-opt-in), &F291). The Inbox's Not good carries words only: the agenda answer has no field for files, so a picture still goes
through the Board's Not good. A closed gate item is remembered only as long as the agenda keeps it
(`MAX_AGENDA_RESOLUTIONS`): a card left at a gate the owner dismissed long ago may ask again once its record is gone.

## Activity and staleness

Activity is attributed to a session's focus card (`config.focusTask`, set by `fy task focus` and by creating a
card). The first state that applies wins:

| State      | When                                                                 |
| ---------- | -------------------------------------------------------------------- |
| `active`   | an attributed session is working now                                 |
| `orphaned` | its ferrets are gone while the card sits in an active or review lane |
| `waiting`  | on the owner, an external block or another card; never stale         |
| `stale`    | idle past its lane's `staleAfter`                                    |
| `idle`     | none of the above                                                    |

A lane without its own `staleAfter` uses the category default: backlog 3 days, active 2 hours, review 24 hours,
shipped 3 days. Verify and closed never go stale. An unassigned child card still in a backlog lane is nobody's work yet, so it
never keeps its parent from being `orphaned`; an assigned or started child does.

The **sweep** (`packages/daemon/src/lib/board/sweep.ts`) ticks on its own and does two things. It nudges the ferret
of a stale card, at most once per card per `staleAfter`, never one that declared a wait, never for a waiting card.
It also queues quiet events: a child's move, block, drop or new blocking ask goes to its lead, and `&F20 unblocked`
goes to a dependent's assignee. Quiet events ride the next message and never start a turn
([ferret-messages.md](ferret-messages.md#board-events-that-ride-the-next-message)). The first sight of a card is a
baseline, not news.

## Lanes follow PR facts

A card never sits behind its own PR. `laneFromFacts` (`packages/daemon/src/lib/board/lane-facts.ts`) is the one
owner of where PR facts put a card: all PRs merged and released is the `release.published` lane (Released · to
test; in a hand-made set that still has a `release.running` lane, that one once this machine runs the release), any
merged with none open is `pr.merged`, any open is `pr.opened` / `pr.ready`, and otherwise no opinion. It never moves
a card backward, with one exception: any open PR, draft or not and however old, on a card that has shipped
something pulls it back to where `pr.ready` goes (In progress, or Review/CI on an older board: "moved back to In
progress: PR #1013 ready for review"), because work still in flight means the card is not shipped. A PR closed
unmerged says nothing. Nor does a fact move a card out of Closed or a drop, or into a Closed lane in a set with a
`verify` lane. A fact never passes a gate: it moves a card into one and stops there, and it neither moves nor pulls back
a card waiting at one (Plan/Design, Released · to test), whatever its PRs say
([Gates ask the owner](#gates-ask-the-owner)); the "pulled back" exception above applies only outside a gate.
The GitHub watcher reconciles every linked card on every poll, refile and `fy task link --pr` re-evaluate at once, and a
PR nobody has asked GitHub about is polled on the next tick. A card the owner sent back stays back until a PR newer
than that move merges. History names the fact; no move is ever typed into a chat
([ferret-messages.md](ferret-messages.md#what-the-board-types-into-a-chat)).

The watcher itself polls GitHub through the host's `gh` about once a minute while a repository has an open linked
PR, and every ten minutes otherwise, and after `gh` is missing or signed out. Every tick also re-reads each open card's lane set
and reconciles the card against it, PRs that can no longer change included, so a lane set that gains a lane (the
boot migrations) moves its cards on the first tick after boot, with no call to GitHub.

## Dependencies

A card waits on another with `dependsOn`, stored on the dependent. `blocks` is the inverse and is derived, never
stored.

- `until` is `shipped` (the default) or `released`: how far the dependency must get before the dependent may advance.
- While a dependency is not done, the dependent can move sideways or back but not on (`blocked-by`). Only the owner
  overrides it, with a reason (`fy task depend --override`).
- A cycle is refused (`cycle`), and a card does not depend on itself.
- When the last blocker ships, the dependent's assignee hears `&F20 unblocked: &F18 merged` on its next message.
- A ferret may add a dependency only from its own card.

## Agenda and cards

An agenda item names the card it is about. `fy agenda add --task <id>` sets it, defaulting to the calling
session's focus card ([agenda.md](agenda.md)). The card's view then derives `waitingOnOwner` (open, blocking items)
and `openAsks` (every open item), and a card with open blocking items is `waiting`, not stale. The link is optional
in the agenda's schema, so an item raised with no focus card simply belongs to no card; the board import creates a
card for the open items it finds that name none ([board-import.md](board-import.md)).

## The turn-end check

When a turn ends, the daemon reads it (`packages/daemon/src/lib/board/turn-check.ts`) — **only on a board that is
on** ([The board is opt-in](#the-board-is-opt-in)). If the turn did **mutating work** while the session had **no focus
card in an open lane**, the ferret gets one queued message:

```text
You changed code this turn without a card. Create one (fy task create …) or record why not: fy task skip "<why>"
```

- **Mutating work** is the turn's own tool calls: an edit tool (`Edit`, `MultiEdit`, `Write`, `NotebookEdit`,
  Codex's `apply_patch`), or a shell command running `git commit`, `git push`, `fy new` or `gh pr create`. A
  read-only turn — questions, research, a plan — never triggers it.
- **An open lane** is any lane whose category is not `closed`, on a card that is not dropped. A focus card that is
  gone counts as none.
- **At most once an hour per session.** The send id carries the hour, so a turn end seen twice is one message.
- **A turn the check started is never checked**, so answering it cannot loop.
- **When in doubt it says nothing**: a transcript, session or card it cannot read sends no message.
- Each nudge is journalled on the session as `board.unfiled-work`, with the work it saw.

The check is a queued nudge, not a refusal to end the turn (`board-design.md` §7, decision 2).

### The gate check

A card that reaches a gate stage raises **one** agenda item for the owner itself — the daemon does, so there is never
a task notice and an agenda notice for the same thing. A ferret that also raises its own item on that card makes the
owner answer twice, so a second check reads the same turn end
(`packages/daemon/src/lib/board/gate-check.ts`, `BoardGateCheck`). If the turn raised an agenda item (`fy agenda add`,
or an `*_ask_owner` tool) that is open on a card **currently** in a gate lane, and the daemon's own gate item for that
card (`sourceRef` `gate:<card>:…`) is open too, the ferret gets one queued message per item:

```text
&F412 is at a gate; the daemon already asked the owner (!A31). Drop yours: fy agenda dismiss !A44
```

- **Once per item.** The send id carries the item, so a turn end seen twice is one message.
- **A turn the check started is never checked**, so answering it cannot loop.
- **Only on a board that is on**, and never for a sub-ferret (it raises no agenda items).
- **When in doubt it says nothing**: no gate item to point to, a card or session it cannot read, or a turn whose start
  time is unknown sends no message.
- Each nudge is journalled on the session as `board.gate-nudged`, with the items it named and their cards.

## `fy task skip "<why>"`

Records that this session's work needs no card — chit-chat, or the owner said not to track it — as
`config.boardSkip` (`{ reason, at }`) on the calling session, through `POST /v1/board/skip`. Only a ferret records
one, and only for itself; the owner has no session to record it on. While a skip stands the turn-end check stays
quiet. Taking a card (`fy task create`, `fy task focus`, a start) clears it, so a later ask is checked afresh.

## `fy ps`

The CARD column shows each session's focus card and its lane (`&F18 Plan/Design`). A running ferret with no card
shows `—` in amber.

## Commands

Every `fy task` verb takes `--session <id>` (act as that session instead of the ambient one) and `--json`.

| Verb                                              | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fy task create`                                  | make a card: `-k/--kind`, `-t/--title`, `--summary`, `--ask`, `--ask-source`, `--premise`, `--context` (each repeatable, one bullet each), `--term`, `--brief`, `--brief-file`, `--how-to-test`, `--how-to-test-file`, `--workflow`, `--depends-on`, `--parent`, `--assignee`, `--project`, `--lane`, `--file`, `--pr`, `--branch`, `--doc`; asks the daemon first and refuses a strong duplicate unless `--new` (or `--related <id>` notes that card instead) |
| `fy search <words>`                               | find cards and agenda items by what they say; `--kind`, `--open`, `--project`, `--limit`, `--json`                                                                                                                                                                                                                                                                                                                                                             |
| `fy task show <id>`                               | print one card                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `fy task move <id> <lane>`                        | move it; `--reason` is required for a move back                                                                                                                                                                                                                                                                                                                                                                                                                |
| `fy task trigger <id> <event>`                    | report an external event for a card (`pr.review_approved`, `deploy.done`); the daemon moves it if a lane waits on it. A sub-ferret may run it                                                                                                                                                                                                                                                                                                                  |
| `fy task focus <id>`                              | attribute this session's work to the card                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `fy task skip "<why>"`                            | record that this work needs no card                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `fy task block` / `unblock`                       | mark or clear an external block                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `fy task depend` / `undepend`                     | add or remove a dependency; `--until`, `--override <why>` (owner)                                                                                                                                                                                                                                                                                                                                                                                              |
| `fy task drop --reason`                           | drop a card                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `fy task reopen <id> --to <lane> --ask "<words>"` | reopen a finished card with the owner's new ask                                                                                                                                                                                                                                                                                                                                                                                                                |
| `fy task clarify <id> --source`                   | append verbatim words to the original ask                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `fy task link`                                    | attach one `--pr`, `--branch`, `--commit` or `--doc`                                                                                                                                                                                                                                                                                                                                                                                                           |
| `fy task assign`, `note`, `order`, `file`, `edit` | assignee, a note, manual order, expected files, edit the text fields                                                                                                                                                                                                                                                                                                                                                                                           |
| `fy task refile <id> --project`                   | move a card to another project's board; `--lane`, `--reason`                                                                                                                                                                                                                                                                                                                                                                                                   |
| `fy board`                                        | the board; `--project <name\|all>`, `--ferret`, `--mine`, `--kind`, `--pr`, `--activity`, `--state`, `--closed`, `--query`, `--json`, `--md`                                                                                                                                                                                                                                                                                                                   |
| `fy board lanes propose\|show\|edit`              | read or change a project's lane set; `--project`, `--rename`, `--remove`, `--into`                                                                                                                                                                                                                                                                                                                                                                             |
| `fy board workflow show`                          | each lane in order as a GATE (its options and where each sends the card) or AUTO (what moves a card in); `--project`, `--json`                                                                                                                                                                                                                                                                                                                                 |
| `fy board workflow edit --lane <id>`              | make a lane a gate (`--gate "<Label>=<next\|close\|reopen\|lane:<id>>"`, up to 3) or automatic (`--auto <trigger,...>\|none`); version-checked through the lanes edit route, so a sub-ferret is refused as for `lanes edit`                                                                                                                                                                                                                                    |
| `fy board status`, `fy board on\|off`             | whether the project uses the board; switching it is the owner's ([The board is opt-in](#the-board-is-opt-in)); `--project`, `--json`                                                                                                                                                                                                                                                                                                                           |
| `fy board import`                                 | import the old task files ([board-import.md](board-import.md))                                                                                                                                                                                                                                                                                                                                                                                                 |
| `fy project add <path>` / `ls`                    | register a folder as a project; list projects                                                                                                                                                                                                                                                                                                                                                                                                                  |

Retired spellings print what replaced them and exit non-zero: `fy task list` is `fy board --mine` or `--all`,
`fy task phase` and `fy task status` are `fy task move`, and `fy task feedback` is now a note.

The routes behind them, all needing the `fleet` capability at operator minimum for a caller off this host
([grants.md](grants.md)):

| Route                                           | Does                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /v1/board`                                 | the board view                                                              |
| `GET /v1/board/ids`                             | every card id on the machine, ids only: what `&F12` is proved against       |
| `POST /v1/board/tasks`                          | create a card                                                               |
| `GET /v1/board/tasks?legacyRef=`                | find the card an imported task became                                       |
| `GET, POST /v1/board/tasks/:taskId`             | read a card, or apply one action to it                                      |
| `POST /v1/board/skip`                           | record `fy task skip`                                                       |
| `POST /v1/board/import`                         | run the import                                                              |
| `GET /v1/board/projects`                        | list projects                                                               |
| `GET, POST /v1/board/projects/:projectId/lanes` | read, propose or edit a lane set                                            |
| `GET, PUT /v1/board/projects/:projectId/switch` | read whether the project uses the board; set it (the owner only)            |
| `GET /v1/search`                                | find cards and agenda items by any words ([work-search.md](work-search.md)) |
| `POST /v1/search/related`                       | the related check before filing                                             |

A write that fails answers with one of these codes: `invalid`, `not-found`, `forbidden`, `reason-required`,
`owner-gate`, `blocked-by`, `cycle`, `unknown-lane`, `no-lane-set`, `version-conflict`.

The PWA shows the board as kanban, list, tree, dependencies and archive views, and opens a card from `&F412`
wherever it appears ([reference-standard.md](reference-standard.md)).

## Gaps and work in flight

- **Lane proposals: what is not covered yet.**
  - A daemon or app from before waiting proposals reads a lane file without `pending` and, on its next write,
    drops it; a later proposal can then be given a number an old, still-open card names. Its Accept takes the
    newer content.
  - A first proposal raised by `InferredLaneProposer` for a sub-ferret puts the card on that sub-ferret's agenda,
    where its lead may edit the daemon's item (not answer it).
  - An Accept on the agenda records the owner without saying it came on the admin token (`confirmedVia`), unlike
    the lanes route.
  - When the owner accepts, the lanes are stored first and the cards moved after; a move that fails leaves those
    cards in a removed lane, with nothing that retries it.
  - Anything running as the same user can delete a project's lane file under the state home, after which a
    ferret's proposal for it goes live as a first one (the admin-token GAP's class: the host's user is the owner).

- **The lane editor cannot set a gate's options or a stage yet**, nor `fy` report a trigger. A gate already raises
  its one Inbox item ([Gates ask the owner](#gates-ask-the-owner)).
- **`pr.review_approved` is reported, not watched.** The watcher asks GitHub for a PR's state, checks and merge,
  not its review decision, so for now an approval is reported (`{ "action": "trigger" }`).
- **A daemon or an app that predates the two new triggers cannot read a lane that uses one.** Its trigger list is
  closed, so a lane set naming `deploy.done` or `pr.review_approved` fails to parse there: an older daemon reads
  that lane file as damaged, and a cached older app cannot load the board. No template uses them; add one to a lane
  only once every machine and app runs this release.

- **Only `&F412` is a link in a card's text.** The card detail sits outside any session, and the reference
  surface is assembled per session (`components/reference-surface.tsx`), so `!A48` and `@file` in a card's Markdown
  stay prose until the Board builds a surface of its own — the same as an agenda card read in the Inbox. A task
  reference links on both, through `DaemonTaskReferences`: any card on the machine, per
  [reference-standard.md](reference-standard.md) §6.
- **Another machine's cards.** The `&F412@mac` spelling for a card on a different machine is not wired. A `parent`
  or `dependsOn` that names a card on another machine resolves to nothing, so it neither blocks nor rolls up.
- **Some messages bypass the pending-context carrier.** Quiet board events ride the next message, but agenda answer
  batches and Warden nudges are still delivered by their own paths, so they are not held for the next turn.
- **Old `&F12` references in the PWA resolve through the project or ferret board slice.** A chat reads one board query
  (`ferret = <session>`, `state = all`) and a reference that is the old id of a card whose `legacyRef` names this
  session links to that card, shown as the old text; a card on the slice with the same id wins. It does not call
  `GET /v1/board/tasks?legacyRef=` per reference. The limit is the slice: an imported card this ferret no longer
  owns or is assigned stays plain text ([reference-standard.md](reference-standard.md)).
- **Per-session task routes.** `/v1/sessions/:sid/tasks` and `/v1/tasks` survive as empty compatibility answers for
  one release and then go. Nothing in the PWA requests them any more; a unit test scans its source for the spelling.
