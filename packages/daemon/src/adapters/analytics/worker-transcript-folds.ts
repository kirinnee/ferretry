import type { AnalyticsModelAliasGroup } from '@ferretry/protocol';
import type { AnalyticsTranscriptFoldSource } from '../../lib/analytics/ingestion.ts';
import { type AnalyticsTranscriptFold, foldAnalyticsTranscript } from '../../lib/analytics/usage-fold.ts';
import type { TranscriptHarness } from '../../lib/transcript/types.ts';
import { bundledWorkerUrl } from '../runtime/bundled-worker.ts';
import type { TranscriptFoldRequest, TranscriptFoldResponse } from './transcript-fold-protocol.ts';

/** The part of a Worker this adapter uses, so a test can stand in a thread that misbehaves on cue. */
export interface FoldWorker {
  onmessage: ((event: MessageEvent<TranscriptFoldResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(request: TranscriptFoldRequest): void;
  terminate(): void;
  unref?(): void;
}

export interface WorkerTranscriptFoldsOptions {
  /** How long one fold may take before the worker is presumed stuck and replaced. */
  readonly timeoutMs?: number;
  /** How long an idle worker is kept before its thread is ended; the next fold starts a fresh one. */
  readonly idleMs?: number;
  readonly spawn?: () => FoldWorker;
}

interface Pending {
  readonly resolve: (fold: AnalyticsTranscriptFold) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

const spawnBundled = (): FoldWorker => new Worker(bundledWorkerUrl('analytics-fold'), { type: 'module' });

/**
 * Analytics folds, run in a worker thread so the event loop never parses a finished transcript.
 *
 * THE FILE IS RESOLVED HERE, the reading and folding THERE. Resolution reads the session's own documents
 * through the daemon's storage, which lives on this thread and is cheap; everything that grows with the
 * transcript — the bounded read, every record's parse, the fold over every event — runs on the worker,
 * and only the fold, a handful of numbers, crosses back.
 *
 * ONE THREAD, STARTED ON DEMAND AND ENDED WHEN IDLE. Ingestion passes are minutes apart, so a thread kept
 * between them would be memory held for nothing. A thread that errors, or does not answer one fold in
 * time, is ended and every fold waiting on it is refused — a source error, exactly what a read that raised
 * on the event loop reported — and the next fold starts a fresh one.
 */
export class WorkerTranscriptFolds implements AnalyticsTranscriptFoldSource {
  readonly #pending = new Map<number, Pending>();
  readonly #timeoutMs: number;
  readonly #idleMs: number;
  readonly #spawn: () => FoldWorker;
  #worker: FoldWorker | undefined;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #next = 1;

  constructor(
    private readonly resolveFile: (sessionId: string) => Promise<string | undefined>,
    options: WorkerTranscriptFoldsOptions = {},
  ) {
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#idleMs = options.idleMs ?? 30_000;
    this.#spawn = options.spawn ?? spawnBundled;
  }

  async foldFor(
    sessionId: string,
    harness: TranscriptHarness,
    aliasGroups: readonly AnalyticsModelAliasGroup[],
  ): Promise<AnalyticsTranscriptFold> {
    const file = await this.resolveFile(sessionId).catch(() => undefined);
    if (file === undefined) return foldAnalyticsTranscript({ kind: 'unresolved' }, aliasGroups);
    return await this.#ask({ id: this.#next++, file, sessionId, harness, aliasGroups });
  }

  /** Ends the thread and refuses every fold still waiting on it. */
  close(): void {
    this.#discard(new Error('the analytics worker was closed'));
  }

  #ask(request: TranscriptFoldRequest): Promise<AnalyticsTranscriptFold> {
    const worker = this.#ensure();
    return new Promise<AnalyticsTranscriptFold>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#discard(
          new Error(`the analytics worker did not fold ${request.file} within ${String(this.#timeoutMs)} ms`),
        );
      }, this.#timeoutMs);
      this.#pending.set(request.id, { resolve, reject, timeout });
      worker.postMessage(request);
    });
  }

  #ensure(): FoldWorker {
    if (this.#idle !== undefined) clearTimeout(this.#idle);
    this.#idle = undefined;
    if (this.#worker !== undefined) return this.#worker;
    const worker = this.#spawn();
    // The thread must never be the reason a finished daemon stays alive.
    worker.unref?.();
    worker.onmessage = event => this.#settle(event.data);
    worker.onerror = event => this.#discard(new Error(`the analytics worker failed: ${event.message}`));
    this.#worker = worker;
    return worker;
  }

  #settle(response: TranscriptFoldResponse): void {
    if (!('id' in response)) return;
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return;
    this.#pending.delete(response.id);
    clearTimeout(pending.timeout);
    if ('fold' in response) pending.resolve(response.fold);
    else pending.reject(new Error(response.error));
    if (this.#pending.size === 0) this.#idle = setTimeout(() => this.#discard(undefined), this.#idleMs);
  }

  #discard(error: Error | undefined): void {
    if (this.#idle !== undefined) clearTimeout(this.#idle);
    this.#idle = undefined;
    this.#worker?.terminate();
    this.#worker = undefined;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error ?? new Error('the analytics worker was ended'));
    }
    this.#pending.clear();
  }
}
