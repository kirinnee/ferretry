# The project board

The contract for the board: where every piece of a ferret's work is tracked. One board per project, one card per
piece of work, lanes the owner can rename, and a daemon that moves a card when a pull request or a release does.
This page owns the subject; the pages it links own their own facts.

| Subject                         | Owner                                          |
| ------------------------------- | ---------------------------------------------- |
| Importing the old task files    | [board-import.md](board-import.md)             |
| `&F412` and `!A48` references   | [reference-standard.md](reference-standard.md) |
| The agenda and its items        | [agenda.md](agenda.md)                         |
| Who may call the board's routes | [grants.md](grants.md)                         |

Most of the board is automatic: a start makes the card, a PR and a release move it. The sections below are the
whole contract; the last ones are the part a ferret must do itself, and the backstop that catches it when it does not.

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
Board: all work is a card (&F412); agenda items are !A48. New ask, first: `fy task create -k <kind> -t "<≤5 words>" --summary "<line>" --ask "<exact words>" --premise <point> --context <point>` (fy new/start make one). Before To test: `fy task edit <id> --how-to-test "<1. where 2. do 3. see; machine+version>"`. Lane by the work (`fy board lanes show`): plan → plan lane (owner OKs leaving), build → active: `fy task move <id> <lane> --reason "<why>"`. Blocked is no lane: `fy agenda add --task <id>` (owner), `fy task depend` (card), `fy task block` (else). `fy task drop --reason`, `fy task focus <id>`. Owner's bug: `fy task reopen <id> --to <lane> --ask "<their words>"`. Starts, PRs, merges, releases, `fy signal done` self-move; owner closes.
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
Link your PR to your card: `fy task link <id> --pr <url>` (or `--branch`); add progress with `fy task note`. Your card moves itself: start, PR, merge, `fy signal done`. Your final report says how the owner tests it.
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
   suggests. The proposal is live at once; the owner gets one agenda choice to accept or edit it. A linked
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
there, so a card merged but not released lands in Merged, never in Released · to test because it sat in the Unfiled
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
| `enterOn`    | triggers that move a card here: `work.started`, `pr.opened`, `pr.ready`, `ci.green`, `pr.merged`, `release.published`, `release.running`, `signal.done`                                                                                                                                                                                                     |
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
owner closes. A card with a PR is left where it is; its PR moves it.

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

A proposal is live at once but unconfirmed. The owner gets one agenda choice, Accept or Edit
([agenda.md](agenda.md)); accepting confirms the set. Edits are version-checked (a stale edit is a
`version-conflict`), and a lane cannot be removed without naming where its cards go. A project with no lane set
gets an inferred proposal: a repository with `v*` tags gets `pr-release-verify`, one
without gets `pr`, a folder with no repository gets `quick`.

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
   tested, **Done** and **Not good** sit right under it;
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

## Authority

Who may write a card follows from the card itself and from the lineage of the session asking; there are no roles to
grant. This replaced the old `task-boards` access list. The code is `packages/daemon/src/lib/board/authority.ts`.

| Standing      | Who                                                        | May                                                        |
| ------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| `owner-human` | the owner: loopback, or a device the `fleet` grant let in  | everything, including owner gates and dependency overrides |
| `owner`       | the card's owner ferret                                    | the assignee's writes, plus re-plan                        |
| `ancestor`    | a ferret above the owner in the `parent` chain of sessions | the same as the owner                                      |
| `assignee`    | the ferret doing it                                        | move, note, link, block, edit files, clarify, reopen       |
| `daemon`      | the daemon's own automation                                | trigger moves, link cache, refile                          |
| `reader`      | any other ferret                                           | read; depend, but only from its own card                   |

Re-plan means retitle, rewrite the brief, reassign, drop and reorder. A ferret never moves a card into a lane with
an owner gate, and only the owner closes. Reaching the routes at all is a `fleet` capability matter for a caller
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
shipped 3 days. Verify and closed never go stale.

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
`verify` lane. A fact passes an owner gate (out of Plan/Design, and back out of Released · to test); gates still
stop ferrets.
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

When a turn ends, the daemon reads it (`packages/daemon/src/lib/board/turn-check.ts`). If the turn did
**mutating work** while the session had **no focus card in an open lane**, the ferret gets one queued message:

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

| Verb                                              | Does                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fy task create`                                  | make a card: `-k/--kind`, `-t/--title`, `--summary`, `--ask`, `--ask-source`, `--premise`, `--context` (each repeatable, one bullet each), `--term`, `--brief`, `--brief-file`, `--how-to-test`, `--how-to-test-file`, `--workflow`, `--depends-on`, `--parent`, `--assignee`, `--project`, `--lane`, `--file`, `--pr`, `--branch`, `--doc` |
| `fy task show <id>`                               | print one card                                                                                                                                                                                                                                                                                                                              |
| `fy task move <id> <lane>`                        | move it; `--reason` is required for a move back                                                                                                                                                                                                                                                                                             |
| `fy task focus <id>`                              | attribute this session's work to the card                                                                                                                                                                                                                                                                                                   |
| `fy task skip "<why>"`                            | record that this work needs no card                                                                                                                                                                                                                                                                                                         |
| `fy task block` / `unblock`                       | mark or clear an external block                                                                                                                                                                                                                                                                                                             |
| `fy task depend` / `undepend`                     | add or remove a dependency; `--until`, `--override <why>` (owner)                                                                                                                                                                                                                                                                           |
| `fy task drop --reason`                           | drop a card                                                                                                                                                                                                                                                                                                                                 |
| `fy task reopen <id> --to <lane> --ask "<words>"` | reopen a finished card with the owner's new ask                                                                                                                                                                                                                                                                                             |
| `fy task clarify <id> --source`                   | append verbatim words to the original ask                                                                                                                                                                                                                                                                                                   |
| `fy task link`                                    | attach one `--pr`, `--branch`, `--commit` or `--doc`                                                                                                                                                                                                                                                                                        |
| `fy task assign`, `note`, `order`, `file`, `edit` | assignee, a note, manual order, expected files, edit the text fields                                                                                                                                                                                                                                                                        |
| `fy task refile <id> --project`                   | move a card to another project's board; `--lane`, `--reason`                                                                                                                                                                                                                                                                                |
| `fy board`                                        | the board; `--project <name\|all>`, `--ferret`, `--mine`, `--kind`, `--pr`, `--activity`, `--state`, `--closed`, `--query`, `--json`, `--md`                                                                                                                                                                                                |
| `fy board lanes propose\|show\|edit`              | read or change a project's lane set; `--project`, `--rename`, `--remove`, `--into`                                                                                                                                                                                                                                                          |
| `fy board import`                                 | import the old task files ([board-import.md](board-import.md))                                                                                                                                                                                                                                                                              |
| `fy project add <path>` / `ls`                    | register a folder as a project; list projects                                                                                                                                                                                                                                                                                               |

Retired spellings print what replaced them and exit non-zero: `fy task list` is `fy board --mine` or `--all`,
`fy task phase` and `fy task status` are `fy task move`, and `fy task feedback` is now a note.

The routes behind them, all needing the `fleet` capability at operator minimum for a caller off this host
([grants.md](grants.md)):

| Route                                           | Does                                   |
| ----------------------------------------------- | -------------------------------------- |
| `GET /v1/board`                                 | the board view                         |
| `POST /v1/board/tasks`                          | create a card                          |
| `GET /v1/board/tasks?legacyRef=`                | find the card an imported task became  |
| `GET, POST /v1/board/tasks/:taskId`             | read a card, or apply one action to it |
| `POST /v1/board/skip`                           | record `fy task skip`                  |
| `POST /v1/board/import`                         | run the import                         |
| `GET /v1/board/projects`                        | list projects                          |
| `GET, POST /v1/board/projects/:projectId/lanes` | read, propose or edit a lane set       |

A write that fails answers with one of these codes: `invalid`, `not-found`, `forbidden`, `reason-required`,
`owner-gate`, `blocked-by`, `cycle`, `unknown-lane`, `no-lane-set`, `version-conflict`.

The PWA shows the board as kanban, list, tree, dependencies and archive views, and opens a card from `&F412`
wherever it appears ([reference-standard.md](reference-standard.md)).

## Gaps and work in flight

- **References in a card's text are not links yet.** The card detail sits outside any session, and the reference
  surface is assembled per session (`components/reference-surface.tsx`), so `&F412`, `!A48` and `@file` in a
  card's Markdown stay prose until the Board builds a surface of its own — the same as an agenda card read in the
  Inbox.
- **Another machine's cards.** The `&F412@mac` spelling for a card on a different machine is not wired. A `parent`
  or `dependsOn` that names a card on another machine resolves to nothing, so it neither blocks nor rolls up.
- **Some messages bypass the pending-context carrier.** Quiet board events ride the next message, but agenda answer
  batches and Warden nudges are still delivered by their own paths, so they are not held for the next turn.
- **Old `&F12` references in the PWA resolve through the ferret's board slice.** A chat reads one board query
  (`ferret = <session>`, `state = all`) and a reference that is the old id of a card whose `legacyRef` names this
  session links to that card, shown as the old text; a card on the slice with the same id wins. It does not call
  `GET /v1/board/tasks?legacyRef=` per reference. The limit is the slice: an imported card this ferret no longer
  owns or is assigned stays plain text ([reference-standard.md](reference-standard.md)).
- **Per-session task routes.** `/v1/sessions/:sid/tasks` and `/v1/tasks` survive as empty compatibility answers for
  one release and then go. Nothing in the PWA requests them any more; a unit test scans its source for the spelling.
