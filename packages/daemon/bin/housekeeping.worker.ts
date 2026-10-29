/**
 * The housekeeping worker: the fleet's credential reads, free usage reads and passive usage reads, and
 * the walk of a Codex home for an undiscovered session's rollout, on their own thread
 * (docs/design/housekeeping-worker.md §2).
 *
 * Main asks by job and keeps everything that lasts: the locks, the kept facts, the status heads, the
 * usage cache, the claims and every binding. This thread keeps nothing between jobs but the rollout
 * index's cache of what each rollout and directory was found to be — lost with the thread, and rebuilt by
 * its next walk. A login's token is read, used for one request and
 * dropped inside one job (`MaterialCredentialReads`), so it never exists in the main thread's heap, and
 * only facts are posted back. A job that throws is answered with a fixed failure, never with what it
 * threw: a parser's message can quote the bytes it failed on.
 *
 * After each job the worker posts what that job cost — the children it started, the files it opened,
 * the requests it made, its heap — because main's instruments count main's `Bun.spawn` and main's file
 * ports, and cannot see inside this thread.
 */
import {
  HousekeepingCounters,
  hostHousekeepingPorts,
  runHousekeepingJob,
} from '../src/adapters/housekeeping/job-runner.ts';
import { memoryUsage } from '../src/adapters/runtime/memory-usage.ts';
import { NodeCodexRolloutIndex } from '../src/adapters/session/transcript/node-codex-rollout-index.ts';
import type {
  HousekeepingRequest,
  HousekeepingResponse,
  HousekeepingSettings,
} from '../src/lib/housekeeping/protocol.ts';

const post = (response: HousekeepingResponse): void => postMessage(response);

declare const self: { onmessage: ((event: MessageEvent<HousekeepingRequest>) => void) | null };

let settings: HousekeepingSettings | undefined;
/** The one rollout index of this thread, so a walk re-reads only the rollouts and directories that moved. */
const rollouts = new NodeCodexRolloutIndex();

self.onmessage = async event => {
  const request = event.data;
  if ('probe' in request) return post({ probe: true });
  if (request.type === 'settings') {
    settings = request;
    return;
  }
  const { id, job } = request;
  if (settings === undefined) return post({ type: 'result', id, ok: false, failure: 'unsettled' });
  const counters = new HousekeepingCounters();
  const started = performance.now();
  let response: HousekeepingResponse;
  try {
    response = {
      type: 'result',
      id,
      ok: true,
      value: await runHousekeepingJob(hostHousekeepingPorts(settings, counters, { rollouts }), job),
    };
  } catch {
    response = { type: 'result', id, ok: false, failure: 'internal' };
  }
  post({
    type: 'metrics',
    id,
    kind: job.kind,
    wallMs: performance.now() - started,
    children: counters.children,
    fileReads: counters.fileReads,
    fetches: counters.fetches,
    heapBytes: memoryUsage().heapTotal,
  });
  post(response);
};
