/**
 * Housekeeping jobs, run on the housekeeping worker — or on the main thread when it is switched off
 * (`housekeeping.enabled: false`) or has been retired after crashing (docs/design/housekeeping-worker.md
 * §2.1, §2.5).
 *
 * ONE THREAD, KEPT WHILE THE FLEET IS READ. The fleet refresh recurs every usage interval, and starting a
 * bundled worker costs tens of milliseconds and a fresh heap, so the thread is kept for an interval past
 * its last job and ended only once passes stop. A job may take 30 s — longer than the free read's 20 s
 * fetch bound plus the keychain's 5 s — before the thread is presumed stuck.
 *
 * A FAILURE NEVER ANSWERS WRONG. A job the thread could not finish — it crashed, it stalled, it threw — is
 * refused, and the caller treats that as it always treated a failed read: an unreadable store, an
 * inconclusive check. A thread that keeps failing backs off (1 s, doubling to 60 s), and five failures in
 * ten minutes retire it until the daemon restarts; while it backs off or after it retires, jobs run on
 * the main thread, exactly as they did before the worker existed. Correctness never depends on it.
 *
 * NOTHING THE THREAD SAYS ABOUT A FAILURE IS REPEATED. A refusal is a fixed sentence and the closed
 * failure word, never the runtime's error message, which could quote what the thread was reading.
 */
import { commandLabel } from '@ferretry/protocol';
import type { HousekeepingJobs } from '../../lib/housekeeping/ports.ts';
import type {
  HousekeepingJob,
  HousekeepingJobValues,
  HousekeepingMetrics,
  HousekeepingRequest,
  HousekeepingResponse,
  HousekeepingSettings,
  HousekeepingValue,
} from '../../lib/housekeeping/protocol.ts';
import type { PerformanceProbe } from '../../lib/performance/recorder.ts';
import { bundledWorkerUrl } from '../runtime/bundled-worker.ts';
import {
  BundledWorkerHost,
  type HostedAnswer,
  type HostedWorker,
  type WorkerRestartPolicy,
} from '../runtime/bundled-worker-host.ts';
import { HousekeepingCounters, hostHousekeepingPorts, runHousekeepingJob } from './job-runner.ts';

/** The worker's name, in a profile and in `fyd --check`. */
export const HOUSEKEEPING_WORKER = 'housekeeping';

/** The part of a Worker this adapter uses. */
export type HousekeepingWorker = HostedWorker<HousekeepingRequest, HousekeepingResponse>;

/** Housekeeping jobs on the main thread: the code the worker runs, run here. */
export class InlineHousekeepingJobs implements HousekeepingJobs {
  constructor(
    private readonly settings: HousekeepingSettings,
    private readonly now: () => number = Date.now,
  ) {}

  async run<J extends HousekeepingJob>(job: J): Promise<HousekeepingJobValues[J['kind']]> {
    return await runHousekeepingJob(
      hostHousekeepingPorts(this.settings, new HousekeepingCounters(), { now: this.now }),
      job,
    );
  }
}

/** The back-off and retirement design §2.5 names. */
const HOUSEKEEPING_RESTART: WorkerRestartPolicy = Object.freeze({
  backoffMs: 1_000,
  maxBackoffMs: 60_000,
  maxFailures: 5,
  windowMs: 10 * 60_000,
});

export interface WorkerHousekeepingJobsOptions {
  readonly settings: HousekeepingSettings;
  /** Where a job runs while the thread backs off, and once it is retired. */
  readonly inline: HousekeepingJobs;
  /** Where each job's own account of its cost goes. */
  readonly probe: PerformanceProbe;
  /** The main-thread work running now, which a job's children are attributed to. */
  readonly activity?: () => string | undefined;
  /** How long an idle thread is kept: read each time it goes idle. */
  readonly idleMs: () => number;
  /** Told once, when the thread is retired. */
  readonly retired?: () => void;
  readonly timeoutMs?: number;
  readonly spawn?: () => HousekeepingWorker;
  readonly restart?: WorkerRestartPolicy;
  readonly now?: () => number;
}

const spawnBundled = (): HousekeepingWorker => new Worker(bundledWorkerUrl('housekeeping'), { type: 'module' });

/** A result from the thread as an answer; a refusal says only the closed failure word. */
function housekeepingAnswer(response: HousekeepingResponse): HostedAnswer<HousekeepingValue> | undefined {
  if (!('type' in response) || response.type !== 'result') return undefined;
  return response.ok
    ? { id: response.id, ok: true, value: response.value }
    : {
        id: response.id,
        ok: false,
        error: new Error(`the housekeeping worker could not finish a job (${response.failure})`),
      };
}

/** Housekeeping jobs on the housekeeping worker, with the main thread as the fallback. */
export class WorkerHousekeepingJobs implements HousekeepingJobs {
  readonly #host: BundledWorkerHost<HousekeepingRequest, HousekeepingResponse, HousekeepingValue>;
  readonly #inline: HousekeepingJobs;
  readonly #probe: PerformanceProbe;
  readonly #activity: () => string | undefined;
  /** The main-thread work that asked for each job still in flight, for its metrics. */
  readonly #askedBy = new Map<number, string | undefined>();

  constructor(options: WorkerHousekeepingJobsOptions) {
    this.#inline = options.inline;
    this.#probe = options.probe;
    this.#activity = options.activity ?? (() => undefined);
    this.#host = new BundledWorkerHost({
      label: 'the housekeeping worker',
      spawn: options.spawn ?? spawnBundled,
      answer: housekeepingAnswer,
      other: message => this.#other(message),
      greeting: () => options.settings,
      timeoutMs: options.timeoutMs ?? 30_000,
      idleMs: options.idleMs,
      // Never the runtime's message: this thread reads credential stores.
      failure: () => 'the housekeeping worker stopped',
      restart: options.restart ?? HOUSEKEEPING_RESTART,
      ...(options.retired === undefined ? {} : { retired: options.retired }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  async run<J extends HousekeepingJob>(job: J): Promise<HousekeepingJobValues[J['kind']]> {
    if (!this.#host.available) return await this.#inline.run(job);
    const id = this.#host.nextId();
    this.#askedBy.set(id, this.#activity());
    try {
      const value = await this.#host.request(id, { type: 'job', id, job }, `finish a ${job.kind} job`);
      return value as HousekeepingJobValues[J['kind']];
    } finally {
      this.#askedBy.delete(id);
    }
  }

  /** How many jobs the thread holds right now: the queue depth a performance profile samples. */
  get inFlight(): number {
    return this.#host.inFlight;
  }

  /** Whether the thread was retired, and every job now runs on the main thread. */
  get retired(): boolean {
    return this.#host.retired;
  }

  /** Ends the thread and refuses every job still waiting on it. */
  close(): void {
    this.#host.close();
  }

  #other(message: HousekeepingResponse): void {
    if ('type' in message && message.type === 'metrics') this.#metrics(message);
  }

  #metrics(metrics: HousekeepingMetrics): void {
    if (!this.#probe.recording) return;
    this.#probe.workerJob(
      HOUSEKEEPING_WORKER,
      {
        wallMs: metrics.wallMs,
        // Labelled here, by the one function that labels every command in a report: program and
        // subcommand only, so a keychain service name never reaches a profile.
        children: metrics.children.map(child => ({ command: commandLabel(child.argv), wallMs: child.wallMs })),
        fileReads: metrics.fileReads,
        fetches: metrics.fetches,
        heapBytes: metrics.heapBytes,
      },
      this.#askedBy.get(metrics.id),
    );
  }
}
