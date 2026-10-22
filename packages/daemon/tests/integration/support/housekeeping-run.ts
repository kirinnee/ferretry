/**
 * Runs housekeeping jobs on the REAL worker in a process of its own, and prints everything that was
 * said: each answer, every message in both directions, every console line, the profile window's tables.
 *
 * A process of its own because a worker thread reads the environment the PROCESS started with — a
 * `PATH` set by a test later is never seen by its `Bun.spawn` — and the keychain cases need a fake
 * `security` on the worker's `PATH`. Read from stdin: `{ settings, jobs, activity? }`.
 */
import { InlineHousekeepingJobs, WorkerHousekeepingJobs } from '../../../src/adapters/housekeeping/index.ts';
import { bundledWorkerUrl } from '../../../src/adapters/runtime/bundled-worker.ts';
import type {
  HousekeepingJob,
  HousekeepingRequest,
  HousekeepingResponse,
  HousekeepingSettings,
} from '../../../src/lib/housekeeping/protocol.ts';
import { PerformanceRecorder } from '../../../src/lib/performance/recorder.ts';

interface Spec {
  readonly settings: HousekeepingSettings;
  readonly jobs: readonly HousekeepingJob[];
  readonly activity?: string;
}

const spec = JSON.parse(await Bun.stdin.text()) as Spec;
const messages: unknown[] = [];
const consoled: string[] = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  console[level] = (...args: unknown[]) => {
    consoled.push(args.map(String).join(' '));
  };
}
const recorder = new PerformanceRecorder();
const window = recorder.open(0);
const notices: string[] = [];
const jobs = new WorkerHousekeepingJobs({
  settings: spec.settings,
  inline: new InlineHousekeepingJobs(spec.settings),
  probe: recorder,
  activity: () => spec.activity,
  idleMs: () => 1_000,
  retired: () => notices.push('retired'),
  spawn: () => {
    const thread = new Worker(bundledWorkerUrl('housekeeping'), { type: 'module' });
    // Both directions, as they cross: what main sent, and what the thread posted back.
    const spy = {
      onmessage: null as ((event: MessageEvent<HousekeepingResponse>) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage: (message: HousekeepingRequest) => {
        messages.push({ sent: message });
        thread.postMessage(message);
      },
      terminate: () => thread.terminate(),
      unref: () => thread.unref(),
    };
    thread.onmessage = (event: MessageEvent<HousekeepingResponse>) => {
      messages.push({ received: event.data });
      spy.onmessage?.(event);
    };
    thread.onerror = event => spy.onerror?.(event);
    return spy;
  },
});
const answers: unknown[] = [];
for (const job of spec.jobs) {
  answers.push(await jobs.run(job).catch((error: unknown) => ({ refused: String(error) })));
}
jobs.close();
process.stdout.write(JSON.stringify({ answers, messages, consoled, notices, tables: window.tables(60_000) }));
