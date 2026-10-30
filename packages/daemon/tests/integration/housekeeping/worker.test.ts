/**
 * THE HOUSEKEEPING WORKER CONCLUDES EXACTLY WHAT THE MAIN THREAD WOULD (docs/design/housekeeping-worker.md
 * §2.1, §4 PR 2).
 *
 * The real worker program, over a real temporary fleet — two Claude logins in Ferretry's file store, one
 * Codex `auth.json`, a statusLine `usage.json`, two attributed rollouts, a Codex home with an undiscovered
 * session's rollout — and a loopback stand-in for both usage endpoints. Every job kind is answered twice, by the worker and by the same job code on this
 * thread, and the answers must agree. Then: what a job costs reaches the profiler (children, files,
 * requests), attributed to the work that asked; a Mac's keychain read is a counted child of the worker,
 * not of the main thread; the thread keeps its Codex rollout index between jobs, so a second walk of a
 * quiet home opens nothing; and a job sent before the settings is refused with the closed word.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { chmod, mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClaudeStoreResolution, CodexStoreResolution } from '@ferretry/fleet';
import should from 'should';
import { InlineHousekeepingJobs, WorkerHousekeepingJobs } from '../../../src/adapters/housekeeping/index.ts';
import { bundledWorkerUrl } from '../../../src/adapters/runtime/bundled-worker.ts';
import type {
  HousekeepingJob,
  HousekeepingResponse,
  HousekeepingSettings,
} from '../../../src/lib/housekeeping/protocol.ts';
import { PerformanceRecorder } from '../../../src/lib/performance/recorder.ts';
import { type FakeUsageServer, startFakeUsageServer } from '../support/fake-usage-server.ts';
import { runHousekeepingProcess } from '../support/housekeeping-process.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

const NOW = Date.now();
const HOUR = 3_600_000;
const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (payload: unknown): string => `${segment({ alg: 'none' })}.${segment(payload)}.sig`;
const claudeBlob = (token: string): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `${token}-r`, expiresAt: NOW + HOUR } });

interface Fleet {
  readonly root: string;
  readonly work: ClaudeStoreResolution;
  readonly empty: ClaudeStoreResolution;
  readonly codex: CodexStoreResolution;
  readonly rollouts: readonly string[];
  /** A Codex home: one rollout from before the session (its baseline), and the session's own. */
  readonly codexHome: string;
}

const CODEX_TOKEN = '/state/sessions/20261022-codex';

let server: FakeUsageServer;
let fleet: Fleet;

const claudeAt = (root: string, id: string): ClaudeStoreResolution =>
  ({
    harness: 'claude',
    store: 'ferretry',
    secureStorage: join(root, 'credentials', id),
    credentialFile: join(root, 'credentials', id, '.credentials.json'),
  }) as ClaudeStoreResolution;

async function fleetAt(root: string): Promise<Fleet> {
  const work = claudeAt(root, 'work');
  const empty = claudeAt(root, 'empty');
  await mkdir(join(root, 'credentials', 'work'), { recursive: true });
  await mkdir(join(root, 'credentials', 'empty'), { recursive: true });
  await writeFile(work.credentialFile, claudeBlob('work-TESTONLY'));
  await writeFile(
    join(root, 'credentials', 'work', 'usage.json'),
    JSON.stringify({ version: 1, source: 'claude-statusline', at: NOW, fiveHour: { usedPercent: 7 } }),
  );
  const codex: CodexStoreResolution = {
    harness: 'codex',
    store: 'ferretry',
    canonicalFile: join(root, 'credentials', 'cx', 'auth.json'),
  };
  await mkdir(join(root, 'credentials', 'cx'), { recursive: true });
  await writeFile(
    codex.canonicalFile,
    JSON.stringify({
      last_refresh: new Date(NOW).toISOString(),
      tokens: {
        access_token: jwt({ exp: (NOW + HOUR) / 1000 }),
        refresh_token: 'refresh-TESTONLY',
        account_id: 'acct',
        id_token: jwt({ email: 'team@example.com' }),
      },
    }),
  );
  const rollouts = [join(root, 'rollout-old.jsonl'), join(root, 'rollout-new.jsonl')];
  const tokenCount = (used: number) =>
    `${JSON.stringify({
      timestamp: new Date(NOW).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_in_seconds: 60 } },
      },
    })}\n`;
  await writeFile(rollouts[0] as string, tokenCount(3));
  await writeFile(rollouts[1] as string, tokenCount(21));
  // The newer rollout is newer by its stamp, not by the time it took to write: stamps are set, never waited for.
  await utimes(rollouts[0] as string, new Date(NOW - 20_000), new Date(NOW - 20_000));
  await utimes(rollouts[1] as string, new Date(NOW - 10_000), new Date(NOW - 10_000));
  const codexHome = join(root, 'codex-home');
  const day = join(codexHome, 'sessions', '2026', '10', '22');
  await mkdir(day, { recursive: true });
  const meta = (id: string) => JSON.stringify({ type: 'session_meta', payload: { id } });
  await writeFile(join(day, 'rollout-old.jsonl'), `${meta('old')}\n`);
  await writeFile(join(day, 'rollout-mine.jsonl'), `${meta('mine')}\n${JSON.stringify({ text: CODEX_TOKEN })}\n`);
  return { root, work, empty, codex, rollouts, codexHome };
}

const settingsOf = (overrides: Partial<HousekeepingSettings> = {}): HousekeepingSettings => ({
  type: 'settings',
  platform: 'linux',
  keychainAccount: 'person',
  defaultClaudeHome: join(fleet.root, 'default-claude'),
  fleetRoot: fleet.root,
  probeUrls: {
    anthropic: `${server.origin}/api/oauth/usage`,
    codex: `${server.origin}/backend-api/wham/usage`,
  },
  ...overrides,
});

/** A free read's answer, without the response's own header values (a `date` differs per request). */
const comparable = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, inner) =>
      // A Codex window's reset is computed from the instant the answer is parsed.
      key === 'headers' || key === 'bodySha256' || key === 'resetAt' ? undefined : inner,
    ),
  );

beforeAll(async () => {
  server = startFakeUsageServer(() => NOW);
  fleet = await fleetAt(await tempDirectory('fyd-housekeeping-'));
});

afterAll(async () => {
  await server.stop();
  await cleanupTempDirectories();
});

describe('the housekeeping worker', () => {
  it('should answer every job kind exactly as the same job does on the main thread', async () => {
    // Arrange
    const settings = settingsOf();
    const inline = new InlineHousekeepingJobs(settings);
    const worker = new WorkerHousekeepingJobs({
      settings,
      inline,
      probe: new PerformanceRecorder(),
      idleMs: () => 1_000,
    });
    const jobs: HousekeepingJob[] = [
      { kind: 'credential.local', resolution: fleet.work },
      { kind: 'credential.local', resolution: fleet.empty },
      { kind: 'credential.local', resolution: fleet.codex },
      { kind: 'credential.active', resolution: fleet.work },
      { kind: 'credential.active', resolution: fleet.empty },
      { kind: 'credential.active', resolution: fleet.codex },
      { kind: 'usage.passive.claude', credential: 'work' },
      { kind: 'usage.passive.claude', credential: 'empty' },
      { kind: 'usage.passive.codex', files: fleet.rollouts },
      { kind: 'usage.passive.codex', files: [join(fleet.root, 'gone.jsonl')] },
      { kind: 'codex.discover', home: fleet.codexHome, correlationToken: CODEX_TOKEN, skip: ['old'] },
      { kind: 'codex.discover', home: join(fleet.root, 'no-codex'), correlationToken: CODEX_TOKEN, skip: [] },
    ];

    // Act
    const here = await Promise.all(jobs.map(async job => comparable(await inline.run(job))));
    const there = await Promise.all(jobs.map(async job => comparable(await worker.run(job))));
    worker.close();

    // Assert
    should(there).deepEqual(here);
    should(there[0]).match({ fingerprint: /^[0-9a-f]+$/ });
    should(there[3]).match({ result: { ok: true, credentialSignal: 'accepted' } });
    should(there[5]).match({ result: { ok: true }, local: { codex: { email: 'team@example.com' } } });
    should(there[6]).match({ source: 'claude-statusline', fiveHour: { usedPercent: 7 } });
    should(there[7]).be.null();
    should(there[8]).match({ source: 'codex-rollout', fiveHour: { usedPercent: 21 } });
    should(there[10]).match({ candidates: [{ id: 'mine', correlated: true }] });
    should(there[11]).match({ candidates: [], frontier: [join(fleet.root, 'no-codex', 'sessions')] });
  });

  it('should keep its rollout index between jobs, so a second walk of a quiet home opens nothing', async () => {
    // Arrange
    const job: HousekeepingJob = {
      kind: 'codex.discover',
      home: fleet.codexHome,
      correlationToken: CODEX_TOKEN,
      skip: [],
    };

    // Act — two walks, one after the other, on one thread.
    const run = await runHousekeepingProcess({ settings: settingsOf(), jobs: [job, job] }, fleet.root);
    const opened = run.messages.flatMap(message => {
      const received = (message as { received?: { type?: string; kind?: string; fileReads?: number } }).received;
      return received?.type === 'metrics' && received.kind === 'codex.discover' ? [received.fileReads] : [];
    });

    // Assert: both walks find the same candidates, and only the first saw the home's listing as new; the
    // first identified both rollouts and read each for the token, the second found both unchanged.
    const [first, second] = run.answers as { candidates: { id: string; correlated: boolean }[]; changed: number }[];
    should(second?.candidates).deepEqual(first?.candidates);
    should(first?.candidates.map(({ id, correlated }) => [id, correlated]).sort()).deepEqual([
      ['mine', true],
      ['old', false],
    ]);
    should([first?.changed, second?.changed]).deepEqual([1, 0]);
    should(opened).deepEqual([4, 0]);
  });

  it('should report what each job cost to the profiler, by the main-thread work that asked', async () => {
    // Arrange — a Mac, whose Claude login is a `security` child: a fake one on PATH answers it.
    const bin = await tempDirectory('fyd-housekeeping-bin-');
    await writeFile(join(bin, 'security'), `#!/bin/sh\nprintf '%s' '${claudeBlob('keychain-TESTONLY')}'\n`);
    await chmod(join(bin, 'security'), 0o755);

    // Act — on the real worker, in a process whose PATH holds that `security`.
    const run = await runHousekeepingProcess(
      {
        settings: settingsOf({ platform: 'darwin' }),
        jobs: [
          { kind: 'credential.active', resolution: fleet.work },
          { kind: 'usage.passive.codex', files: fleet.rollouts },
        ],
        activity: 'fleet refresh',
      },
      bin,
    );
    const [active] = run.answers;
    const [stats] = run.tables.workers;

    // Assert
    should(active).match({ result: { ok: true }, local: { shape: { kind: 'tokens' } } });
    should(stats?.name).equal('housekeeping');
    should(stats?.work).match({
      jobs: 2,
      // The keychain answered, so its fallback file was not read; the newest rollout answered first.
      fileReads: 1,
      fetches: 1,
      childProcesses: [
        { command: 'security find-generic-password', count: 1, by: [{ activity: 'fleet refresh', count: 1 }] },
      ],
    });
    should(stats?.work?.heapMb.max).be.above(0);
  });

  it('should refuse a job that arrives before its settings, with the closed failure word', async () => {
    // Arrange
    const thread = new Worker(bundledWorkerUrl('housekeeping'), { type: 'module' });
    const answers: HousekeepingResponse[] = [];
    const settled = new Promise<void>(resolve => {
      thread.onmessage = (event: MessageEvent<HousekeepingResponse>) => {
        answers.push(event.data);
        if ('type' in event.data && event.data.type === 'result') resolve();
      };
    });

    // Act
    thread.postMessage({ type: 'job', id: 7, job: { kind: 'usage.passive.claude', credential: 'work' } });
    await settled;
    thread.terminate();

    // Assert
    should(answers).deepEqual([{ type: 'result', id: 7, ok: false, failure: 'unsettled' }]);
  });
});
