# UNIT AN1 — analytics ingestion and query

**Read `docs/migration/units/UNIT-CONTEXT.md` fully first.** Safety rules, refactor doctrine,
definition of done, PR requirement all live there. This brief adds only specifics.

**Worktree:** `<your-worktree>`, branch `port/an1-analytics`.

**You own:** `packages/daemon/src/lib/analytics/**`, `packages/daemon/src/adapters/analytics/**`,
`packages/daemon/tests/{unit,integration}/analytics/**`, plus your own export lines in
`packages/daemon/src/lib/index.ts`. **Nothing else** — concurrent units own storage, tasks,
task-boards, attention, transcripts, names/worktrees.

## Source (read-only)

`${KTEAM_SRC}/src`: the `analytics-*` family (4 files, ~2,599
lines) — chiefly `analytics-index.ts` (2,061) — plus `model-cost.ts` (373). `analytics-types.ts`
(174) is **already ported** into `@ferretry/protocol` — import from there.

**Not yours:** `analytics-cli.ts` (149) → `packages/cli` in a later unit.

## What to build

Ingestion of finished-session data into a queryable store, plus the query surface over it.

Doctrine split, which matters here because analytics code tends to become one big SQL-and-logic
blob:

- **`src/lib/analytics/`** — what a session's usage _means_: metric derivation, aggregation rules,
  cost computation, and query construction as data. Pure, full unit-tier ledger.
- **`src/adapters/analytics/`** — the store itself and the ingest IO, behind an interface.

Per plan §5, **files stay authoritative and the analytics store is a disposable index**: dropping it
and re-ingesting from the durable session records must be a supported, tested operation. Assert it.

## Shape for the backlog

Three `handover.md` items build here. You are not implementing them, but do not block them:

- **Item 13 — ingestion before UI.** This unit is that foundation. Getting the data model right
  matters more than any query.
- **Item 66 — configurable model pricing.** Cost must be computed from an **injected rate table**,
  never hardcoded constants, and the **effective rate must be snapshotted with the usage record** so
  historical costs do not silently change when pricing is updated. Unpriced usage is reported as
  unknown, **never guessed or defaulted to zero**. Design for this now — retrofitting a snapshot
  after data exists is painful.
- **Item 28 — model identity normalization.** Transcript and session model identifiers can disagree
  because a selector encodes context-window choice differently from the underlying model (for
  example a `[1m]` suffix). Model identity as a normalized value with the variant kept as a separate
  field, rather than one ambiguous string. Note what you found in the source.

## Bugs to expect

Cost constants hardcoded in source; usage rows priced at query time instead of ingest time (so
history mutates when rates change); unpriced usage silently counted as zero; model identifiers
compared as raw strings; an index that cannot be rebuilt. Fix them and list every fix in the PR.

---

## Addendum — this unit was already audited; do NOT audit it again

A previous attempt at this unit produced a source audit and **zero lines of code**. That audit is
saved at `docs/migration/units/AN1-findings.md`. **Read it as input, then implement.** Do not
produce another analysis; your deliverable is code in an open PR (see the top of UNIT-CONTEXT.md).

Confirmed defects from that audit — fix these in code and list them in your PR:

1. `recomputeSessionTokens` overwrites the display/session `model` with the transcript
   `pricing_model` (`analytics-index.ts:2007-2025`). Pricing evidence and display selection must
   stay distinct identities.
2. Cost formulas are **duplicated** between the TypeScript path and SQL, and they can drift. Use one
   injected pure decision path plus an ingest-time snapshot.
3. The SQL path rejects non-fixed-width UTC timestamps while the TS resolver accepts anything
   `Date.parse` handles — inconsistent instant parsing.
4. Model normalization is only partial: `canonicalAnalyticsModelId` strips `[1m]` and stores context
   window separately (keep that), but aliases, case, and revisions still compare as raw strings in
   pricing and evidence, so aliases of one underlying model can be reported as "mixed".
5. The store/ingest decisions belong in `lib`; SQLite, filesystem, and scheduling stay in adapters.
