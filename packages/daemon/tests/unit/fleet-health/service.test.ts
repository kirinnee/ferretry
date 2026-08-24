import { describe, it } from 'bun:test';
import {
  type FleetConfig,
  FleetConfigSchema,
  type FleetCredentialClassifier,
  type FleetManifest,
  type FleetUsageSnapshot,
  type LocalCredentialReading,
} from '@ferretry/fleet';
import should from 'should';
import type { AccountHealthHead } from '../../../src/lib/fleet-health/head.ts';
import { type AccountHealthStore, FleetAccountHealthService } from '../../../src/lib/fleet-health/service.ts';

const NOW = 1_786_000_000_000;
const ID_ONE = '00000000-0000-4000-8000-000000000001';

const account = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  kind: 'claude',
  mode: 'auto',
  wrapper: `fy-${id}`,
  home: `/tmp/${id}`,
  displayName: id,
  models: [],
  available: true,
  unavailableReason: null,
  ...patch,
});

const manifest = (accounts: readonly Record<string, unknown>[]): FleetManifest =>
  ({ version: 1, generatedAt: '2026-08-05T00:00:00.000Z', accounts }) as unknown as FleetManifest;

const config = (): FleetConfig =>
  FleetConfigSchema.parse({
    agents: [
      {
        name: 'kirin',
        kind: 'claude',
        routes: {
          default: { id: ID_ONE, wrapper: 'claude-kirin', home: 'claude-kirin', defaultModel: 'm', models: ['m'] },
        },
      },
    ],
  });

const usage = (signal: string | undefined, id = ID_ONE): FleetUsageSnapshot =>
  ({
    at: NOW,
    accounts: [
      {
        accountId: id,
        kind: 'claude',
        usageBased: true,
        ok: true,
        unavailable: false,
        atLimit: false,
        ...(signal === undefined ? {} : { credentialSignal: signal }),
      },
    ],
  }) as unknown as FleetUsageSnapshot;

/** An in-memory store that records how many times it was written. */
const memoryStore = (seed: readonly AccountHealthHead[] = []) => {
  let heads = [...seed];
  const writes: (readonly AccountHealthHead[])[] = [];
  const store: AccountHealthStore = {
    read: async () => heads,
    write: async next => {
      writes.push(next);
      heads = [...next];
    },
  };
  return { store, writes, current: () => heads };
};

const classifier = (reading: LocalCredentialReading): FleetCredentialClassifier => ({ classify: async () => reading });

const service = (parts: { store: AccountHealthStore; credentials?: FleetCredentialClassifier; now?: () => number }) =>
  new FleetAccountHealthService({
    store: parts.store,
    credentials: parts.credentials ?? classifier({ state: 'valid', fingerprint: 'aaa', expiresAt: NOW + 1 }),
    clock: { now: parts.now ?? (() => NOW) },
  });

describe('FleetAccountHealthService.snapshot', () => {
  it('reads the store and checks nothing', async () => {
    // Arrange
    const store = memoryStore();
    let classifications = 0;
    const subject = service({
      store: store.store,
      credentials: {
        classify: async () => {
          classifications += 1;
          return { state: 'valid' };
        },
      },
    });

    // Act
    const actual = await subject.snapshot(manifest([account(ID_ONE)]));

    // Assert — no classification, no write. This is what makes `GET /v1/fleet/health` safe to hydrate
    // on page load and safe to serve immediately after a restart.
    should(classifications).equal(0);
    should(store.writes).be.empty();
    should(actual.accounts[0]?.reason).equal('never_checked');
    should(actual.accounts[0]?.lastCheckedAt).be.null();
  });

  it('publishes one row per MANIFEST account, sorted, whatever the store holds', async () => {
    // Arrange — a stored head for an account that has been removed, and a new account with no head.
    const store = memoryStore([
      {
        accountId: 'removed',
        kind: 'claude',
        verdict: 'healthy',
        reason: 'provider_accepted',
        evidence: 'anthropic_usage',
        lastCheckedAt: NOW,
        verdictAt: NOW,
        lastCheckInconclusive: false,
        fingerprint: 'aaa',
      },
    ]);

    // Act
    const actual = await service({ store: store.store }).snapshot(manifest([account('bravo'), account('alpha')]));

    // Assert — the manifest decides the rows and the store decides their content. An account missing
    // from the response would render as absent rather than as unknown.
    should(actual.accounts.map(row => row.accountId)).deepEqual(['alpha', 'bravo']);
  });

  it('refuses to date a snapshot from a broken clock', async () => {
    await should(
      service({ store: memoryStore().store, now: () => Number.NaN }).snapshot(manifest([account(ID_ONE)])),
    ).be.rejectedWith(/the fleet health clock did not return a valid instant/u);
  });
});

describe('FleetAccountHealthService.observe', () => {
  it('records the verdict the caller’s free usage read established', async () => {
    // Arrange
    const store = memoryStore();

    // Act
    await service({ store: store.store }).observe({
      manifest: manifest([account(ID_ONE)]),
      config: config(),
      usage: usage('scope_unavailable'),
    });

    // Assert — a 403 is HEALTHY, and it is persisted as such.
    should(store.writes).have.length(1);
    should(store.current()[0]?.verdict).equal('healthy');
    should(store.current()[0]?.reason).equal('usage_scope_unavailable');
    should(store.current()[0]?.lastCheckedAt).equal(NOW);
  });

  it('survives a daemon restart: the snapshot serves what observe wrote', async () => {
    // Arrange
    const store = memoryStore();
    await service({ store: store.store }).observe({
      manifest: manifest([account(ID_ONE)]),
      config: config(),
      usage: usage('accepted'),
    });

    // Act — a brand new service instance over the same store is exactly what a restart is.
    const actual = await service({ store: store.store, now: () => NOW + 1_000 }).snapshot(manifest([account(ID_ONE)]));

    // Assert
    should(actual.accounts[0]?.verdict).equal('healthy');
    should(actual.accounts[0]?.lastCheckedAt).equal(NOW);
  });

  it('serializes overlapping observations so neither discards the other', async () => {
    // Arrange — the timer's pass and a person pressing the button both end by rewriting one document.
    // The store is read INSIDE the queued work, so the second fold sees what the first committed.
    const store = memoryStore();
    let reads = 0;
    const counting: AccountHealthStore = {
      read: async () => {
        reads += 1;
        return await store.store.read();
      },
      write: async heads => await store.store.write(heads),
    };
    const subject = service({ store: counting });

    // Act
    await Promise.all([
      subject.observe({ manifest: manifest([account(ID_ONE)]), config: config(), usage: usage('accepted') }),
      subject.observe({ manifest: manifest([account(ID_ONE)]), config: config(), usage: usage('rejected') }),
    ]);

    // Assert — two writes, two reads, and the later verdict is the one that stands.
    should(store.writes).have.length(2);
    should(reads).equal(2);
    should(store.current()[0]?.verdict).equal('needs_relogin');
  });

  it('propagates a failed write, so its CALLER decides whether that matters', async () => {
    // Arrange — this used to swallow the failure and answer successfully, which left the one caller
    // that has a reason to ignore it holding a `.catch()` that could never fire. Whether a failed
    // health write matters is the call site's knowledge, not this service's: see
    // `MountedFleet.usage()`, where the feed, the advisor and the warden are waiting on the snapshot.
    const failing: AccountHealthStore = {
      read: async () => [],
      write: async () => {
        throw new Error('the disk is full');
      },
    };

    // Act / Assert
    await should(
      service({ store: failing }).observe({
        manifest: manifest([account(ID_ONE)]),
        config: config(),
        usage: usage('accepted'),
      }),
    ).be.rejectedWith(/the disk is full/u);
  });

  it('does not let one failed observation poison the next', async () => {
    // Arrange — the queue absorbs the failure even though the caller sees it. `this.chain` keeps both
    // handlers while the awaited copy rejects, and getting that backwards is a one-word edit with a
    // permanent consequence: every later pass would inherit the first failure.
    const store = memoryStore();
    let writes = 0;
    const flaky: AccountHealthStore = {
      read: async () => await store.store.read(),
      write: async heads => {
        writes += 1;
        if (writes === 1) throw new Error('the disk was briefly full');
        await store.store.write(heads);
      },
    };
    const subject = service({ store: flaky });
    const input = { manifest: manifest([account(ID_ONE)]), config: config(), usage: usage('accepted') };

    // Act
    await should(subject.observe(input)).be.rejected();
    await subject.observe(input);

    // Assert — the second pass settled on the same instance.
    should(store.current()[0]?.verdict).equal('healthy');
  });

  it('keeps serving after a failed observation rather than poisoning the queue', async () => {
    // Arrange
    const store = memoryStore();
    let calls = 0;
    const flaky: AccountHealthStore = {
      read: async () => {
        calls += 1;
        if (calls === 1) throw new Error('a torn read');
        return await store.store.read();
      },
      write: async heads => await store.store.write(heads),
    };
    const subject = service({ store: flaky });

    // Act — the first pass fails at the READ (the sibling test above fails at the write), and the
    // caller sees it now that `observe` propagates.
    await should(
      subject.observe({ manifest: manifest([account(ID_ONE)]), config: config(), usage: usage('accepted') }),
    ).be.rejectedWith(/a torn read/u);
    await subject.observe({ manifest: manifest([account(ID_ONE)]), config: config(), usage: usage('accepted') });

    // Assert — the second pass works, so one failure never disables the feature until a restart.
    should(store.current()[0]?.verdict).equal('healthy');
  });

  it('drops a head for an account the manifest no longer publishes', async () => {
    // Arrange
    const store = memoryStore([
      {
        accountId: 'gone',
        kind: 'claude',
        verdict: 'healthy',
        reason: 'provider_accepted',
        evidence: 'anthropic_usage',
        lastCheckedAt: NOW,
        verdictAt: NOW,
        lastCheckInconclusive: false,
        fingerprint: 'aaa',
      },
    ]);

    // Act
    await service({ store: store.store }).observe({
      manifest: manifest([account(ID_ONE)]),
      config: config(),
      usage: usage('accepted'),
    });

    // Assert — a verdict about an account that does not exist is not a fact, and the file would grow
    // by a row for every account anybody ever removed.
    should(store.current().map(row => row.accountId)).deepEqual([ID_ONE]);
  });

  it('publishes an honest unproven verdict for a Codex account', async () => {
    // Arrange — the Anthropic probe declines Codex, so no signal reaches the row at all.
    const store = memoryStore();

    // Act
    await service({ store: store.store }).observe({
      manifest: manifest([account(ID_ONE, { kind: 'codex' })]),
      config: config(),
      usage: usage(undefined),
    });

    // Assert
    should(store.current()[0]?.verdict).equal('unknown');
    should(store.current()[0]?.reason).equal('codex_liveness_unproven');
  });
});
