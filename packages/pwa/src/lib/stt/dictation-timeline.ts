/**
 * SOLE OWNER of what "how long did each stage of a dictation take" means: the shape of one dictation's
 * timeline, the recorder that builds it, and the arithmetic every reader of it shares (the stacked bar,
 * the slowest stage, the median and p90 summary).
 *
 * A timeline answers one question the owner asked: "does transcription take longer, or does the cleanup
 * call?" It is numbers only — milliseconds, token counts, an engine and a model name. It holds no words
 * and no audio, so it travels with a transcription-log entry (`transcription-log.ts`, this device only)
 * and with a debug record (`dictation-debug.ts`, this tab only), and is never sent anywhere.
 *
 * Every duration is measured on a MONOTONIC clock (`performance.now()` in the page, a hand-moved one in
 * a test): a wall clock can jump while a call is in flight and give a stage a negative or absurd length.
 *
 * THE STAGES, in the order Stop walks them:
 *
 *   prepare  — Parakeet only: stop the recorder and decode/resample the take to 16 kHz mono.
 *   speech   — the engine turns the take into words. Parakeet: the decode itself (its first-time model
 *              load is reported beside it, `loadMs`, not folded in). Browser speech: how long Stop waited
 *              for the browser to settle its final words.
 *   context  — reading the conversation a hosted cleanup may read.
 *   cleanup  — the polish: a hosted call (Groq / Cerebras, straight from this browser or through the
 *              daemon) or the on-device correction. For a hosted call: when the first byte came back,
 *              how many attempts it took, and the tokens the provider says it used.
 *   insert   — putting the words into the composer, once the owner presses Insert.
 *
 * `totalMs` runs from Stop to the words being ready for review. The time the owner then spends reading
 * the review box is `reviewMs`, beside it and never inside it: it measures the owner, not the pipeline.
 *
 * WHAT IS NOT HERE, because it does not exist on these paths: time-to-first-token (the cleanup request
 * is not streamed, so first byte is the response head), a key rotation or provider fallback (one
 * provider is chosen per device), and a cooldown wait (a rate-limited call fails and keeps the raw
 * words; nothing sleeps and retries). The one retry that exists — the same call without the conversation,
 * when the provider found the request too big — shows as `attempts: 2, retried: 'without-context'`.
 */

import type { CleanupTrace } from '@ferretry/protocol';
import { z } from 'zod';

const Milliseconds = z.number().finite().nonnegative();
const Count = z.number().int().nonnegative();

const CleanupCallDetailSchema = z.strictObject({
  /** The whole hosted call: first request to the words in hand, across any retry. */
  totalMs: Milliseconds,
  /** When the response head arrived, from the start of the last attempt. Absent when unobservable. */
  firstByteMs: Milliseconds.optional(),
  attempts: z.number().int().min(1).max(2),
  retried: z.literal('without-context').optional(),
  promptTokens: Count.optional(),
  completionTokens: Count.optional(),
});
/** What a hosted cleanup call can say about itself; the dictation adds who made it. */
export type CleanupCallDetail = z.infer<typeof CleanupCallDetailSchema>;

const CleanupTimingSchema = CleanupCallDetailSchema.extend({
  /** `groq`, `cerebras`, or `local` for the on-device correction. */
  provider: z.string().min(1).max(32),
  model: z.string().min(1).max(128).optional(),
  /** This browser with its own key, the paired daemon, or the on-device correction. */
  via: z.enum(['device', 'daemon', 'local']),
  /** How long the daemon says the provider took; the rest of `totalMs` is the way there and back. */
  providerMs: Milliseconds.optional(),
  outcome: z.enum(['cleaned', 'kept_raw', 'failed']),
});
export type CleanupTiming = z.infer<typeof CleanupTimingSchema>;

const SpeechTimingSchema = z.strictObject({
  engine: z.enum(['parakeet', 'web-speech']),
  /** `on-device` for Parakeet, `browser` for the browser's own speech service. */
  provider: z.string().min(1).max(32).optional(),
  model: z.string().min(1).max(128).optional(),
  totalMs: Milliseconds,
  /** The one-time model load, reported only on the dictation that paid for it. */
  loadMs: Milliseconds.optional(),
});
type SpeechTiming = z.infer<typeof SpeechTimingSchema>;

export const DictationTimelineSchema = z.strictObject({
  /** Stop → the words are ready for review. */
  totalMs: Milliseconds,
  audio: z.strictObject({ ms: Milliseconds, bytes: Count.optional() }).optional(),
  prepareMs: Milliseconds.optional(),
  speech: SpeechTimingSchema,
  contextMs: Milliseconds.optional(),
  cleanup: CleanupTimingSchema.optional(),
  /** Putting the words into the composer; present once the owner has inserted them. */
  insertMs: Milliseconds.optional(),
  /** How long the owner kept the review box open before deciding. */
  reviewMs: Milliseconds.optional(),
});
export type DictationTimeline = z.infer<typeof DictationTimelineSchema>;

/** What a recognition session can say about the take it just finished. */
export interface SessionTimings {
  /** Recording length. */
  readonly audioMs?: number;
  /** The decoded take as handed to the engine. */
  readonly audioBytes?: number;
  readonly prepareMs?: number;
  readonly transcribeMs?: number;
  readonly loadMs?: number;
  readonly model?: string;
}

export type TimelineSpan = 'speech' | 'context' | 'cleanup';

export interface TimelineDetails {
  readonly engine: SpeechTiming['engine'];
  readonly provider?: string;
  readonly session?: SessionTimings;
  /** The recording's length by the dictation's own reckoning, when the session cannot say. */
  readonly audioMs?: number;
  readonly cleanup?: Omit<CleanupTiming, 'totalMs'>;
}

const rounded = (ms: number): number => Math.max(0, Math.round(ms * 10) / 10);

/**
 * Builds one dictation's timeline from a monotonic clock. It starts when constructed — construct it at
 * Stop — and measures spans of work with {@link measure}; {@link build} puts them together.
 */
export class DictationTimelineRecorder {
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #spans = new Map<TimelineSpan, number>();

  constructor(now: () => number) {
    this.#now = now;
    this.#startedAt = now();
  }

  /** Run `work` and keep how long it took, even when it throws: a failed call still took its time. */
  async measure<T>(span: TimelineSpan, work: () => Promise<T>): Promise<T> {
    const began = this.#now();
    try {
      return await work();
    } finally {
      this.#record(span, began);
    }
  }

  measureSync<T>(span: TimelineSpan, work: () => T): T {
    const began = this.#now();
    try {
      return work();
    } finally {
      this.#record(span, began);
    }
  }

  /** How long a span took, if it ran. */
  spanMs(span: TimelineSpan): number | undefined {
    return this.#spans.get(span);
  }

  /** The timeline so far, taking the total at this moment. */
  build(details: TimelineDetails): DictationTimeline {
    const totalMs = rounded(this.#now() - this.#startedAt);
    const { session } = details;
    const audioMs = session?.audioMs ?? details.audioMs;
    const speechMs = session?.transcribeMs ?? this.#spans.get('speech') ?? 0;
    const cleanupMs = this.#spans.get('cleanup');
    const contextMs = this.#spans.get('context');
    return {
      totalMs,
      ...(audioMs === undefined
        ? {}
        : {
            audio: {
              ms: rounded(audioMs),
              ...(session?.audioBytes === undefined ? {} : { bytes: session.audioBytes }),
            },
          }),
      ...(session?.prepareMs === undefined ? {} : { prepareMs: rounded(session.prepareMs) }),
      speech: {
        engine: details.engine,
        ...(details.provider === undefined ? {} : { provider: details.provider }),
        ...(session?.model === undefined ? {} : { model: session.model }),
        totalMs: rounded(speechMs),
        ...(session?.loadMs === undefined ? {} : { loadMs: rounded(session.loadMs) }),
      },
      ...(contextMs === undefined ? {} : { contextMs }),
      ...(details.cleanup === undefined || cleanupMs === undefined
        ? {}
        : { cleanup: { ...details.cleanup, totalMs: cleanupMs } }),
    };
  }

  #record(span: TimelineSpan, began: number): void {
    this.#spans.set(span, rounded(this.#now() - began));
  }
}

/** The timeline after the owner inserted the words: how long insertion took and how long they reviewed. */
export const withInsertion = (
  timeline: DictationTimeline,
  insertion: { readonly insertMs: number; readonly reviewMs: number },
): DictationTimeline => ({
  ...timeline,
  insertMs: rounded(insertion.insertMs),
  reviewMs: rounded(insertion.reviewMs),
});

/** The three parts of a dictation the bar tells apart. */
export type BarStage = 'speech' | 'cleanup' | 'other';

export interface BarSegment {
  readonly stage: BarStage;
  readonly ms: number;
}

/**
 * Speech, cleanup and everything else (stopping the recorder, decoding, reading the conversation,
 * waiting on the model to load), which together are the pipeline's `totalMs`. `other` is what remains,
 * so the three always sum to the total (or to the two named stages, if they somehow exceed it).
 */
export function barSegments(timeline: DictationTimeline): readonly BarSegment[] {
  const speech = timeline.speech.totalMs;
  const cleanup = timeline.cleanup?.totalMs ?? 0;
  return [
    { stage: 'speech', ms: speech },
    { stage: 'cleanup', ms: cleanup },
    { stage: 'other', ms: Math.max(0, timeline.totalMs - speech - cleanup) },
  ];
}

/** The stage that took longest. `undefined` when nothing took any time. */
export function slowestStage(timeline: DictationTimeline): BarStage | undefined {
  let slowest: BarSegment | undefined;
  for (const segment of barSegments(timeline)) {
    if (segment.ms > 0 && (slowest === undefined || segment.ms > slowest.ms)) slowest = segment;
  }
  return slowest?.stage;
}

/** Stop to the words being in the composer, without the time the owner spent reading. */
export const toComposerMs = (timeline: DictationTimeline): number => timeline.totalMs + (timeline.insertMs ?? 0);

/** Nearest-rank percentile of an already-sorted list; `p` is 0–100. */
export function percentile(sorted: readonly number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length);
  return sorted[Math.max(1, rank) - 1];
}

export interface TimingRow {
  readonly key: string;
  readonly count: number;
  readonly medianMs: number;
  readonly p90Ms: number;
}

export interface TimingSummary {
  /** Dictations the summary read: those among the newest `limit` that carry a timeline. */
  readonly dictations: number;
  readonly speech: readonly TimingRow[];
  readonly cleanup: readonly TimingRow[];
}

/** How many of the newest dictations the summary reads. */
export const TIMING_SUMMARY_WINDOW = 20;

const rowsOf = (groups: ReadonlyMap<string, number[]>): readonly TimingRow[] =>
  [...groups]
    .map(([key, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        key,
        count: sorted.length,
        medianMs: percentile(sorted, 50) ?? 0,
        p90Ms: percentile(sorted, 90) ?? 0,
      };
    })
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

/**
 * Median and p90 of the speech stage, per engine, and of the cleanup stage, per provider and path,
 * over the newest `limit` dictations that carry a timeline. `entries` are newest first.
 */
export function summarizeTimelines(
  entries: readonly { readonly timeline?: DictationTimeline | undefined }[],
  limit: number = TIMING_SUMMARY_WINDOW,
): TimingSummary {
  const timelines = entries.flatMap(entry => (entry.timeline === undefined ? [] : [entry.timeline])).slice(0, limit);
  const speech = new Map<string, number[]>();
  const cleanup = new Map<string, number[]>();
  for (const timeline of timelines) {
    speech.set(timeline.speech.engine, [...(speech.get(timeline.speech.engine) ?? []), timeline.speech.totalMs]);
    if (timeline.cleanup === undefined) continue;
    const key = `${timeline.cleanup.provider}/${timeline.cleanup.via}`;
    cleanup.set(key, [...(cleanup.get(key) ?? []), timeline.cleanup.totalMs]);
  }
  return { dictations: timelines.length, speech: rowsOf(speech), cleanup: rowsOf(cleanup) };
}

const counted = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The tokens a provider's reply says it used, from the reply as parsed. */
export function tokensOf(payload: unknown): Pick<CleanupCallDetail, 'promptTokens' | 'completionTokens'> {
  const usage = isRecord(payload) && isRecord(payload.usage) ? payload.usage : {};
  const promptTokens = counted(usage.prompt_tokens);
  const completionTokens = counted(usage.completion_tokens);
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
  };
}

export interface CleanupDetailsInput {
  readonly provider: string;
  readonly model?: string | undefined;
  readonly via: CleanupTiming['via'];
  readonly outcome: CleanupTiming['outcome'];
  /** What this browser measured of its own call (a device key). */
  readonly device?: CleanupCallDetail | undefined;
  /** How long the daemon says the provider took. */
  readonly providerMs?: number | undefined;
  /** The call's debug record, when one was asked for: it knows the attempts and the tokens. */
  readonly trace?: CleanupTrace | undefined;
}

/**
 * Everything a cleanup call says about itself except its own wall time, which the recorder measures.
 * A device call is measured here in the browser; a daemon call only reports its provider time, and its
 * attempts and tokens when the debug record came back.
 */
export function cleanupDetailsOf(input: CleanupDetailsInput): Omit<CleanupTiming, 'totalMs'> {
  const { device, trace } = input;
  const last = trace?.attempts.at(-1);
  const attempts = device?.attempts ?? Math.min(2, Math.max(1, trace?.attempts.length ?? 1));
  const promptTokens = device?.promptTokens ?? last?.response?.usage?.promptTokens;
  const completionTokens = device?.completionTokens ?? last?.response?.usage?.completionTokens;
  const firstByteMs = device?.firstByteMs;
  return {
    provider: input.provider,
    ...(input.model === undefined ? {} : { model: input.model }),
    via: input.via,
    outcome: input.outcome,
    attempts,
    ...(attempts > 1 ? { retried: 'without-context' as const } : {}),
    ...(firstByteMs === undefined ? {} : { firstByteMs }),
    ...(input.providerMs === undefined ? {} : { providerMs: input.providerMs }),
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
  };
}
