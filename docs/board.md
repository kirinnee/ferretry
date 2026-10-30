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
Board: all work is a card (&F412) on its project's board; agenda items are !A48. Before your first edit for a new ask, have one: `fy task create -k <kind> -t "<≤5 words>" --summary "<line>" --ask "<owner's words verbatim>"` (fy new and fy start make one). Move it as work changes: `fy task move <id> <lane> --reason "<why>"`. Blocked on the owner: `fy agenda add --task <id>`; a card: `fy task depend`; outside: `fy task block`. Abandoned: `fy task drop --reason`; switched: `fy task focus <id>`. Owner reports a problem: `fy task reopen <id> --to <lane> --ask "<their words>"`. Never move what a PR or release moves; only the owner closes.
```

Tasks are `&F412` and agenda items are `!A48`; nothing prints the retired `#F412`
([reference-standard.md](reference-standard.md)).

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
