/**
 * The unattended pass must not teach the usage feed that a login is "not known".
 *
 * One pass runs the feed's refresh (`accounts()` → the credentials list → `view()`) and the
 * credentials' observation (`observeAll()` → `observe()`, which holds each credential's flight while its
 * free read is out) at the SAME time. A `view()` that lands inside that flight says `checking`, the feed
 * turns `checking` into `ok: false` with no availability, and the feed CACHES that row for the whole
 * interval — so the pass itself made a working login read as unknown until the next one.
 *
 * These tests compose the real pieces (`CredentialStatusService`, `FleetCredentialsService`,
 * `CredentialUsageSource`, `FleetRefreshService`) over fake ports. Only the feed's cache is reduced to
 * "the rows the last refresh produced", which is what `CachedUsageFeed` serves until the interval ends.
 */
import { describe, it } from 'bun:test';
import {
  type AccountModel,
  buildFleetManifest,
  type CredentialStatusPorts,
  CredentialStatusService,
  type FleetManifest,
  type FleetUsageProbeResult,
  InMemoryCredentialStatusStore,
  type LocalCredentialFacts,
} from '@ferretry/fleet';
import type { AccountUsage } from '@ferretry/protocol';
import should from 'should';
import {
  createFleetCredentialsSubsystem,
  FleetCredentialCatalog,
  type FleetCredentialsService,
} from '../../../src/lib/fleet/credentials-service.ts';
import { FleetRefreshService } from '../../../src/lib/fleet-refresh/index.ts';
import { CredentialUsageSource } from '../../../src/lib/usage/credential-usage.ts';
import type { UsageFeedPort } from '../../../src/lib/usage/types.ts';

const PATHS = { fleetRoot: '/fy/fleet', userHome: '/home/person', hostCodexHome: '/home/person/.codex' } as const;
const NOW = Date.parse('2026-10-22T08:00:00.000Z');

const model = {
  version: 2,
  credentials: { work: { harness: 'claude', store: 'ferretry' } },
  runtimes: { 'claude-writer': { credential: 'work' } },
} as unknown as AccountModel;

const manifest: FleetManifest = buildFleetManifest({
  generatedAt: '2026-10-22T07:00:00.000Z',
  accounts: [],
  runtimes: [
    {
      id: '4c0f3b6e-7a91-4a2f-9a7f-2b1d0f5c8e31',
      name: 'claude-writer',
      harness: 'claude',
      credential: 'work',
      profile: 'default',
      agent: true,
      wrapper: '/fy/fleet/bin/claude-writer',
      models: [{ id: 'sonnet', available: true }],
      defaultModel: 'sonnet',
    },
  ],
});

const ACCEPTED: FleetUsageProbeResult = {
  usageBased: true,
  ok: true,
  credentialSignal: 'accepted',
  shortWindow: { usedPercent: 12 },
  longWindow: { usedPercent: 30 },
};

/** A Claude login that is valid locally: its kept facts, and what every read of the store answers. */
const VALID: LocalCredentialFacts = {
  shape: { kind: 'tokens', hasAccess: true, hasRefresh: true, expiresAt: NOW + 3_600_000 },
  fingerprint: 'digest-a',
};

/** The ports of a Claude login that is valid locally and has no passive reading, so every pass reads. */
const portsOf = (answer: () => Promise<FleetUsageProbeResult>): CredentialStatusPorts => ({
  local: async () => VALID,
  passiveUsage: async () => undefined,
  activeUsage: async () => ({ result: await answer(), local: VALID }),
  refresh: { refresh: async () => ({ outcome: 'skipped' }) } as unknown as CredentialStatusPorts['refresh'],
  heads: new InMemoryCredentialStatusStore(),
  now: () => NOW,
  usageIntervalMs: 60_000,
});

const credentialsOf = (status: CredentialStatusService): FleetCredentialsService =>
  createFleetCredentialsSubsystem({
    catalog: new FleetCredentialCatalog({
      document: async () => model,
      paths: PATHS,
      inspect: async () => ({ reading: { state: 'valid' }, checked: [] }),
      ensureDirectory: async () => undefined,
    }),
    status,
    email: async () => undefined,
    machineName: () => 'studio',
    locate: () => undefined,
    run: async () => 0,
    baseEnvironment: () => ({}),
  });

/** A feed whose cache is the rows its last refresh produced, as `CachedUsageFeed` serves them. */
class RecordingFeed implements UsageFeedPort {
  cached: readonly AccountUsage[] = [];

  constructor(private readonly refresh: () => Promise<readonly AccountUsage[] | undefined>) {}

  async accounts(): Promise<readonly AccountUsage[]> {
    this.cached = (await this.refresh()) ?? this.cached;
    return this.cached;
  }

  snapshotAt(): number | undefined {
    return undefined;
  }

  hasSnapshot(): boolean {
    return this.cached.length > 0;
  }
}

describe('the unattended fleet pass and the usage feed it refreshes', () => {
  it('should not cache a login as unknown because the same pass was reading it', async () => {
    // Arrange — the free read stays out until the feed has finished its refresh, which is exactly the
    // overlap one pass produces: the feed lists the credential while observe() holds its flight.
    const feedRead = Promise.withResolvers<void>();
    const status = new CredentialStatusService(
      portsOf(async () => {
        await feedRead.promise;
        return ACCEPTED;
      }),
    );
    const credentials = credentialsOf(status);
    const source = new CredentialUsageSource({
      enabled: async () => true,
      manifest: async () => manifest,
      credentials: async () => await credentials.list({ settled: true }),
    });
    const feed = new RecordingFeed(async () => {
      // The flight is held from the moment observe() starts its read; wait until it is.
      while (!status.busy('work')) await Promise.resolve();
      const rows = await source.read();
      feedRead.resolve();
      return rows;
    });
    const subject = new FleetRefreshService({ usage: feed, credentials });

    // Act
    await subject.run();

    // Assert — the cached row speaks for the login: known, signed in, available.
    const actual = feed.cached.find(row => row.agent === 'claude-writer');
    should(actual).containDeep({ agent: 'claude-writer', ok: true, authOk: true, availability: 'available' });
  });

  it('should still say Checking to a person looking while the pass reads that login', async () => {
    // Arrange — the Settings list is not a cache: while a read is out, Checking is the truth.
    const release = Promise.withResolvers<FleetUsageProbeResult>();
    const status = new CredentialStatusService(portsOf(async () => await release.promise));
    const credentials = credentialsOf(status);
    const observing = credentials.observeAll();
    while (!status.busy('work')) await Promise.resolve();

    // Act
    const actual = await credentials.list();
    release.resolve(ACCEPTED);
    await observing;

    // Assert
    should(actual.credentials.map(view => view.status.word)).deepEqual(['checking']);
  });

  it('should report the last known word, not Checking, to a settled list taken during a person’s Check now', async () => {
    // Arrange — the first pass concludes the login works; a Check now is then in flight.
    let answer: () => Promise<FleetUsageProbeResult> = async () => ACCEPTED;
    const status = new CredentialStatusService(portsOf(async () => await answer()));
    const credentials = credentialsOf(status);
    await credentials.observeAll();
    const release = Promise.withResolvers<FleetUsageProbeResult>();
    answer = async () => await release.promise;
    const checking = credentials.check('work', { governed: false } as Parameters<FleetCredentialsService['check']>[1]);
    while (!status.busy('work')) await Promise.resolve();

    // Act
    const actual = await credentials.list({ settled: true });
    release.resolve(ACCEPTED);
    await checking;

    // Assert
    should(actual.credentials.map(view => [view.status.word, view.status.reason])).deepEqual([
      ['ready', 'provider_accepted'],
    ]);
  });
});
