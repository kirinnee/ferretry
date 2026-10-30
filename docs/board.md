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
Board: all work is a card (&F412) on its project's board (new repo: `fy project add .`); agenda items are !A48. Before your first edit for a new ask, have one: `fy task create -k <kind> -t "<≤5 words>" --summary "<line>" --ask "<owner's words verbatim>"` (fy new/start make one). Move it: `fy task move <id> <lane> --reason "<why>"`. Blocked on owner: `fy agenda add --task <id>`; a card: `fy task depend`; outside: `fy task block`. Dropped: `fy task drop --reason`; switched: `fy task focus <id>`. Owner finds a problem: `fy task reopen <id> --to <lane> --ask "<their words>"`. Never move what a PR or release moves; only the owner closes.
```

Tasks are `&F412` and agenda items are `!A48`; nothing prints the retired `#F412`
([reference-standard.md](reference-standard.md)).

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

`fy board lanes show|propose|edit --project <name|id>` and `fy board --project <name|id|all>` name a board by its
name or id, wherever the flag is written on the line.

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

| Field        | Meaning                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enterOn`    | triggers that move a card here: `work.started`, `pr.opened`, `pr.ready`, `ci.green`, `pr.merged`, `release.published`, `release.running`, `signal.done` |
| `ownerGate`  | only the owner moves a card into this lane (`owner-gate` for a ferret)                                                                                  |
| `staleAfter` | how long a card may sit untouched here before it counts as stale                                                                                        |

**Templates.** A ferret proposes a lane set from a template, then renames lanes if the project calls for it
(`packages/protocol/src/lib/board-lanes.ts`):

| Template            | Lanes                                                                      |
| ------------------- | -------------------------------------------------------------------------- |
| `pr-release-verify` | Todo, Plan/Design, Implement, Review/CI, Merged, Released, To test, Closed |
| `pr-release`        | as above without To test; Released closes                                  |
| `pr`                | Todo, Plan/Design, Implement, Review/CI; Merged closes                     |
| `ops`               | Todo, Investigate, Fix, Verify, Closed                                     |
| `writing`           | Todo, Research, Draft, Review, Published, Closed                           |
| `quick`             | Todo, Doing, Closed; closes when the ferret signals done                   |

A card's **workflow** (`quick`, `design-first`, `research-first`, `investigate`) selects its variant of the lane
set and cannot change after creation. In the PR templates `quick` work skips Plan/Design.

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

A card is referenced as `&F412`, an agenda item as `!A48`. The retired `#F12` is still accepted as input, and
never printed ([reference-standard.md](reference-standard.md)).

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
owner of where PR facts put a card: all PRs merged and released is the `release.published` lane (`release.running`
once this machine runs that release), any merged with none open is `pr.merged`, any open is `pr.opened` /
`pr.ready`, and otherwise no opinion. It never moves a card backward, never out of Closed or a drop, and never into
a Closed lane in a set with a To test lane. A fact passes an owner gate (out of Plan/Design); gates still stop ferrets.
The GitHub watcher reconciles every linked card on every poll, refile and `fy task link --pr` re-evaluate at once, and a
PR nobody has asked GitHub about is polled on the next tick. A card the owner sent back stays back until a PR newer
than that move merges. History names the fact; a daemon move from a fact is never a quiet line
([ferret-messages.md](ferret-messages.md#board-events-that-ride-the-next-message)).

The watcher itself polls GitHub through the host's `gh` about once a minute while a repository has an open linked
PR, and every ten minutes otherwise, and after `gh` is missing or signed out. A card that sits on Unfiled with a PR
linked is refiled to its repository's project after a day.

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
[board] You changed code this turn without a card. Create one (fy task create …) or record why not: fy task skip "<why>"
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

| Verb                                              | Does                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fy task create`                                  | make a card: `-k/--kind`, `-t/--title`, `--summary`, `--ask`, `--ask-source`, `--premise`, `--context`, `--term`, `--brief`, `--brief-file`, `--workflow`, `--depends-on`, `--parent`, `--assignee`, `--project`, `--lane`, `--file`, `--pr`, `--branch`, `--doc` |
| `fy task show <id>`                               | print one card                                                                                                                                                                                                                                                    |
| `fy task move <id> <lane>`                        | move it; `--reason` is required for a move back                                                                                                                                                                                                                   |
| `fy task focus <id>`                              | attribute this session's work to the card                                                                                                                                                                                                                         |
| `fy task skip "<why>"`                            | record that this work needs no card                                                                                                                                                                                                                               |
| `fy task block` / `unblock`                       | mark or clear an external block                                                                                                                                                                                                                                   |
| `fy task depend` / `undepend`                     | add or remove a dependency; `--until`, `--override <why>` (owner)                                                                                                                                                                                                 |
| `fy task drop --reason`                           | drop a card                                                                                                                                                                                                                                                       |
| `fy task reopen <id> --to <lane> --ask "<words>"` | reopen a finished card with the owner's new ask                                                                                                                                                                                                                   |
| `fy task clarify <id> --source`                   | append verbatim words to the original ask                                                                                                                                                                                                                         |
| `fy task link`                                    | attach one `--pr`, `--branch`, `--commit` or `--doc`                                                                                                                                                                                                              |
| `fy task assign`, `note`, `order`, `file`, `edit` | assignee, a note, manual order, expected files, edit the text fields                                                                                                                                                                                              |
| `fy task refile <id> --project`                   | move a card to another project's board; `--lane`, `--reason`                                                                                                                                                                                                      |
| `fy board`                                        | the board; `--project <name\|all>`, `--ferret`, `--mine`, `--kind`, `--pr`, `--activity`, `--state`, `--closed`, `--query`, `--json`, `--md`                                                                                                                      |
| `fy board lanes propose\|show\|edit`              | read or change a project's lane set; `--project`, `--rename`, `--remove`, `--into`                                                                                                                                                                                |
| `fy board import`                                 | import the old task files ([board-import.md](board-import.md))                                                                                                                                                                                                    |
| `fy project add <path>` / `ls`                    | register a folder as a project; list projects                                                                                                                                                                                                                     |

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
