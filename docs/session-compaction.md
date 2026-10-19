# Session compaction readout

How a session's context compaction reaches a reader. The contract is `SessionCompactionSchema` in
`packages/protocol/src/lib/session-live.ts`; the daemon's rules are `packages/daemon/src/lib/session/live/compaction.ts`.

## What is real and what is an estimate

**Neither Claude Code nor Codex exposes real compaction progress.** Claude paints
`✻ Compacting conversation… (12s · esc to interrupt)` with only a clock; Codex paints
`• Compacting (3s • Esc to interrupt)` and writes nothing until its `compacted` record lands. There is
no token counter or percentage to read, so none is invented.

- **Running** is read from the pane, and only when the line has its glyph, its `Compacting` verb and an
  interrupt-or-clock parenthetical. Prose that merely says "Compacting" never starts one.
- **The percent is an estimate.** The `live` frame carries `startedAt` (when the daemon first saw it),
  `tokensBefore`, `expectedMs` and its `basis`; every reader derives the percent with
  `compactionPercent`: linear in elapsed time over `expectedMs`, **capped at 95** until the end is
  observed. A reader must say "about" next to it.
- **`expectedMs`** is the median of the compactions this daemon watched from start to end (kept in
  `compaction-history.json` in the state home; `basis: history`). With none yet it is a fixed prior:
  60 s for Claude, 40 s for Codex (`basis: typical`). Those priors are assumptions, not measurements.
- **Done** is read from the transcript's own boundary record (Claude `system/compact_boundary`, Codex
  `compacted`), so it survives a reload for as long as the record is in the tail the daemon reads.
  `tokensBefore` and `tokensAfter` are the harness's stated counts when it states them, else the context
  size of the usage records either side of the boundary; either may be absent, and a reader shows only
  what is present.

A compaction nobody is streaming (`?live=1`) is not measured, so it adds nothing to the history.

## Fixtures

The pane lines and boundary records under test are synthetic reconstructions of the documented
shapes, not captures from a live harness. If a harness version changes its wording, the tests will not
notice; capture a real frame and add it before trusting a new version.
