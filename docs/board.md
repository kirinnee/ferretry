# Board enforcement

How Ferretry keeps every piece of a ferret's work on a card of its project's board. Most of it is automatic: a
start makes the card, a PR and a release move it. This page is the part a ferret must do itself, and the backstop
that catches it when it does not.

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
