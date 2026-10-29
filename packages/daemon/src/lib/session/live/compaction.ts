import type { SessionCompactionBasis, SessionCompactionState } from '@ferretry/protocol';
import { z } from 'zod';
import type { TranscriptEvent, TranscriptHarness } from '../../transcript/types.ts';
import { tokenCounterValue } from './policy.ts';

/**
 * WHEN A HARNESS IS COMPACTING ITS CONTEXT, AND HOW LONG THAT USUALLY TAKES.
 *
 * Four facts, three sources:
 *
 *   1. THE PANE says a compaction is RUNNING: Claude Code paints `✢ Compacting conversation… (7m 14s · ↓
 *      37.4k tokens)` and Codex `• Compacting (3s • Esc to interrupt)`. The line is matched only with its
 *      glyph, its ellipsis AND an interrupt/elapsed parenthetical, so an agent that merely writes the word
 *      "Compacting" in a reply cannot start one.
 *   2. THE PANE ALSO REPORTS PROGRESS, on current Claude Code: a bar and a whole percentage on the line
 *      DIRECTLY UNDER the Compacting line (`▰▰▰▱▱▱ 49%`), and the `↓ N tokens` counter in the parenthetical.
 *      Both are read as the harness's own numbers. Older Claude Code and Codex paint neither; then the
 *      frame carries neither, and nothing is estimated.
 *   3. THE TRANSCRIPT says it has ENDED: the harness's own boundary record (a `compaction` event),
 *      and the context sizes either side of it from the neighbouring usage records.
 *   4. THIS DAEMON'S HISTORY says how long one usually takes: the median of the compactions it has
 *      watched from start to end. With none yet, a fixed prior — and the frame says it is one (`typical`).
 *      It is shown as "usually ~Ns", only when the pane gave no real percent.
 *
 * Pure and total: captured text, parsed events and a tracker in, a verdict out.
 */

/** How far up from the bottom of a frame the status line may sit. */
const STATUS_WINDOW_LINES = 25;

/** A spinner or bullet glyph, `Compacting …`, an ellipsis, then a parenthetical naming a clock or Esc. */
const COMPACTING_LINE =
  /^\s*[•◦✻✳✶✽✢∗·✦✧]\s+Compacting\b[^\n(]{0,80}(?:…|\.\.\.)?\s*\([^)\n]*(?:interrupt|\d+\s*[hms]\b)[^)\n]*\)?\s*$/iu;

/** Claude Code's progress bar line: filled and empty block glyphs, then a whole percentage that ends the line. */
const PROGRESS_LINE = /^\s*[▰▱▮▯■□█▓▒░]+\s+(\d{1,3})\s?%\s*$/u;

/** The `↓ 37.4k tokens` counter inside the Compacting line's parenthetical. */
const WRITTEN_TOKENS = /↓\s*([\d.,]+)\s*([kKmM]?)\s*tokens?\b/u;

/** What the harness itself reports about a compaction it is running; a field is absent when it paints none. */
export interface PaneCompaction {
  /** Whole percent 0–100 off the bar under the Compacting line. */
  readonly percent?: number;
  /** Tokens written so far, off the `↓ N tokens` counter. */
  readonly tokensWritten?: number;
}

/**
 * The compaction a captured frame shows right now (`undefined` when none), with whatever progress the
 * harness paints. The percentage is taken only from the line DIRECTLY under the Compacting line.
 */
export const paneCompaction = (frame: string): PaneCompaction | undefined => {
  const lines = frame.replaceAll('\r\n', '\n').split('\n').slice(-STATUS_WINDOW_LINES);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string;
    if (!COMPACTING_LINE.test(line)) continue;
    const counter = WRITTEN_TOKENS.exec(line);
    const written = counter === null ? undefined : tokenCounterValue(counter[1] as string, counter[2] as string);
    const bar = PROGRESS_LINE.exec(lines[index + 1] ?? '');
    const percent = bar === null ? undefined : Number(bar[1]);
    return {
      ...(percent === undefined || percent > 100 ? {} : { percent }),
      ...(written === undefined ? {} : { tokensWritten: written }),
    };
  }
  return undefined;
};

/** Whether a captured frame shows the harness compacting right now. */
export const paneShowsCompaction = (frame: string): boolean => paneCompaction(frame) !== undefined;

/** The prior used until this daemon has watched one compaction, per harness. Assumptions, labelled `typical`. */
export const TYPICAL_COMPACTION_MS: Readonly<Record<TranscriptHarness, number>> = {
  claude: 60_000,
  codex: 40_000,
};

/** A watched compaction longer than this was not one compaction (a parked pane, a clock jump). */
export const MAX_COMPACTION_MS = 30 * 60_000;

/** How long after a boundary record a still-painted status line is read as lag, not a second compaction. */
const BOUNDARY_LAG_MS = 3_000;

export interface CompactionEstimate {
  readonly expectedMs: number;
  readonly basis: SessionCompactionBasis;
}

/** The median of the durations (milliseconds) when there are any, the harness's prior otherwise. */
export const expectedCompaction = (harness: TranscriptHarness, durations: readonly number[]): CompactionEstimate => {
  if (durations.length === 0) return { expectedMs: TYPICAL_COMPACTION_MS[harness], basis: 'typical' };
  const sorted = [...durations].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  return { expectedMs: Math.max(1, Math.round(median)), basis: 'history' };
};

/** One compaction this daemon watched from start to end. */
export const CompactionRecordSchema = z.strictObject({
  harness: z.enum(['claude', 'codex']),
  model: z.string().min(1).optional(),
  durationMs: z.number().int().positive().max(MAX_COMPACTION_MS),
  tokensBefore: z.number().int().nonnegative().optional(),
  at: z.iso.datetime(),
});
export type CompactionRecord = z.infer<typeof CompactionRecordSchema>;

/** This daemon's past compaction durations, kept so an estimate survives a restart. */
export interface CompactionHistory {
  /** The durations (milliseconds) of the most relevant past compactions: this model's, else this harness's. */
  durations(harness: TranscriptHarness, model: string | undefined): Promise<readonly number[]>;
  record(entry: CompactionRecord): Promise<void>;
}

/** What the source remembers between two samples of one session. */
export interface CompactionTracker {
  readonly startedAt: string;
  readonly tokensBefore?: number;
  /** Set once the finished compaction has been handed to the history, so it is kept exactly once. */
  readonly recorded?: boolean;
}

/** The pane and transcript evidence for one sample. */
export interface CompactionEvidence {
  readonly nowMs: number;
  /** `undefined` when the pane could not be read: the tracker is then left as it was. */
  readonly paneCompacting: boolean | undefined;
  /** What the pane reports about the compaction it shows; absent when it paints no progress. */
  readonly progress?: PaneCompaction;
  readonly events: readonly TranscriptEvent[];
  readonly tracker: CompactionTracker | undefined;
  readonly estimate: CompactionEstimate;
}

export interface CompactionVerdict {
  readonly compaction: SessionCompactionState | undefined;
  readonly tracker: CompactionTracker | undefined;
  /** Set once, on the sample that sees a tracked compaction end, for the history to keep. */
  readonly finished?: { readonly durationMs: number; readonly tokensBefore?: number };
}

const eventMs = (event: TranscriptEvent): number | undefined => {
  const parsed = event.timestamp === undefined ? Number.NaN : Date.parse(event.timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const contextOf = (event: TranscriptEvent): number | undefined =>
  event.kind === 'usage' ? event.usage.contextTokens : undefined;

/** The context size at the newest usage record before `before` (an index), when one states it. */
const contextBefore = (events: readonly TranscriptEvent[], before: number): number | undefined => {
  for (let index = before - 1; index >= 0; index -= 1) {
    const tokens = contextOf(events[index] as TranscriptEvent);
    if (tokens !== undefined) return tokens;
  }
  return undefined;
};

/** The context size at the first usage record after `after` (an index), when one states it. */
const contextAfter = (events: readonly TranscriptEvent[], after: number): number | undefined => {
  for (let index = after + 1; index < events.length; index += 1) {
    const tokens = contextOf(events[index] as TranscriptEvent);
    if (tokens !== undefined) return tokens;
  }
  return undefined;
};

const lastBoundary = (events: readonly TranscriptEvent[]): number => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if ((events[index] as TranscriptEvent).kind === 'compaction') return index;
  }
  return -1;
};

const instant = (ms: number): string => new Date(ms).toISOString();

/**
 * What compaction, if any, the evidence shows — and what to remember for the next sample.
 *
 * A boundary NEWER than the tracked start ends the tracked compaction; the pane being slow to clear
 * never keeps it running, and for {@link BOUNDARY_LAG_MS} after a boundary a still-painted line does
 * not start a new one. A tracked compaction whose line is gone with no boundary was interrupted (or
 * the harness records none): it is dropped rather than left running forever.
 */
export const resolveCompaction = (evidence: CompactionEvidence): CompactionVerdict => {
  const { nowMs, paneCompacting, events, estimate } = evidence;
  const boundaryIndex = lastBoundary(events);
  const boundary = boundaryIndex < 0 ? undefined : (events[boundaryIndex] as TranscriptEvent & { kind: 'compaction' });
  const boundaryMs = boundary === undefined ? undefined : (eventMs(boundary) ?? nowMs);
  const trackedMs = evidence.tracker === undefined ? undefined : Date.parse(evidence.tracker.startedAt);
  const ended = boundaryMs !== undefined && trackedMs !== undefined && boundaryMs >= trackedMs;

  const done = (tracker: CompactionTracker | undefined): SessionCompactionState | undefined => {
    if (boundary === undefined || boundaryMs === undefined) return undefined;
    const tokensBefore = boundary.tokensBefore ?? contextBefore(events, boundaryIndex);
    const tokensAfter = boundary.tokensAfter ?? contextAfter(events, boundaryIndex);
    const startedAt =
      tracker !== undefined && Date.parse(tracker.startedAt) <= boundaryMs ? tracker.startedAt : undefined;
    return {
      phase: 'done',
      ...(boundary.trigger === undefined ? {} : { trigger: boundary.trigger }),
      ...(startedAt === undefined ? {} : { startedAt }),
      endedAt: instant(boundaryMs),
      ...(tokensBefore === undefined ? {} : { tokensBefore }),
      ...(tokensAfter === undefined ? {} : { tokensAfter }),
    };
  };

  // A recorded, ended tracker whose line is painted again past the lag window is a NEW compaction: it falls through.
  const next =
    paneCompacting === true &&
    evidence.tracker?.recorded === true &&
    boundaryMs !== undefined &&
    nowMs - boundaryMs >= BOUNDARY_LAG_MS;
  if (evidence.tracker !== undefined && trackedMs !== undefined && ended && boundaryMs !== undefined && !next) {
    const durationMs = boundaryMs - trackedMs;
    const tokensBefore = boundary?.tokensBefore ?? evidence.tracker.tokensBefore;
    const keep = durationMs > 0 && durationMs <= MAX_COMPACTION_MS && evidence.tracker.recorded !== true;
    return {
      compaction: done(evidence.tracker),
      tracker: evidence.tracker.recorded === true ? evidence.tracker : { ...evidence.tracker, recorded: true },
      ...(keep ? { finished: { durationMs, ...(tokensBefore === undefined ? {} : { tokensBefore }) } } : {}),
    };
  }

  const progress = paneCompacting === true ? evidence.progress : undefined;
  const running = (tracker: CompactionTracker): SessionCompactionState => ({
    phase: 'running',
    startedAt: tracker.startedAt,
    ...(tracker.tokensBefore === undefined ? {} : { tokensBefore: tracker.tokensBefore }),
    ...(progress?.percent === undefined ? {} : { percent: progress.percent }),
    ...(progress?.tokensWritten === undefined ? {} : { tokensWritten: progress.tokensWritten }),
    expectedMs: estimate.expectedMs,
    basis: estimate.basis,
  });

  if (paneCompacting === true) {
    if (evidence.tracker !== undefined && !ended)
      return { compaction: running(evidence.tracker), tracker: evidence.tracker };
    if (boundaryMs !== undefined && nowMs - boundaryMs < BOUNDARY_LAG_MS) {
      return { compaction: done(evidence.tracker), tracker: evidence.tracker };
    }
    const tokensBefore = contextBefore(events, events.length);
    const tracker: CompactionTracker = {
      startedAt: instant(nowMs),
      ...(tokensBefore === undefined ? {} : { tokensBefore }),
    };
    return { compaction: running(tracker), tracker };
  }

  if (paneCompacting === undefined && evidence.tracker !== undefined && !ended) {
    return { compaction: running(evidence.tracker), tracker: evidence.tracker };
  }

  // The line is gone and no boundary followed the tracked start: interrupted, or nothing was recorded.
  const kept = ended ? evidence.tracker : undefined;
  return { compaction: done(kept), tracker: kept };
};
