/**
 * The housekeeping worker's side: ONE request answered, over the two grants the thread was started with (a read-only
 * `credentials` root and the fetch to the manifest's hosts). The worker program (`daemon/worker/housekeeping.worker.ts`)
 * only wires the real grants into this; everything it decides is here, where an integration test drives it.
 *
 * This code reads the login's sign-in, parses it, uses the token for one request and drops it inside one job, and only
 * facts are posted back. The kernel's grant service on main serves the file read and the request, so the blob and the
 * Bearer header pass through main's heap as locals of that service, which never logs, answers or keeps them. A job
 * that throws is answered with a fixed word, never with what it threw.
 */
import type { Clock, FetchPort } from '@ferretry/kernel/contract';
import type {
  ActiveUsageJob,
  HousekeepingRequest,
  HousekeepingResponse,
} from '../../lib/credentials/housekeeping-protocol.ts';
import { AnthropicUsageProbe, quotaFetch } from './anthropic-usage-probe.ts';
import { CodexUsageProbe } from './codex-usage-probe.ts';
import { activeUsageRead, type MaterialReader, readStoreMaterial } from './material-read.ts';

/** What a job runs on. Built per request, so a probe (which the kernel starts with no grants) never reaches for one. */
export interface HousekeepingGrants {
  readonly root: MaterialReader;
  readonly fetch: FetchPort;
  readonly clock: Pick<Clock, 'after'>;
}

/**
 * A timer without `setTimeout` (a worker has no clock port to ask): the signal's own deadline. The probe's 20 s limit
 * is the one that bites; the daemon also gives the whole job a deadline and ends a worker that overruns it.
 */
export const signalClock: Pick<Clock, 'after'> = {
  after: (delay, fn) => {
    const deadline = AbortSignal.timeout(delay);
    deadline.addEventListener('abort', fn, { once: true });
    return () => deadline.removeEventListener('abort', fn);
  },
};

async function activeUsage(grants: HousekeepingGrants, job: ActiveUsageJob) {
  const quota = quotaFetch(grants.fetch, grants.clock);
  const material = await readStoreMaterial(grants.root, job.file, job.harness);
  return await activeUsageRead(job.harness, material, {
    anthropic: new AnthropicUsageProbe({ fetch: quota }),
    codex: new CodexUsageProbe({ fetch: quota, now: () => job.nowMs }),
  });
}

/** Answers one request. Total: a job that throws is `internal`, and nothing it threw is said. */
export async function answerHousekeeping(
  grants: () => HousekeepingGrants,
  request: HousekeepingRequest,
): Promise<HousekeepingResponse> {
  if ('probe' in request) return { probe: true };
  const { id, job } = request;
  try {
    return { type: 'result', id, ok: true, value: await activeUsage(grants(), job) };
  } catch {
    return { type: 'result', id, ok: false, failure: 'internal' };
  }
}
