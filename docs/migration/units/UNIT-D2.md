# UNIT D2 — names pool, worktrees, git adapter

**Read `docs/migration/units/UNIT-CONTEXT.md` fully first.** It holds the safety rules, the
refactor doctrine, the definition of done, and the PR requirement. This brief adds only specifics.

**Worktree:** `<your-worktree>`, branch `port/d2-names-worktrees`.

**You own:** `packages/daemon/src/lib/{names,worktrees}/**`,
`packages/daemon/src/adapters/{git,worktrees}/**`,
`packages/daemon/tests/{unit,integration}/{names,worktrees,git}/**`, and your own export lines in
`packages/daemon/src/lib/index.ts`. **Nothing else under `packages/daemon/`** — one unit owns the
state-home/storage foundation, another owns transcript parsing. Do not create `paths`, `io`,
`storage`, or `fs` modules; define a narrow interface in your own `lib` if you need them and note
the dependency in your PR.

## Source (read-only)

`${KTEAM_SRC}/src`:

| File            |   LOC | Character                                  |
| --------------- | ----: | ------------------------------------------ |
| `names-pool.ts` | 1,023 | session callsign generation and allocation |
| `worktrees.ts`  |   774 | git worktree lifecycle                     |
| `git.ts`        |   692 | git command adapter (fs + proc + env)      |

Verify against the source; trust the source if the numbers differ. Read their `*.test.ts` siblings
for intent, but a test pinning broken behavior is deleted and re-expressed correctly.

## Split guidance

- **`names-pool`** is nearly pure: candidate generation, collision avoidance, and allocation policy
  belong in `src/lib/names/`; only persistence of "which names are taken" touches IO, and that goes
  behind an interface. Aim for a full unit-tier ledger on the policy.
- **`git.ts`** is the opposite — it is an adapter by nature. It goes in `src/adapters/git/` behind an
  interface declared in `lib`. **Never build git commands by string concatenation**; pass argument
  arrays so a branch name can never be interpreted as a flag or shell metacharacter. Check exit
  codes and surface stderr rather than swallowing it.
- **`worktrees.ts`** splits: the _decisions_ (is this checkout safe to remove, is the branch
  integrated, is it dirty, is it locked, who owns it) are pure policy for `src/lib/worktrees/`; the
  git invocations use the adapter above.

## This unit is load-bearing for the backlog

`handover.md` **item 68** ("make Git worktrees first-class") and **item 69** (Projects hub) build
directly on what you write, and item 68's definition of done is unusually demanding: removal must
distinguish dirty-worktree force from unmerged-branch force, refuse the current/shared/locked/active
checkout by default, protect ignored content and unpushed commits, never strand live terminals, and
delete a branch only when safely integrated or explicitly confirmed.

You are **not** implementing item 68. But model the safety predicates as **explicit, individually
testable pure functions** in `lib` rather than inline conditions, so that item can build on them
instead of rewriting them. Name them for what they decide.

## Safety, specific to this unit

You are writing code that deletes git worktrees and branches. Tests operate **only** on throwaway
repositories created in temp directories — never on this repo, never on the lead's checkout, never
on any other unit's worktree, never on anything under `~/Workspace`. A test that runs a destructive
git command outside a temp fixture is an immediate rejection.

## Bugs to expect

Shell-concatenated git commands, unchecked exit codes, `catch {}` around destructive operations,
force-removal paths that do not distinguish _why_ a checkout is unsafe, and name allocation that can
race two sessions onto one callsign. Fix them and list every fix.
