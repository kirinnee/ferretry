import type { SessionCompactionState, SessionLiveActivity, SessionLiveTokensSource } from '@ferretry/protocol';
import type { TranscriptEvent, TranscriptHarness, TranscriptUsageEvent } from '../../transcript/types.ts';

/**
 * WHAT A WORKING TURN HAS DONE SO FAR, from the two places a harness says it.
 *
 *   1. THE PANE. Claude Code's status line carries its own live counter — `✽ Pontificating… (42s · ↓
 *      3.1k tokens · esc to interrupt)` — which moves while a reply streams, long before any record of
 *      it reaches the transcript. It is the freshest number there is, at the harness's own precision.
 *   2. THE TRANSCRIPT. Each model call leaves a usage record (Claude's `message.usage`, Codex's
 *      `token_count`), summed here over the turn with the SAME definitions Analytics prices: output is
 *      output, input is everything sent — fresh, cache read and cache write.
 *
 * Output takes whichever is larger, because both only grow within a turn and the smaller one is
 * simply behind. Input comes from the transcript alone; no harness paints it.
 *
 * UNKNOWN IS ABSENT. A tail that does not reach back to the turn's start cannot say what the turn
 * has used, so it says nothing — a partial sum shown as the total would be a smaller lie than zero,
 * but still a lie.
 *
 * Pure and total: captured text and parsed events in, a sample out.
 */

/** How far up from the bottom of a frame the status line may sit. */
const STATUS_WINDOW_LINES = 25;

/** Claude's spinner line: a glyph, the verb with its ellipsis, then an optional parenthetical. */
const CLAUDE_STATUS = /^\s*[✻✳✶✽✢∗·✦✧]\s+([^\s(…][^(…\n]{0,78}…)\s*(?:\(([^)\n]*)\)?)?\s*$/u;

/** Codex's `• Working (6m52s • Esc to interrupt)`. */
const CODEX_STATUS = /^\s*[•◦]\s+([A-Za-z][A-Za-z ]{0,40}?)\s*\(\s*\d+[hms][^)\n]*\)?\s*$/u;

/** A token counter in a status parenthetical: `↓ 3.1k tokens`, `12k tokens`. An `↑` one is not output. */
const OUTPUT_COUNTER = /^(?:↓\s*)?([\d.,]+)\s*([kKmM]?)\s*tokens?$/u;

/** What the harness's status line says, when it shows one. */
export interface PaneLiveReading {
  readonly verb: string;
  readonly outputTokens?: number;
}

/** `3.1k` → 3100, `12,345` → 12345, `1.2M` → 1200000; `undefined` for anything else. */
export const tokenCounterValue = (digits: string, unit: string): number | undefined => {
  const value = Number(digits.replaceAll(',', ''));
  if (!Number.isFinite(value) || value < 0) return undefined;
  const scale = unit === 'k' || unit === 'K' ? 1_000 : unit === 'm' || unit === 'M' ? 1_000_000 : 1;
  return Math.round(value * scale);
};

const claudeReading = (line: string): PaneLiveReading | undefined => {
  const match = CLAUDE_STATUS.exec(line);
  if (match === null) return undefined;
  const verb = (match[1] as string).trim();
  for (const part of (match[2] ?? '').split(/[·•∙]/u)) {
    const counter = OUTPUT_COUNTER.exec(part.trim());
    const tokens = counter === null ? undefined : tokenCounterValue(counter[1] as string, counter[2] as string);
    if (tokens !== undefined) return { verb, outputTokens: tokens };
  }
  return { verb };
};

const codexReading = (line: string): PaneLiveReading | undefined => {
  const match = CODEX_STATUS.exec(line);
  return match === null ? undefined : { verb: `${(match[1] as string).trim()}…` };
};

/** The harness's live status line in a captured frame, or `undefined` when it shows none. */
export const paneLiveReading = (frame: string): PaneLiveReading | undefined => {
  const lines = frame.replaceAll('\r\n', '\n').split('\n').slice(-STATUS_WINDOW_LINES);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string;
    const found = claudeReading(line) ?? codexReading(line);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** A turn's token totals so far; a missing field is one the transcript could not state. */
export interface TurnTokens {
  readonly outputTokens?: number;
  readonly inputTokens?: number;
}

/** How long before the daemon's recorded boundary the person's own message may sit and still open this turn. */
const BOUNDARY_SLACK_MS = 10_000;

const eventMs = (event: TranscriptEvent): number | undefined => {
  const parsed = event.timestamp === undefined ? Number.NaN : Date.parse(event.timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Where this turn begins in the transcript: the person's message that opened it, when it sits just
 * before the daemon's recorded boundary (the watcher notices a turn a tick after it starts), and the
 * boundary itself otherwise — a turn opened by a resume or a queued send has no message of its own.
 */
const turnBoundaryMs = (events: readonly TranscriptEvent[], turnStartedMs: number): number => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as TranscriptEvent;
    if (event.kind !== 'message' || event.role !== 'user') continue;
    const at = eventMs(event);
    if (at === undefined) continue;
    return at >= turnStartedMs - BOUNDARY_SLACK_MS ? Math.min(at, turnStartedMs) : turnStartedMs;
  }
  return turnStartedMs;
};

/** Everything sent to the model on one call, counted the way Analytics counts input. */
const grossInput = (harness: TranscriptHarness, usage: TranscriptUsageEvent['usage']): number =>
  harness === 'claude'
    ? (usage.inputTokens ?? 0) + (usage.cachedInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0)
    : (usage.inputTokens ?? 0);

/**
 * The turn's token totals from a transcript tail, or `undefined` when the tail cannot state them.
 *
 * `complete` says the tail is the whole transcript (it held fewer events than were asked for). An
 * incomplete tail whose oldest event is newer than the turn's start has lost some of the turn, and
 * says nothing. Claude writes one record per content block of a reply, each carrying the reply's
 * usage, so records sharing a message id are one call, counted once at its largest.
 */
export const turnTokensSince = (
  events: readonly TranscriptEvent[],
  turnStartedMs: number,
  complete: boolean,
): TurnTokens | undefined => {
  const boundary = turnBoundaryMs(events, turnStartedMs);
  const oldest = events.find(event => eventMs(event) !== undefined);
  const oldestMs = oldest === undefined ? undefined : eventMs(oldest);
  if (!complete && (oldestMs === undefined || oldestMs > boundary)) return undefined;
  const calls = new Map<string, { output: number; input: number }>();
  let unnamed = 0;
  let saw = false;
  for (const event of events) {
    if (event.kind !== 'usage') continue;
    const at = eventMs(event);
    if (at === undefined || at < boundary) continue;
    saw = true;
    const key = event.messageId ?? `unnamed:${unnamed++}`;
    const previous = calls.get(key);
    const output = event.usage.outputTokens ?? 0;
    const input = grossInput(event.harness, event.usage);
    calls.set(key, {
      output: Math.max(previous?.output ?? 0, output),
      input: Math.max(previous?.input ?? 0, input),
    });
  }
  if (!saw) return {};
  let outputTokens = 0;
  let inputTokens = 0;
  for (const call of calls.values()) {
    outputTokens += call.output;
    inputTokens += call.input;
  }
  return { outputTokens, inputTokens };
};

/** Everything one sample reads. */
export interface LiveSampleEvidence {
  readonly sessionId: string;
  readonly at: string;
  /** The working turn's start, or `undefined` when no turn is working. */
  readonly turnStartedAt: string | undefined;
  readonly pane: PaneLiveReading | undefined;
  readonly transcript: TurnTokens | undefined;
  /** The compaction the sample saw, when there was one; reported whether or not a turn is working. */
  readonly compaction?: SessionCompactionState | undefined;
}

/** One live sample. With no working turn it carries only the session and the instant. */
export const liveActivitySample = (evidence: LiveSampleEvidence): SessionLiveActivity => {
  const { sessionId, at, turnStartedAt, pane, transcript, compaction } = evidence;
  const compacting = compaction === undefined ? {} : { compaction };
  if (turnStartedAt === undefined) return { sessionId, at, ...compacting };
  const fromPane = pane?.outputTokens;
  const fromTranscript = transcript?.outputTokens;
  let outputTokens: number | undefined;
  let outputSource: SessionLiveTokensSource | undefined;
  if (fromPane !== undefined && (fromTranscript === undefined || fromPane >= fromTranscript)) {
    outputTokens = fromPane;
    outputSource = 'pane';
  } else if (fromTranscript !== undefined) {
    outputTokens = fromTranscript;
    outputSource = 'transcript';
  }
  return {
    sessionId,
    at,
    turnStartedAt,
    ...(pane === undefined ? {} : { verb: pane.verb }),
    ...(outputTokens === undefined ? {} : { outputTokens, outputSource }),
    ...(transcript?.inputTokens === undefined ? {} : { inputTokens: transcript.inputTokens }),
    ...compacting,
  };
};

/** Whether two samples say the same thing — the instant they were taken aside. */
export const sameLiveReading = (left: SessionLiveActivity | undefined, right: SessionLiveActivity): boolean =>
  left !== undefined &&
  left.sessionId === right.sessionId &&
  left.turnStartedAt === right.turnStartedAt &&
  left.verb === right.verb &&
  left.outputTokens === right.outputTokens &&
  left.inputTokens === right.inputTokens &&
  left.outputSource === right.outputSource &&
  JSON.stringify(left.compaction) === JSON.stringify(right.compaction);
