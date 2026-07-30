# UNIT T1 — tasks core and task stores

**Read `docs/migration/units/UNIT-CONTEXT.md` fully first.** Safety rules, refactor doctrine,
definition of done, PR requirement all live there. This brief adds only specifics.

**Worktree:** `<your-worktree>`, branch `port/t1-tasks`.

**You own:** `packages/daemon/src/lib/tasks/**`, `packages/daemon/src/adapters/tasks/**`,
`packages/daemon/tests/{unit,integration}/tasks/**`, plus your own export lines in
`packages/daemon/src/lib/index.ts`. **Nothing else.** Other units concurrently own the storage
foundation, transcripts, names/worktrees, and the shared board — do not create `paths`, `io`,
`storage`, `fs`, or anything under `task-boards/`.

## Source (read-only)

`/home/kirin/.config/home-manager/modules/kteam-ts/src`: `tasks.ts` (1,706),
`tasks-store.ts`, `session-tasks-store.ts`, `task-title.ts`, and their `*.test.ts` siblings.
Verify line counts against source; trust the source. `tasks-types.ts` is **already ported** into
`@ferretry/protocol` by another unit — import the schemas from there rather than redefining them,
and if the protocol package has not merged yet, code against the shape and note the dependency.

**Not yours:** `tasks-cli.ts` (625 lines of parse/render). Per plan §4 that belongs to
`packages/cli/src/lib/`, in a later CLI unit. Do not port it.

## What to build

The task record system: create, read, mutate status/phase, dependencies, file claims, notes,
clarifications, assignment, ordering, and links (PR/branch/commit/doc).

Split per the doctrine:

- **`src/lib/tasks/`** — the state machine and every rule around it: which phase transitions are
  legal, which require a reason, what "quick" versus "design-first" workflows permit, dependency
  cycle detection, and the ordering rules. This is pure and must carry a full unit-tier ledger. The
  transition rules are the heart of this unit — model them as data plus pure functions, not as
  scattered `if` statements.
- **`src/adapters/tasks/`** — persistence behind an interface declared in `lib`. Files are
  authoritative; any index is disposable and rebuildable.

## Behaviour worth preserving deliberately

kteam's task system enforces some rules that are genuinely good design, and they should survive
because they are correct, not because they are inherited:

- Every status/phase move **requires a reason**; creating `blocked` or `dropped` does too.
- Reopening requires the new human ask **and** its source, so the move and its context land
  atomically.
- File claims are **advisory, never locks**.
- An agent may only write tasks in its own session — cross-session writes are refused. (The
  cross-session _read_ aggregate belongs to the shared-board unit, not you.)
- Forward skips are refused: a record cannot jump phases, and `live → done` needs human
  verification.

Model each of these as an explicit, individually testable predicate.

## Bugs to expect

Status transitions validated in more than one place and able to disagree; reason strings accepted
but discarded; dependency edges that permit cycles; ordering that is not stable; note/clarification
appends that are not atomic and can truncate under interrupt. Fix them and list every fix in the PR.
