# Session compaction readout

How a session's context compaction reaches a reader. The contract is `SessionCompactionSchema` in
`packages/protocol/src/lib/session-live.ts`; the daemon's rules are `packages/daemon/src/lib/session/live/compaction.ts`.

## What is real and what is absent

**Current Claude Code reports its own compaction progress; Codex and older Claude Code do not.** While
compacting, Claude Code paints, in its pane:

```
✢ Compacting conversation… (7m 14s · ↓ 37.4k tokens)
  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 49%
  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work
```

Codex paints `• Compacting (3s • Esc to interrupt)` and nothing more, and writes no record until its
`compacted` record lands.

- **Running** is read from the pane, and only when the line has its glyph (`✢`, `✻`, `•`, …), its
  `Compacting` verb and a clock-or-interrupt parenthetical. Prose that merely says "Compacting" never
  starts one.
- **`percent` is the harness's own number.** It is read from the bar line **directly under** the
  Compacting line — filled/empty block glyphs, then a whole `0–100` percentage that ends the line —
  and nowhere else. **`tokensWritten`** is the `↓ N tokens` counter in the Compacting line's
  parenthetical (an `↑` counter is not one). Both are optional on the `live` frame and absent when the
  pane paints neither. They are re-read every sample, never remembered: a pane that could not be read
  carries no percent rather than a stale one.
- **Nothing is estimated.** With no `percent` a reader shows a spinner, the real clock and "Usually ~Ns
  here" — never a percentage derived from elapsed time. (The protocol no longer has an estimator.)
- **`expectedMs`** is how long a compaction usually takes here: the median of the compactions this daemon
  watched from start to end (kept in `compaction-history.json` in the state home; `basis: history`). With
  none yet it is a fixed prior: 60 s for Claude, 40 s for Codex (`basis: typical`). Those priors are
  assumptions, not measurements. A reader shows it only when there is no real `percent`.
- **Done** is read from the transcript's own boundary record (Claude `system/compact_boundary`, Codex
  `compacted`), so it survives a reload for as long as the record is in the tail the daemon reads.
  `tokensBefore` and `tokensAfter` are the harness's stated counts when it states them, else the context
  size of the usage records either side of the boundary; either may be absent, and a reader shows only
  what is present.

A compaction nobody is streaming (`?live=1`) is not measured, so it adds nothing to the history.

## Fixtures

`packages/daemon/tests/fixtures/compaction/claude-2.1.28x-compacting-progress.txt` is built from the exact
text (glyphs included) of a live Claude Code 2.1.28x pane while it compacted; the surrounding lines of that
frame are filler. The bar-less Claude frame and the Codex frame are reconstructions of the documented
shapes. If a harness version changes its wording, the tests will not notice; capture a real frame and add
it before trusting a new version.
