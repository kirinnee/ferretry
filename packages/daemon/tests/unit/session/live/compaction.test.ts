import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import should from 'should';
import {
  type CompactionEvidence,
  CompactionRecordSchema,
  expectedCompaction,
  MAX_COMPACTION_MS,
  paneCompaction,
  paneShowsCompaction,
  resolveCompaction,
  TYPICAL_COMPACTION_MS,
} from '../../../../src/lib/session/live/compaction.ts';
import type { TranscriptEvent } from '../../../../src/lib/transcript/types.ts';

/**
 * Compaction detection.
 *
 * WHAT THESE HAVE TO GET RIGHT. A compaction bar is only worth showing if it never lies about the
 * situation: a prose line that says "Compacting" must not start one, a finished one must be kept
 * exactly once for the history, a pane that merely failed to read must not end one, and a second
 * compaction must still be seen after the first.
 *
 * The Claude Code progress frame is built from the exact text the owner saw on a live pane while it was
 * compacting (`tests/fixtures/compaction/claude-2.1.28x-compacting-progress.txt`: the Compacting line,
 * the `▰▱` bar with its percentage, the tip line). The Codex frame, the bar-less Claude frame and the
 * boundary records are synthetic reconstructions of the documented shapes.
 */

const BASE = Date.parse('2026-10-18T10:00:00.000Z');
const at = (seconds: number): string => new Date(BASE + seconds * 1_000).toISOString();
const ms = (seconds: number): number => BASE + seconds * 1_000;

const usage = (seconds: number, contextTokens: number | undefined): TranscriptEvent => ({
  harness: 'claude',
  role: 'assistant',
  kind: 'usage',
  timestamp: at(seconds),
  usage: contextTokens === undefined ? { outputTokens: 1 } : { contextTokens },
});

const boundary = (
  seconds: number | undefined,
  extra: { trigger?: 'manual' | 'auto'; tokensBefore?: number; tokensAfter?: number } = {},
): TranscriptEvent => ({
  harness: 'claude',
  role: 'system',
  kind: 'compaction',
  ...(seconds === undefined ? {} : { timestamp: at(seconds) }),
  ...extra,
});

const chatter: TranscriptEvent = { harness: 'claude', role: 'assistant', kind: 'message', text: 'hello' };

const estimate = { expectedMs: 60_000, basis: 'history' } as const;

const evidence = (over: Partial<CompactionEvidence>): CompactionEvidence => ({
  nowMs: ms(10),
  paneCompacting: false,
  events: [],
  tracker: undefined,
  estimate,
  ...over,
});

const FIXTURES = join(import.meta.dir, '../../../fixtures/compaction');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const CLAUDE_LINE = '✻ Compacting conversation… (12s · esc to interrupt · ctrl+t to show todos)';
const CODEX_LINE = '• Compacting (3s • Esc to interrupt)';

describe('paneShowsCompaction', () => {
  it('should see Claude Code and Codex compacting at the foot of a frame', () => {
    // Arrange
    const frame = (line: string): string => `⏺ Done reading.\n\n${line}\n\n│ > `;

    // Assert
    should(paneShowsCompaction(frame(CLAUDE_LINE))).be.true();
    should(paneShowsCompaction(frame(CODEX_LINE))).be.true();
    should(paneShowsCompaction(frame('✢ Compacting conversation... (esc to interrupt)'))).be.true();
    should(paneShowsCompaction(frame('✻ Compacting conversation… (1m 12s)'))).be.true();
    should(paneShowsCompaction(frame(CODEX_LINE).replaceAll('\n', '\r\n'))).be.true();
  });

  it('should not take prose, a bare word or an old frame for a running compaction', () => {
    // Arrange
    const old = `${CLAUDE_LINE}\n${'filler\n'.repeat(30)}`;

    // Assert
    should(paneShowsCompaction('• Compacting the cache before the build…')).be.false();
    should(paneShowsCompaction('Compacting conversation… (12s · esc to interrupt)')).be.false();
    should(paneShowsCompaction('✻ Pontificating… (12s · esc to interrupt)')).be.false();
    should(paneShowsCompaction('')).be.false();
    should(paneShowsCompaction(old)).be.false();
  });
});

describe('paneCompaction', () => {
  it('should read the percentage and the tokens written off a live Claude Code frame', () => {
    should(paneCompaction(fixture('claude-2.1.28x-compacting-progress.txt'))).deepEqual({
      percent: 49,
      tokensWritten: 37_400,
    });
  });

  it('should report a running compaction with no progress when the harness paints none', () => {
    should(paneCompaction(fixture('claude-2.1.28x-compacting-no-bar.txt'))).deepEqual({});
    should(paneCompaction(fixture('codex-compacting.txt'))).deepEqual({});
    should(paneCompaction('')).be.undefined();
  });

  it('should take the percentage only from the line directly under the Compacting line', () => {
    // Arrange
    const bar = '  ▰▰▰▰▱▱▱▱ 49%';
    const spaced = `${CLAUDE_LINE}\n\n${bar}`;
    const stray = `⏺ Done.\n${bar}\n${CLAUDE_LINE}`;

    // Assert
    should(paneCompaction(spaced)).deepEqual({});
    should(paneCompaction(stray)).deepEqual({});
    should(paneCompaction(`${CLAUDE_LINE}\n${bar}`)).deepEqual({ percent: 49 });
  });

  it('should demand the bar glyphs and a percentage that ends the line', () => {
    const under = (line: string): ReturnType<typeof paneCompaction> => paneCompaction(`${CLAUDE_LINE}\n${line}`);

    should(under('  49%')).deepEqual({});
    should(under('  ▰▰▱▱ 49% done')).deepEqual({});
    should(under('  ▰▰▱▱ about 49%')).deepEqual({});
    should(under('  ▰▰▱▱ 120%')).deepEqual({});
    should(under('  ▰▰▱▱ 0%')).deepEqual({ percent: 0 });
    should(under('  ▰▰▰▰▰▰▰▰▰▰ 100%')).deepEqual({ percent: 100 });
  });

  it('should read the ↓ counter in any spinner glyph, and ignore a counter that is not a ↓ one', () => {
    should(paneCompaction('✢ Compacting conversation… (7m 14s · ↓ 37.4k tokens)')).deepEqual({ tokensWritten: 37_400 });
    should(paneCompaction('✻ Compacting conversation… (1m 2s · ↓ 812 tokens)')).deepEqual({ tokensWritten: 812 });
    should(paneCompaction('✻ Compacting conversation… (1m 2s · ↑ 9.9k tokens)')).deepEqual({});
  });

  it('should not read a percentage under prose that only mentions Compacting', () => {
    should(paneCompaction('• Compacting the cache before the build…\n  ▰▰▱▱ 49%')).be.undefined();
  });

  it('should still read the real frame when carriage returns end every line', () => {
    const frame = fixture('claude-2.1.28x-compacting-progress.txt').replaceAll('\n', '\r\n');

    should(paneCompaction(frame)).deepEqual({ percent: 49, tokensWritten: 37_400 });
    should(paneShowsCompaction(frame)).be.true();
  });
});

describe('expectedCompaction', () => {
  it('should fall back to the harness prior, labelled typical, with no history', () => {
    should(expectedCompaction('claude', [])).deepEqual({ expectedMs: 60_000, basis: 'typical' });
    should(expectedCompaction('codex', [])).deepEqual({ expectedMs: 40_000, basis: 'typical' });
    should(TYPICAL_COMPACTION_MS).deepEqual({ claude: 60_000, codex: 40_000 });
  });

  it('should take the median of what was watched, odd or even, whatever the order', () => {
    should(expectedCompaction('claude', [90_000, 10_000, 30_000])).deepEqual({ expectedMs: 30_000, basis: 'history' });
    should(expectedCompaction('codex', [40_000, 10_000, 20_000, 80_001])).deepEqual({
      expectedMs: 30_000,
      basis: 'history',
    });
    should(expectedCompaction('codex', [7])).deepEqual({ expectedMs: 7, basis: 'history' });
  });
});

describe('CompactionRecordSchema', () => {
  it('should refuse a duration that was not one compaction', () => {
    const entry = { harness: 'claude', durationMs: 5_000, at: at(0) };
    should(CompactionRecordSchema.safeParse(entry).success).be.true();
    should(CompactionRecordSchema.safeParse({ ...entry, durationMs: MAX_COMPACTION_MS + 1 }).success).be.false();
    should(CompactionRecordSchema.safeParse({ ...entry, durationMs: 0 }).success).be.false();
  });
});

describe('resolveCompaction', () => {
  it('should start tracking when the pane first shows a compaction, from the last known context size', () => {
    // Act
    const verdict = resolveCompaction(evidence({ paneCompacting: true, events: [usage(1, 140_000), chatter] }));

    // Assert
    should(verdict.tracker).deepEqual({ startedAt: at(10), tokensBefore: 140_000 });
    should(verdict.compaction).deepEqual({
      phase: 'running',
      startedAt: at(10),
      tokensBefore: 140_000,
      expectedMs: 60_000,
      basis: 'history',
    });
    should(verdict.finished).be.undefined();
  });

  it('should carry the percent and tokens the pane reported, and only while the pane shows the compaction', () => {
    // Arrange
    const tracker = { startedAt: at(2) };
    const progress = { percent: 49, tokensWritten: 37_400 };

    // Act
    const shown = resolveCompaction(evidence({ paneCompacting: true, progress, tracker }));
    const unreadable = resolveCompaction(evidence({ paneCompacting: undefined, progress, tracker }));
    const started = resolveCompaction(evidence({ paneCompacting: true, progress }));
    const bare = resolveCompaction(evidence({ paneCompacting: true, tracker }));

    // Assert
    should(shown.compaction).containDeep({ phase: 'running', percent: 49, tokensWritten: 37_400 });
    should(started.compaction).containDeep({ phase: 'running', percent: 49, tokensWritten: 37_400 });
    should(unreadable.compaction).not.have.property('percent');
    should(bare.compaction).not.have.property('percent');
    should(bare.compaction).not.have.property('tokensWritten');
  });

  it('should start with no context size when the transcript states none', () => {
    const verdict = resolveCompaction(evidence({ paneCompacting: true, events: [usage(1, undefined)] }));

    should(verdict.tracker).deepEqual({ startedAt: at(10) });
    should(verdict.compaction).not.have.property('tokensBefore');
  });

  it('should keep a tracked compaction running on its own start while the pane still shows it', () => {
    // Arrange
    const tracker = { startedAt: at(2), tokensBefore: 5 };

    // Act
    const verdict = resolveCompaction(evidence({ paneCompacting: true, tracker, nowMs: ms(30) }));

    // Assert
    should(verdict.tracker).equal(tracker);
    should(verdict.compaction).containDeep({ phase: 'running', startedAt: at(2), tokensBefore: 5 });
  });

  it('should keep it running, without tokensBefore, when the pane could not be read', () => {
    const tracker = { startedAt: at(2) };

    const verdict = resolveCompaction(evidence({ paneCompacting: undefined, tracker }));

    should(verdict.tracker).equal(tracker);
    should(verdict.compaction).containDeep({ phase: 'running', startedAt: at(2) });
    should(verdict.compaction).not.have.property('tokensBefore');
  });

  it('should answer nothing when the pane could not be read and nothing is tracked or recorded', () => {
    const verdict = resolveCompaction(evidence({ paneCompacting: undefined }));

    should(verdict).deepEqual({ compaction: undefined, tracker: undefined });
  });

  it('should end a tracked compaction at the boundary and hand its duration over exactly once', () => {
    // Arrange
    const tracker = { startedAt: at(0), tokensBefore: 150_000 };
    const events = [usage(-5, 150_000), boundary(41, { trigger: 'auto', tokensAfter: 9_000 })];

    // Act
    const first = resolveCompaction(evidence({ paneCompacting: false, tracker, events, nowMs: ms(42) }));
    const second = resolveCompaction(
      evidence({ paneCompacting: false, tracker: first.tracker, events, nowMs: ms(43) }),
    );

    // Assert
    should(first.compaction).deepEqual({
      phase: 'done',
      trigger: 'auto',
      startedAt: at(0),
      endedAt: at(41),
      tokensBefore: 150_000,
      tokensAfter: 9_000,
    });
    should(first.finished).deepEqual({ durationMs: 41_000, tokensBefore: 150_000 });
    should(first.tracker).deepEqual({ ...tracker, recorded: true });
    should(second.finished).be.undefined();
    should(second.compaction).deepEqual(first.compaction);
    should(second.tracker).equal(first.tracker);
  });

  it('should prefer the harness-stated count over the tracked one, and omit a count nobody has', () => {
    const tracker = { startedAt: at(0), tokensBefore: 1 };

    const stated = resolveCompaction(evidence({ tracker, events: [boundary(5, { tokensBefore: 99 })] }));
    const unstated = resolveCompaction(evidence({ tracker: { startedAt: at(0) }, events: [boundary(5)] }));

    should(stated.finished).deepEqual({ durationMs: 5_000, tokensBefore: 99 });
    should(unstated.finished).deepEqual({ durationMs: 5_000 });
  });

  it('should not record a duration that cannot have been one compaction', () => {
    const tooLong = resolveCompaction(
      evidence({
        tracker: { startedAt: at(0) },
        events: [boundary(MAX_COMPACTION_MS / 1_000 + 1)],
        nowMs: ms(MAX_COMPACTION_MS / 1_000 + 2),
      }),
    );
    const instant = resolveCompaction(evidence({ tracker: { startedAt: at(5) }, events: [boundary(5)] }));

    should(tooLong.finished).be.undefined();
    should(tooLong.tracker).containDeep({ recorded: true });
    should(instant.finished).be.undefined();
  });

  it('should end a tracked compaction on a boundary with no timestamp, at the moment it was noticed', () => {
    const verdict = resolveCompaction(
      evidence({ tracker: { startedAt: at(0) }, events: [boundary(undefined)], nowMs: ms(8) }),
    );

    should(verdict.compaction).containDeep({ phase: 'done', endedAt: at(8), startedAt: at(0) });
    should(verdict.finished).deepEqual({ durationMs: 8_000 });
  });

  it('should treat a still-painted line just after a boundary as lag, not a second compaction', () => {
    // Arrange
    const events = [boundary(9)];

    // Act
    const untracked = resolveCompaction(evidence({ paneCompacting: true, events, nowMs: ms(10) }));
    const recorded = resolveCompaction(
      evidence({ paneCompacting: true, events, tracker: { startedAt: at(0), recorded: true }, nowMs: ms(10) }),
    );

    // Assert
    should(untracked.compaction).containDeep({ phase: 'done', endedAt: at(9) });
    should(untracked.tracker).be.undefined();
    should(recorded.compaction).containDeep({ phase: 'done', startedAt: at(0) });
  });

  it('should see a second compaction after the first, even though the first tracker lingers', () => {
    // Arrange — the first ended at 9s and was recorded; a minute later the pane paints again.
    const events = [usage(8, 120_000), boundary(9), usage(20, 12_000), usage(70, 130_000)];

    // Act
    const verdict = resolveCompaction(
      evidence({ paneCompacting: true, events, tracker: { startedAt: at(0), recorded: true }, nowMs: ms(75) }),
    );

    // Assert
    should(verdict.tracker).deepEqual({ startedAt: at(75), tokensBefore: 130_000 });
    should(verdict.compaction).containDeep({ phase: 'running', startedAt: at(75), tokensBefore: 130_000 });
    should(verdict.finished).be.undefined();
  });

  it('should drop a tracked compaction whose line vanished with no boundary after it', () => {
    // Arrange — interrupted: the only boundary on record is from before this one began.
    const verdict = resolveCompaction(
      evidence({ paneCompacting: false, tracker: { startedAt: at(20) }, events: [boundary(3)], nowMs: ms(30) }),
    );

    // Assert — back to reading the old boundary from the tail alone.
    should(verdict.tracker).be.undefined();
    should(verdict.compaction).deepEqual({ phase: 'done', endedAt: at(3) });
  });

  it('should read a finished compaction from the tail alone, with the sizes either side of the boundary', () => {
    const events = [
      usage(1, 100_000),
      usage(2, undefined),
      boundary(5, { trigger: 'manual' }),
      usage(9, undefined),
      usage(10, 8_000),
    ];

    const verdict = resolveCompaction(evidence({ events }));

    should(verdict.compaction).deepEqual({
      phase: 'done',
      trigger: 'manual',
      endedAt: at(5),
      tokensBefore: 100_000,
      tokensAfter: 8_000,
    });
    should(verdict.tracker).be.undefined();
  });

  it('should leave the sizes out when the tail has no usage record to state them', () => {
    const verdict = resolveCompaction(evidence({ events: [chatter, boundary(5), chatter] }));

    should(verdict.compaction).deepEqual({ phase: 'done', endedAt: at(5) });
  });

  it('should not carry a start from a tracker that began after the boundary it is shown with', () => {
    const verdict = resolveCompaction(
      evidence({ paneCompacting: false, tracker: { startedAt: at(20) }, events: [boundary(5)], nowMs: ms(30) }),
    );

    should(verdict.compaction).not.have.property('startedAt');
  });

  it('should answer nothing at all with no boundary, no tracker and no line', () => {
    should(resolveCompaction(evidence({ events: [chatter] }))).deepEqual({ compaction: undefined, tracker: undefined });
  });
});
