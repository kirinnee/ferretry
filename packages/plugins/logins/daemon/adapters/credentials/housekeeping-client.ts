/**
 * The daemon's end of the housekeeping worker: the free usage read of a sign-in is a JOB on one worker thread, so the
 * sign-in's token is read, sent to its provider and dropped on that thread and never exists on the daemon's.
 *
 * The thread is started on first use with exactly two grants: the `credentials` root (READ-ONLY) and the two provider
 * hosts the manifest declares. It is not a sandbox (GAP, see `WorkerStartOptions`): the repository's lints and the
 * bundle diet test (S177) are what keep plugin code off the world around those ports.
 *
 * A job has a deadline. One that overruns it, a thread that ends, and a worker that answers a job with a failure all
 * come back as ONE fixed sentence; what the worker threw is never said. The status service already reads a throw as an
 * inconclusive read, so a dead worker degrades a login's status to "not measured" and never to a rejection.
 */
import type { Clock, WorkerHandle, WorkersPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type { ActiveUsageRead } from '../../lib/credentials/credential-status.ts';
import type { ActiveUsageJob, HousekeepingRequest } from '../../lib/credentials/housekeeping-protocol.ts';

/** The worker program, a module of this package: a compiled binary embeds it and resolves it beside the entry. */
export const HOUSEKEEPING_WORKER_URL = new URL('../../worker/housekeeping.worker.ts', import.meta.url);

/** The only hosts the thread may reach: each is in the manifest's `permissions.network`. */
export const HOUSEKEEPING_HOSTS: readonly string[] = ['api.anthropic.com', 'chatgpt.com'];

/** The whole of what a failed job says. */
export const HOUSEKEEPING_FAILED = 'the sign-in read could not be completed';

/** A job's deadline: the probe's own 20 s, and a margin for the read and the hop. */
const JOB_TIMEOUT_MS = 30_000;

export interface HousekeepingPorts {
  readonly workers: Pick<WorkersPort, 'start'>;
  readonly clock: Pick<Clock, 'after' | 'nowMs'>;
}

export interface HousekeepingClient {
  /** The free read of the sign-in at `file` (relative to the `credentials` root). Rejects with a fixed sentence. */
  activeUsage(harness: ActiveUsageJob['harness'], file: string): Promise<ActiveUsageRead>;
  /** Ends the thread; a later job starts a new one only if the client is not stopped. */
  stop(): Promise<void>;
}

interface Waiting {
  readonly resolve: (value: ActiveUsageRead) => void;
  readonly reject: (error: Error) => void;
  readonly cancel: () => void;
}

/** A worker's answer to a job, or nothing when it is not one. */
function answerOf(message: unknown): { id: number; value: ActiveUsageRead | undefined } | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const answer = message as { type?: unknown; id?: unknown; ok?: unknown; value?: unknown };
  if (answer.type !== 'result' || typeof answer.id !== 'number') return undefined;
  const value = answer.value as { result?: unknown; local?: unknown } | null | undefined;
  const whole = typeof value === 'object' && value !== null && 'result' in value && 'local' in value;
  return { id: answer.id, value: answer.ok === true && whole ? (answer.value as ActiveUsageRead) : undefined };
}

export function housekeepingClient(ports: HousekeepingPorts): HousekeepingClient {
  const waiting = new Map<number, Waiting>();
  let worker: WorkerHandle | undefined;
  let stopped = false;
  let next = 0;

  const failAll = (): void => {
    const all = [...waiting.values()];
    waiting.clear();
    for (const wait of all) {
      wait.cancel();
      wait.reject(new Error(HOUSEKEEPING_FAILED));
    }
  };
  const end = async (handle: WorkerHandle): Promise<void> => {
    if (worker === handle) worker = undefined;
    failAll();
    await handle.terminate().catch(() => undefined);
  };
  const thread = (): WorkerHandle => {
    if (worker !== undefined) return worker;
    const handle = ports.workers.start(HOUSEKEEPING_WORKER_URL, {
      name: 'housekeeping',
      roots: ['credentials'],
      network: HOUSEKEEPING_HOSTS,
    });
    handle.onMessage(message => {
      const answer = answerOf(message);
      const wait = answer === undefined ? undefined : waiting.get(answer.id);
      if (answer === undefined || wait === undefined) return;
      waiting.delete(answer.id);
      wait.cancel();
      if (answer.value === undefined) wait.reject(new Error(HOUSEKEEPING_FAILED));
      else wait.resolve(answer.value);
    });
    handle.onExit(() => {
      if (worker === handle) worker = undefined;
      failAll();
    });
    worker = handle;
    return handle;
  };

  return {
    activeUsage: (harness, file) =>
      new Promise<ActiveUsageRead>((resolve, reject) => {
        if (stopped) return reject(new Error(HOUSEKEEPING_FAILED));
        const handle = thread();
        const id = next++;
        const cancel = ports.clock.after(milliseconds(JOB_TIMEOUT_MS), () => {
          waiting.delete(id);
          reject(new Error(HOUSEKEEPING_FAILED));
          // A read that overran may be stuck inside the thread: end it, so the next job starts a clean one.
          void end(handle);
        });
        waiting.set(id, { resolve, reject, cancel });
        const job: ActiveUsageJob = { kind: 'credential.active', harness, file, nowMs: ports.clock.nowMs() };
        handle.post({ type: 'job', id, job } satisfies HousekeepingRequest);
      }),
    stop: async () => {
      stopped = true;
      if (worker !== undefined) await end(worker);
    },
  };
}
