/**
 * Every real Claude compaction status line shape the repo knows (&B188), ONE table for every reader.
 *
 * The pane readers — `paneShowsCompacting` (feeds `routeSend`'s busy override and `paneActiveWork`) and
 * `paneCompaction` (feeds the live compaction frame) — must agree on all of it: a shape one sees and the other
 * misses lets a send type into a compacting composer. Each row names where the repo first met the shape.
 */

/** A compaction status line as Claude paints it, with the test or fixture that proved it exists. */
export interface CompactionShape {
  readonly line: string;
  readonly source: string;
}

/** The spinner ticks the readers support: `·` and ASCII `*` are the idle-frame ticks, the rest the animated glyphs. */
export const COMPACTION_GLYPHS = ['·', '*', '✻', '✳', '✶', '✽', '✢', '∗', '✦', '✧'] as const;

/** The status text after the glyph — no suffix, then each parenthetical Claude is known to draw. */
export const COMPACTION_TEXTS: readonly CompactionShape[] = [
  { line: 'Compacting conversation…', source: 'fixtures/compaction/claude-2.1.30x-compacting-start-middot.txt' },
  { line: 'Compacting conversation...', source: 'tests/unit/tmux/pane.test.ts (ASCII ellipsis)' },
  { line: 'Compacting conversation… (3s)', source: 'tests/unit/tmux/pane.test.ts' },
  { line: 'Compacting conversation... (3s)', source: 'tests/unit/tmux/pane.test.ts' },
  { line: 'Compacting conversation… (1m 12s)', source: 'tests/unit/session/live/compaction.test.ts' },
  {
    line: 'Compacting conversation… (esc to interrupt)',
    source: 'tests/unit/session/live/compaction.test.ts (Unicode)',
  },
  { line: 'Compacting conversation... (esc to interrupt)', source: 'tests/unit/session/live/compaction.test.ts' },
  {
    line: 'Compacting conversation… (4s · esc to interrupt)',
    source: 'tests/integration/session/live/storage-live-activity.test.ts',
  },
  {
    line: 'Compacting conversation… (12s · esc to interrupt · ctrl+t to show todos)',
    source: 'fixtures/compaction/claude-2.1.28x-compacting-no-bar.txt',
  },
  {
    line: 'Compacting conversation… (7m 14s · ↓ 37.4k tokens)',
    source: 'fixtures/compaction/claude-2.1.28x-compacting-progress.txt',
  },
  { line: 'Compacting conversation… (1m 2s · ↓ 812 tokens)', source: 'tests/unit/session/live/compaction.test.ts' },
  { line: 'Compacting conversation… (1m 2s · ↑ 9.9k tokens)', source: 'tests/unit/session/live/compaction.test.ts' },
  { line: 'Compacting conversation… (37.4k tokens)', source: 'pane.ts grammar: a clipped clock, token half only' },
  { line: 'Compacting conversation… (12s · esc to inte', source: 'pane.ts grammar: clipped on a narrow pane' },
];

/** Every supported shape: each text on each spinner tick. */
export const COMPACTION_SHAPES: readonly CompactionShape[] = COMPACTION_GLYPHS.flatMap(glyph =>
  COMPACTION_TEXTS.map(text => ({ line: `${glyph} ${text.line}`, source: text.source })),
);

/** Lines that merely mention compaction and must never read as one, however close to the composer they sit. */
export const NOT_COMPACTION_LINES: readonly string[] = [
  '  * Compacting the notes… is next',
  '· Compacting the notes…',
  '• Compacting the cache before the build…',
  '* Compacting conversation… is what the log said',
  '· Compacting conversation… (see the notes)',
  '· Compacting conversation… and then more',
  '· Compacting conversation… (esc is the key to press)',
  '· Compacting conversation… (interrupt it with esc to interrupt)',
  'Compacting conversation… (12s · esc to interrupt)',
  '· Compacting',
  'Compacting is what the harness calls it',
  '✻ Pontificating… (12s · esc to interrupt)',
];

/** The frame Claude draws around the status line: the work above it, the composer under it. */
export function compactionFrame(line: string): string {
  const rule = '─'.repeat(80);
  return ['⏺ Done reading the cache layer.', '', line, '', rule, '❯ ', rule, '  ⏵⏵ bypass permissions on'].join('\n');
}
