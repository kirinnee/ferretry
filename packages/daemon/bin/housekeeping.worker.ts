/**
 * The housekeeping worker: the fleet's credential reads, free usage reads and passive usage reads, on
 * their own thread (docs/design/housekeeping-worker.md §2).
 *
 * Main asks by job and keeps everything that lasts: the locks, the kept facts, the status heads, the
 * usage cache. This thread keeps nothing between jobs. A login's token is read, used for one request and
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
import type {
  HousekeepingRequest,
  HousekeepingResponse,
  HousekeepingSettings,
} from '../src/lib/housekeeping/protocol.ts';

const post = (response: HousekeepingResponse): void => postMessage(response);

declare const self: { onmessage: ((event: MessageEvent<HousekeepingRequest>) => void) | null };

let settings: HousekeepingSettings | undefined;

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
      value: await runHousekeepingJob(hostHousekeepingPorts(settings, counters), job),
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
    heapBytes: process.memoryUsage().heapTotal,
  });
  post(response);
};
