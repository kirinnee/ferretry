# UNIT A1 — attention

**Read `docs/migration/units/UNIT-CONTEXT.md` fully first.** Safety rules, refactor doctrine,
definition of done, PR requirement all live there. This brief adds only specifics.

**Worktree:** `<your-worktree>`, branch `port/a1-attention`.

**You own:** `packages/daemon/src/lib/attention/**`, `packages/daemon/src/adapters/attention/**`,
`packages/daemon/tests/{unit,integration}/attention/**`, plus your own export lines in
`packages/daemon/src/lib/index.ts`. **Nothing else** — concurrent units own storage, tasks,
task-boards, transcripts, names/worktrees.

## Source (read-only)

`/home/kirin/.config/home-manager/modules/kteam-ts/src`: the `attention-*` family (8 files,
~3,112 lines including tests) minus its types and CLI. `attention-types.ts` (333) is **already
ported** into `@ferretry/protocol` — import from there.

**Not yours:** `attention-cli.ts` (361 lines) → `packages/cli` in a later unit.

## What Attention is for

Human intervention should be **obvious, brief, and genuinely necessary**. An Attention item is a
request for a human decision that an agent cannot make alone. The daemon owns raising, listing,
answering, dismissing, and resolving them.

## Build toward the backlog, not just the port

Four `handover.md` items land on top of this, and the port should leave room for them rather than
forcing a rewrite. You are **not** implementing them — but shape the model so they are additive:

- **Item 10 — four action-based kinds**: permission, choice, answer review, open response. If the
  source models kind loosely, model it as a **discriminated union** now, with the payload each kind
  actually needs. This is the single most valuable shaping decision in this unit.
- **Item 11 — dismissal by both sides**: agents dismiss items they raised; the human may dismiss
  any. So "who may dismiss this" is a predicate over (actor, item), not a boolean field.
- **Item 8 — addressed items must not remain open**: answering or dismissing must remove it from the
  active view immediately. Make "is this still active" derived from state, never a separately
  maintained flag that can drift.
- **Item 14 — warden escalation**: ordinary session Attention must **not** feed the warden's
  suspicion scan or be copied into warden reports. Keep the provenance of an Attention item explicit
  (which actor raised it, and why) so the warden unit can filter on it rather than guess.

Put the lifecycle in `src/lib/attention/` as a pure state machine with a full unit-tier ledger, and
only persistence in adapters. Notification delivery is **not** this unit (item 12) — but do not
couple the lifecycle to it.

## Bugs to expect

Answered items that stay visible; dismissal permitted by the wrong actor; "active" tracked
separately from state and able to disagree; kinds distinguished by string sniffing rather than a
tagged union; resolution that loses the answer. Fix them and list every fix in the PR.
