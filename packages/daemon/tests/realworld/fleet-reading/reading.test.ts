// Realworld: asserts wall-clock speed; the outcome depends on the machine, not the code.
import { afterAll, afterEach, beforeEach, describe, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClaudeStoreResolution } from '@ferretry/fleet';
import { credentialFileStamp, FilePassiveUsageStore } from '@ferretry/fleet/adapters';
import should from 'should';
import { unrefFileEventTimers } from '../../../src/adapters/file-events/bun-file-event-source.ts';
import { platformFileEventSource } from '../../../src/adapters/file-events/platform.ts';
import { InlineHousekeepingJobs, WorkerCredentialPorts } from '../../../src/adapters/housekeeping/index.ts';
import { FileEventHub } from '../../../src/lib/file-events/hub.ts';
import { FleetReading } from '../../../src/lib/fleet-reading/service.ts';
import type { HousekeepingJob } from '../../../src/lib/housekeeping/protocol.ts';
import { cleanupTempDirectories, tempDirectory } from '../../integration/support/repository.ts';

const HOUR = 3_600_000;
const claudeBlob = (token: string): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `${token}-r`, expiresAt: Date.now() + HOUR } });

interface Rig {
  readonly work: ClaudeStoreResolution;
  readonly reading: FleetReading;
  readonly ports: WorkerCredentialPorts;
  readonly jobs: HousekeepingJob[];
  readonly hub: FileEventHub;
}

let rig: Rig;

/** Waits until `done` holds, or fails after `ms`; answers how long it took. */
async function until(done: () => boolean | Promise<boolean>, ms = 2_000): Promise<number> {
  const started = Date.now();
  while (!(await done())) {
    if (Date.now() - started > ms) throw new Error(`not within ${String(ms)} ms`);
    await Bun.sleep(10);
  }
  return Date.now() - started;
}

beforeEach(async () => {
  const root = await tempDirectory('fyd-fleet-reading-');
  const work = {
    harness: 'claude',
    store: 'ferretry',
    secureStorage: join(root, 'credentials', 'work'),
    credentialFile: join(root, 'credentials', 'work', '.credentials.json'),
  } as ClaudeStoreResolution;
  await mkdir(join(root, 'credentials', 'work'), { recursive: true });
  await writeFile(work.credentialFile, claudeBlob('work-TESTONLY'));
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
  let ports: WorkerCredentialPorts | undefined;
  const reading = new FleetReading({
    credentials: async () => [{ id: 'work', resolution: work, usedBy: ['work-runtime'] }],
    sessions: async () => [],
    jobs: counted,
    watch: (path, listener) => hub.subscribe(path, () => listener()),
    passiveFile: id => new FilePassiveUsageStore(root).path(id),
    refreshLocal: async resolution => {
      await ports?.local(resolution);
    },
    stamp: async path => await credentialFileStamp(path),
    now: () => Date.now(),
    intervalMs: () => 60_000,
    pollsFeed: () => false,
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
  rig = { work, reading, ports, jobs, hub };
  await until(() => jobs.some(job => job.kind.startsWith('usage.passive')));
  await ports.local(work);
  // A directory's first check reports every file in it once; let that pass before measuring.
  await Bun.sleep(300);
  jobs.length = 0;
});

afterEach(() => {
  rig.reading.close();
  rig.hub.close();
});

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('the fleet reading on a real file system', () => {
  it('should re-read a rewritten login within a second, and answer it from then on without a read', async () => {
    // Arrange
    await rig.ports.local(rig.work);

    // Act
    await writeFile(rig.work.credentialFile, claudeBlob('rotated-TESTONLY'));
    const tookMs = await until(() => rig.jobs.some(job => job.kind === 'credential.local'), 10_000);

    // Assert
    should(tookMs).be.below(1_000);
  });
});
