/**
 * WHERE A HOUSEKEEPING JOB RUNS, AND WHAT THE MAIN THREAD KEEPS (docs/design/housekeeping-worker.md §2.2,
 * §2.5).
 *
 * A scripted thread stands in for the worker, so each case can make it answer, refuse or crash: a job
 * the thread could not finish is refused in fixed words; a thread backing off or retired sends the job
 * to the main thread, which runs the very same job code; each job's own account of its cost reaches the
 * profiler only while one records. The credential ports keep a store's facts on the main thread and send
 * no job at all while its file stamp holds — and on a Mac, the same job code run on the main thread
 * counts the keychain's child and the fallback file it falls through to.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClaudeStoreResolution } from '@ferretry/fleet';
import { credentialFileStamp } from '@ferretry/fleet/adapters';
import should from 'should';
import {
  HousekeepingCounters,
  type HousekeepingWorker,
  hostHousekeepingPorts,
  InlineHousekeepingJobs,
  WorkerCredentialPorts,
  WorkerHousekeepingJobs,
} from '../../../src/adapters/housekeeping/index.ts';
import type { HousekeepingJobs } from '../../../src/lib/housekeeping/ports.ts';
import type {
  HousekeepingJob,
  HousekeepingRequest,
  HousekeepingResponse,
  HousekeepingSettings,
} from '../../../src/lib/housekeeping/protocol.ts';
import { PerformanceRecorder } from '../../../src/lib/performance/recorder.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

const NOW = Date.now();
const claudeBlob = (token: string): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `${token}-r`, expiresAt: NOW + 3_600_000 } });

let root: string;
let work: ClaudeStoreResolution;

beforeAll(async () => {
  root = await tempDirectory('fyd-housekeeping-jobs-');
  work = {
    harness: 'claude',
    store: 'ferretry',
    secureStorage: join(root, 'credentials', 'work'),
    credentialFile: join(root, 'credentials', 'work', '.credentials.json'),
  } as ClaudeStoreResolution;
  await mkdir(join(root, 'credentials', 'work'), { recursive: true });
  await writeFile(work.credentialFile, claudeBlob('work-TESTONLY'));
});

afterAll(async () => {
  await cleanupTempDirectories();
});

const settingsOf = (overrides: Partial<HousekeepingSettings> = {}): HousekeepingSettings => ({
  type: 'settings',
  platform: 'linux',
  keychainAccount: 'person',
  defaultClaudeHome: join(root, 'default-claude'),
  fleetRoot: root,
  ...overrides,
});

/** A worker a test drives: it records what it was sent and answers however the test says. */
class ScriptedWorker implements HousekeepingWorker {
  onmessage: ((event: MessageEvent<HousekeepingResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: HousekeepingRequest[] = [];

  constructor(private readonly answer: (request: HousekeepingRequest, worker: ScriptedWorker) => void) {}

  postMessage(request: HousekeepingRequest): void {
    this.sent.push(request);
    queueMicrotask(() => this.answer(request, this));
  }

  reply(response: HousekeepingResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<HousekeepingResponse>);
  }

  terminate(): void {}
}

/** The main thread's stand-in, which says where each job went. */
class RecordingJobs implements HousekeepingJobs {
  readonly ran: HousekeepingJob[] = [];

  async run<J extends HousekeepingJob>(job: J): Promise<never> {
    this.ran.push(job);
    return null as never;
  }
}

const PASSIVE: HousekeepingJob = { kind: 'usage.passive.claude', credential: 'work' };

const refusal = async (pending: Promise<unknown>): Promise<string> =>
  await pending.then(
    () => 'answered',
    (error: Error) => error.message,
  );

describe('WorkerHousekeepingJobs', () => {
  it('should greet each thread with its settings and answer a job with what the thread said', async () => {
    // Arrange
    const workers: ScriptedWorker[] = [];
    const jobs = new WorkerHousekeepingJobs({
      settings: settingsOf(),
      inline: new RecordingJobs(),
      probe: new PerformanceRecorder(),
      idleMs: () => 1_000,
      spawn: () => {
        const worker = new ScriptedWorker((request, self) => {
          if ('type' in request && request.type === 'job') {
            self.reply({ probe: true });
            self.reply({ type: 'result', id: request.id, ok: true, value: null });
          }
        });
        workers.push(worker);
        return worker;
      },
    });

    // Act
    const answer = await jobs.run(PASSIVE);
    const held = jobs.inFlight;
    jobs.close();

    // Assert
    should(answer).be.null();
    should(held).equal(0);
    should(workers[0]?.sent[0]).match({ type: 'settings', fleetRoot: root });
    should(workers[0]?.sent[1]).match({ type: 'job', job: PASSIVE });
  });

  it('should refuse a job the thread could not finish in fixed words, and never quote a crash', async () => {
    // Arrange
    let crash = false;
    const jobs = new WorkerHousekeepingJobs({
      settings: settingsOf(),
      inline: new RecordingJobs(),
      probe: new PerformanceRecorder(),
      idleMs: () => 1_000,
      restart: { backoffMs: 0, maxBackoffMs: 0, maxFailures: 99, windowMs: 1 },
      spawn: () =>
        new ScriptedWorker((request, self) => {
          if (!('type' in request) || request.type !== 'job') return;
          if (crash) self.onerror?.({ message: 'SyntaxError near "sk-ant-TESTONLY"' } as ErrorEvent);
          else self.reply({ type: 'result', id: request.id, ok: false, failure: 'internal' });
        }),
    });

    // Act
    const refused = await refusal(jobs.run(PASSIVE));
    crash = true;
    const crashed = await refusal(jobs.run(PASSIVE));
    jobs.close();

    // Assert
    should(refused).equal('the housekeeping worker could not finish a job (internal)');
    should(crashed).equal('the housekeeping worker stopped');
  });

  it('should run jobs on the main thread while the thread backs off, and for good once it is retired', async () => {
    // Arrange
    let now = 0;
    const inline = new RecordingJobs();
    const retired: string[] = [];
    let spawned = 0;
    const jobs = new WorkerHousekeepingJobs({
      settings: settingsOf(),
      inline,
      probe: new PerformanceRecorder(),
      idleMs: () => 1_000,
      now: () => now,
      restart: { backoffMs: 1_000, maxBackoffMs: 1_000, maxFailures: 2, windowMs: 60_000 },
      retired: () => retired.push('retired'),
      spawn: () => {
        spawned += 1;
        return new ScriptedWorker((request, self) => {
          if ('type' in request && request.type === 'job') self.onerror?.({ message: 'down' } as ErrorEvent);
        });
      },
    });

    // Act
    await refusal(jobs.run(PASSIVE));
    await jobs.run(PASSIVE);
    now = 1_000;
    await refusal(jobs.run(PASSIVE));
    now = 1_000_000;
    await jobs.run(PASSIVE);

    // Assert — two failures on the thread; the job asked while backing off and the one after went inline.
    should(spawned).equal(2);
    should(inline.ran).have.length(2);
    should(jobs.retired).be.true();
    should(retired).deepEqual(['retired']);
  });

  it('should hand each job’s cost to the profiler only while one records, labelled and attributed', async () => {
    // Arrange
    const recorder = new PerformanceRecorder();
    const jobs = new WorkerHousekeepingJobs({
      settings: settingsOf(),
      inline: new RecordingJobs(),
      probe: recorder,
      activity: () => 'fleet refresh',
      idleMs: () => 1_000,
      spawn: () =>
        new ScriptedWorker((request, self) => {
          if (!('type' in request) || request.type !== 'job') return;
          self.reply({
            type: 'metrics',
            id: request.id,
            kind: request.job.kind,
            wallMs: 12,
            children: [
              {
                argv: ['/usr/bin/security', 'find-generic-password', '-s', 'Claude Code-credentials-ab12'],
                wallMs: 9,
              },
            ],
            fileReads: 1,
            fetches: 1,
            heapBytes: 2 * 1_048_576,
          });
          self.reply({ type: 'result', id: request.id, ok: true, value: null });
        }),
    });

    // Act — one job unwatched, one inside a window.
    await jobs.run(PASSIVE);
    const window = recorder.open(0);
    await jobs.run(PASSIVE);
    jobs.close();
    const [stats] = window.tables(60_000).workers;

    // Assert — one job counted, its child by program and subcommand only, never the item's name.
    should(stats).match({
      name: 'housekeeping',
      work: {
        jobs: 1,
        fileReads: 1,
        fetches: 1,
        heapMb: { max: 2 },
        childProcesses: [
          { command: 'security find-generic-password', count: 1, by: [{ activity: 'fleet refresh', count: 1 }] },
        ],
      },
    });
    should(JSON.stringify(stats)).not.match(/Claude Code-credentials/);
  });
});

describe('WorkerCredentialPorts', () => {
  it('should send no job for a store whose file stamp held, and one when it moved', async () => {
    // Arrange
    const sent: HousekeepingJob[] = [];
    const inline = new InlineHousekeepingJobs(settingsOf());
    const ports = new WorkerCredentialPorts({
      jobs: {
        run: async job => {
          sent.push(job);
          return await inline.run(job);
        },
      },
      stamp: credentialFileStamp,
      keychain: false,
      keychainFreshMs: () => 60_000,
      now: () => NOW,
      cache: new Map(),
      catalog: { entry: async () => ({ usedBy: [] }) } as never,
      sessions: async () => [],
    });

    // Act
    const first = await ports.local(work);
    const again = await ports.local(work);
    await writeFile(work.credentialFile, claudeBlob('rotated-TESTONLY'));
    const moved = await ports.local(work);
    const passive = await ports.passiveUsage({ id: 'work', resolution: work });

    // Assert
    should(sent.map(job => job.kind)).deepEqual(['credential.local', 'credential.local', 'usage.passive.claude']);
    should(again).equal(first);
    should(moved.fingerprint).not.equal(first.fingerprint);
    should(passive).be.undefined();
  });
});

describe('hostHousekeepingPorts on a Mac', () => {
  for (const [name, keychain, fileReads] of [
    ['held no login (exit 44), so the file beside it was read', { code: 44, stdout: '' }, 1],
    ['answered with the login, so the file was never read', { code: 0, stdout: claudeBlob('keychain-TESTONLY') }, 0],
  ] as const) {
    it(`should count the keychain child when the keychain ${name}`, async () => {
      // Arrange
      const counters = new HousekeepingCounters();
      let clock = 0;
      const ports = hostHousekeepingPorts(settingsOf({ platform: 'darwin' }), counters, {
        now: () => (clock += 5),
        command: { run: async () => keychain },
      });

      // Act
      const facts = await ports.reads.facts(work);

      // Assert — Claude's own order: the keychain item first, its file only when the item is absent.
      should(facts).match({ shape: { kind: 'tokens' } });
      should(counters.children.map(child => child.argv.slice(0, 2))).deepEqual([['security', 'find-generic-password']]);
      should(counters.children[0]?.wallMs).equal(5);
      should(counters.fileReads).equal(fileReads);
    });
  }
});
