/**
 * THE FLEET READING OVER A REAL FILE SYSTEM (docs/design/housekeeping-worker.md §4 PR 3).
 *
 * The real file-event hub, real credential files in a temporary fleet root, and the real job code on this
 * thread. What the design promises a running fleet: a statusLine `usage.json` renamed into place — every few
 * seconds per Claude login with a session running — is one passive job and NOTHING else; a rewritten login is
 * re-read within a second; a rollout appended to is one Codex passive job; and while nothing changes,
 * deciding every credential's view reads nothing and stats nothing.
 */
import { afterAll, afterEach, beforeEach, describe, it } from 'bun:test';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClaudeStoreResolution, CodexStoreResolution } from '@ferretry/fleet';
import { credentialFileStamp, FilePassiveUsageStore } from '@ferretry/fleet/adapters';
import should from 'should';
import { unrefFileEventTimers } from '../../../src/adapters/file-events/bun-file-event-source.ts';
import { platformFileEventSource } from '../../../src/adapters/file-events/platform.ts';
import { InlineHousekeepingJobs, WorkerCredentialPorts } from '../../../src/adapters/housekeeping/index.ts';
import { FileEventHub } from '../../../src/lib/file-events/hub.ts';
import { FleetReading } from '../../../src/lib/fleet-reading/service.ts';
import type { HousekeepingJob } from '../../../src/lib/housekeeping/protocol.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

const HOUR = 3_600_000;
const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (payload: unknown): string => `${segment({ alg: 'none' })}.${segment(payload)}.sig`;
const claudeBlob = (token: string): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `${token}-r`, expiresAt: Date.now() + HOUR } });
const tokenCount = (used: number): string =>
  `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { type: 'token_count', rate_limits: { primary: { used_percent: used, window_minutes: 300 } } },
  })}\n`;

interface Rig {
  readonly root: string;
  readonly work: ClaudeStoreResolution;
  readonly cx: CodexStoreResolution;
  readonly rollout: string;
  readonly reading: FleetReading;
  readonly ports: WorkerCredentialPorts;
  readonly jobs: HousekeepingJob[];
  readonly stats: string[];
  readonly hub: FileEventHub;
}

let rig: Rig;

/** Waits until `done` holds, or fails after `ms`. */
async function until(done: () => boolean | Promise<boolean>, ms = 2_000): Promise<number> {
  const started = Date.now();
  while (!(await done())) {
    if (Date.now() - started > ms) throw new Error(`not within ${String(ms)} ms`);
    await Bun.sleep(10);
  }
  return Date.now() - started;
}

/** `fy statusline`'s write: a temporary file in the same directory, then a rename over the real name. */
async function statusLine(root: string, usedPercent: number): Promise<void> {
  const target = new FilePassiveUsageStore(root).path('work');
  const temporary = `${target}.${String(Math.random()).slice(2)}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({ version: 1, source: 'claude-statusline', at: Date.now(), fiveHour: { usedPercent } }),
  );
  await rename(temporary, target);
}

beforeEach(async () => {
  const root = await tempDirectory('fyd-fleet-reading-');
  const work = {
    harness: 'claude',
    store: 'ferretry',
    secureStorage: join(root, 'credentials', 'work'),
    credentialFile: join(root, 'credentials', 'work', '.credentials.json'),
  } as ClaudeStoreResolution;
  const cx: CodexStoreResolution = {
    harness: 'codex',
    store: 'ferretry',
    canonicalFile: join(root, 'credentials', 'cx', 'auth.json'),
  };
  await mkdir(join(root, 'credentials', 'work'), { recursive: true });
  await mkdir(join(root, 'credentials', 'cx'), { recursive: true });
  await writeFile(work.credentialFile, claudeBlob('work-TESTONLY'));
  await writeFile(
    cx.canonicalFile,
    JSON.stringify({
      last_refresh: new Date().toISOString(),
      tokens: { access_token: jwt({ exp: (Date.now() + HOUR) / 1000 }), refresh_token: 'r-TESTONLY', account_id: 'a' },
    }),
  );
  const rollout = join(root, 'rollout-2026-10-22T09-00-00-cx.jsonl');
  await writeFile(rollout, tokenCount(3));
  const hub = new FileEventHub(platformFileEventSource(), unrefFileEventTimers);
  const inline = new InlineHousekeepingJobs({
    type: 'settings',
    platform: 'linux',
    keychainAccount: 'person',
    defaultClaudeHome: join(root, 'default-claude'),
    fleetRoot: root,
  });
  const jobs: HousekeepingJob[] = [];
  const counted = {
    run: async <J extends HousekeepingJob>(job: J) => {
      jobs.push(job);
      return await inline.run(job);
    },
  };
  const stats: string[] = [];
  let ports: WorkerCredentialPorts | undefined;
  const reading = new FleetReading({
    credentials: async () => [
      { id: 'work', resolution: work, usedBy: ['work-runtime'] },
      { id: 'cx', resolution: cx, usedBy: ['codex-runtime'] },
    ],
    sessions: async () => [{ agent: 'codex-runtime', transcript: { home: root, file: rollout } }],
    jobs: counted,
    watch: (path, listener) => hub.subscribe(path, () => listener()),
    passiveFile: id => new FilePassiveUsageStore(root).path(id),
    refreshLocal: async resolution => {
      await ports?.local(resolution);
    },
    stamp: async path => {
      stats.push(path);
      return await credentialFileStamp(path);
    },
    now: () => Date.now(),
    intervalMs: () => 60_000,
    timers: { setTimeout: () => undefined, clearTimeout: () => undefined },
  });
  ports = new WorkerCredentialPorts({
    jobs: counted,
    stamp: async path => await reading.stamp(path),
    keychain: false,
    keychainFreshMs: () => 60_000,
    now: () => Date.now(),
    cache: new Map(),
  });
  await reading.start(() => undefined);
  rig = { root, work, cx, rollout, reading, ports, jobs, stats, hub };
  // The first reads: each passive file once, and the stores' facts once.
  await until(() => jobs.filter(job => job.kind.startsWith('usage.passive')).length >= 2);
  await ports.local(work);
  await ports.local(cx);
  // A directory's first check reports every file in it once; let that pass before measuring.
  await statusLine(root, 1);
  await until(() => jobs.filter(job => job.kind === 'usage.passive.claude').length >= 2);
  await Bun.sleep(100);
  jobs.length = 0;
  stats.length = 0;
});

afterEach(() => {
  rig.reading.close();
  rig.hub.close();
});

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('the fleet reading on a real file system', () => {
  it('should read nothing and stat nothing to decide every view while nothing changes', async () => {
    // Act — what a credentials list and a usage pass ask of each credential, many times over.
    for (let ask = 0; ask < 20; ask += 1) {
      await rig.reading.passiveUsage({ id: 'work', resolution: rig.work });
      await rig.reading.passiveUsage({ id: 'cx', resolution: rig.cx });
      await rig.ports.local(rig.work);
      await rig.ports.local(rig.cx);
    }
    await Bun.sleep(200);

    // Assert
    should(rig.jobs).deepEqual([]);
    should(rig.stats).deepEqual([]);
  });

  it('should answer a statusLine rename with one passive job and nothing else', async () => {
    // Act — a running session's statusLine, written three times in quick succession.
    await statusLine(rig.root, 20);
    await statusLine(rig.root, 21);
    await statusLine(rig.root, 22);
    await until(
      async () => (await rig.reading.passiveUsage({ id: 'work', resolution: rig.work }))?.fiveHour?.usedPercent === 22,
    );
    const seen = await rig.reading.passiveUsage({ id: 'work', resolution: rig.work });

    // Assert — only passive reads of that one file; no store read, no free read, and nothing is due.
    should(rig.jobs.length).be.within(1, 3);
    should(rig.jobs.every(job => job.kind === 'usage.passive.claude')).be.true();
    should(seen?.fiveHour?.usedPercent).equal(22);
    should(rig.reading.due()).deepEqual([]);
  });

  it('should re-read a rewritten login within a second, and answer it from then on without a read', async () => {
    // Arrange
    const before = await rig.ports.local(rig.work);

    // Act
    await writeFile(rig.work.credentialFile, claudeBlob('rotated-TESTONLY'));
    const tookMs = await until(() => rig.jobs.some(job => job.kind === 'credential.local'), 1_000);
    await Bun.sleep(50);
    const reads = rig.jobs.length;
    const after = await rig.ports.local(rig.work);

    // Assert
    should(tookMs).be.below(1_000);
    should(after.fingerprint).not.equal(before.fingerprint);
    should(rig.jobs.length).equal(reads);
  });

  it('should answer a rollout appended to with one Codex passive job', async () => {
    // Act
    await appendFile(rig.rollout, tokenCount(44));
    await until(
      async () => (await rig.reading.passiveUsage({ id: 'cx', resolution: rig.cx }))?.fiveHour?.usedPercent === 44,
    );

    // Assert
    should(rig.jobs.map(job => job.kind)).deepEqual(['usage.passive.codex']);
  });
});
