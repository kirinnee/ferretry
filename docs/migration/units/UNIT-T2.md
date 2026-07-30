# UNIT T2 — the tree-scoped shared board

**Read `docs/migration/units/UNIT-CONTEXT.md` fully first.** Safety rules, refactor doctrine,
definition of done, PR requirement all live there. This brief adds only specifics.

**Worktree:** `<your-worktree>`, branch `port/t2-task-boards`.

**You own:** `packages/daemon/src/lib/task-boards/**`, `packages/daemon/src/adapters/task-boards/**`,
`packages/daemon/tests/{unit,integration}/task-boards/**`, plus your own export lines in
`packages/daemon/src/lib/index.ts`. **Nothing else.** A concurrent unit owns `tasks/**` — do not
create files there, and do not create `paths`, `io`, `storage`, or `fs`.

## Source (read-only)

`${KTEAM_SRC}/src`: `task-boards.ts` (2,863) and its
`*.test.ts` sibling. `task-boards-types.ts` (339) is **already ported** into `@ferretry/protocol`
by another unit — import from there rather than redefining.

**Not yours:** `task-boards-cli.ts` (379 lines of parse/render) → `packages/cli` in a later unit.

## Why this unit matters more than its size suggests

This is the capability that `handover.md` items **47**, **48**, and **67** all build on, and it was
nearly mis-scheduled as a greenfield design because a survey missed the file. It exists and it is
substantial. From the source, `TaskBoardService` provides:

- `CentralTaskScope` vs `LegacyTaskScope` scope resolution
- external invitation lifecycle: `RequestExternalInvitationInput` → `ApproveExternalInvitationInput`
  → `AcceptExternalInvitationInput`
- `RequestChildGrantInput` / `ApproveChildGrantInput` — child grants
- `RelinquishMembershipInput` — leaving a board
- `ReplaceCoordinatorInput` — coordinator replacement
- board admin mutations, and `exactWorkerAssignee` resolution

**Drop `LegacyTaskScope` entirely** — plan §1.3, central scope only. Ferretry starts empty, so there
is no legacy scope to be compatible with.

## The security model is the deliverable

This is an **authorization** subsystem, and it is the one place in this migration where a refactor
bug becomes a privilege-escalation bug. The invariants, from the handover and the source:

- A board is **tree-scoped by default**. Descendants **never inherit access automatically.**
- A board may **explicitly invite** another top-level agent as a new membership root — invitation is
  a deliberate, authorized act with request → approve → accept stages, not a side effect.
- **Nothing may widen board membership without explicit invitation authority.** In particular a
  warden may not (item 47 states this directly).
- Capability proof is per-session and non-transferable; `paths.ts:97` in the source describes a
  pre-membership proof used only for an explicitly invited external root.

Put **every one of these as a named, individually testable pure predicate** in `src/lib/`, with
tests that assert the _negative_ cases — an uninvited descendant is refused, an unaccepted
invitation grants nothing, a relinquished membership stops acting, a replaced coordinator loses
authority. Access-control code whose tests only cover the happy path is not tested.

Keep the ACL decisions in `lib` (pure, fully covered) and only persistence/transport in adapters.
The HTTP transport itself belongs to a later api-server unit — expose a clean library surface and
state the boundary in your PR.

## Bugs to expect

Authorization checked in more than one place and able to disagree; a capability accepted without
verifying the session it was minted for; invitation state machines with reachable states that grant
access without acceptance; membership widening as a side effect of another mutation. Treat anything
in this area as security-relevant, fix it, and describe each fix precisely in the PR.
