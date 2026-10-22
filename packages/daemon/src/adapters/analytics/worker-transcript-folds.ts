import type { AnalyticsModelAliasGroup } from '@ferretry/protocol';
import type { AnalyticsTranscriptFoldSource } from '../../lib/analytics/ingestion.ts';
import { type AnalyticsTranscriptFold, foldAnalyticsTranscript } from '../../lib/analytics/usage-fold.ts';
import type { TranscriptHarness } from '../../lib/transcript/types.ts';
import { bundledWorkerUrl } from '../runtime/bundled-worker.ts';
import { BundledWorkerHost, type HostedAnswer, type HostedWorker } from '../runtime/bundled-worker-host.ts';
import type { TranscriptFoldRequest, TranscriptFoldResponse } from './transcript-fold-protocol.ts';

/** The part of a Worker this adapter uses, so a test can stand in a thread that misbehaves on cue. */
export type FoldWorker = HostedWorker<TranscriptFoldRequest, TranscriptFoldResponse>;

export interface WorkerTranscriptFoldsOptions {
  /** How long one fold may take before the worker is presumed stuck and replaced. */
  readonly timeoutMs?: number;
  /** How long an idle worker is kept before its thread is ended; the next fold starts a fresh one. */
  readonly idleMs?: number;
  readonly spawn?: () => FoldWorker;
}

const spawnBundled = (): FoldWorker => new Worker(bundledWorkerUrl('analytics-fold'), { type: 'module' });

/** A fold the worker made, or why it could not; a probe reply answers nothing. */
function foldAnswer(response: TranscriptFoldResponse): HostedAnswer<AnalyticsTranscriptFold> | undefined {
  if (!('id' in response)) return undefined;
  return 'fold' in response
    ? { id: response.id, ok: true, value: response.fold }
    : { id: response.id, ok: false, error: new Error(response.error) };
}

/**
 * Analytics folds, run in a worker thread so the event loop never parses a finished transcript.
 *
 * THE FILE IS RESOLVED HERE, the reading and folding THERE. Resolution reads the session's own documents
 * through the daemon's storage, which lives on this thread and is cheap; everything that grows with the
 * transcript — the bounded read, every record's parse, the fold over every event — runs on the worker,
 * and only the fold, a handful of numbers, crosses back.
 *
 * ONE THREAD, STARTED ON DEMAND AND ENDED WHEN IDLE ({@link BundledWorkerHost}). Ingestion passes are
 * minutes apart, so a thread kept between them would be memory held for nothing. A thread that errors,
 * or does not answer one fold in time, is ended and every fold waiting on it is refused — a source
 * error, exactly what a read that raised on the event loop reported — and the next fold starts a fresh one.
 */
export class WorkerTranscriptFolds implements AnalyticsTranscriptFoldSource {
  readonly #host: BundledWorkerHost<TranscriptFoldRequest, TranscriptFoldResponse, AnalyticsTranscriptFold>;

  constructor(
    private readonly resolveFile: (sessionId: string) => Promise<string | undefined>,
    options: WorkerTranscriptFoldsOptions = {},
  ) {
    const idleMs = options.idleMs ?? 30_000;
    this.#host = new BundledWorkerHost({
      label: 'the analytics worker',
      spawn: options.spawn ?? spawnBundled,
      answer: foldAnswer,
      timeoutMs: options.timeoutMs ?? 120_000,
      idleMs: () => idleMs,
    });
  }

  async foldFor(
    sessionId: string,
    harness: TranscriptHarness,
    aliasGroups: readonly AnalyticsModelAliasGroup[],
  ): Promise<AnalyticsTranscriptFold> {
    const file = await this.resolveFile(sessionId).catch(() => undefined);
    if (file === undefined) return foldAnalyticsTranscript({ kind: 'unresolved' }, aliasGroups);
    const id = this.#host.nextId();
    return await this.#host.request(id, { id, file, sessionId, harness, aliasGroups }, `fold ${file}`);
  }

  /** How many folds the thread holds right now: the queue depth a performance profile samples. */
  get inFlight(): number {
    return this.#host.inFlight;
  }

  /** Ends the thread and refuses every fold still waiting on it. */
  close(): void {
    this.#host.close();
  }
}
