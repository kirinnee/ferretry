import { describe, expect, it } from 'bun:test';

import type {
  AccountPickerCatalog,
  AccountPickerHealthCatalog,
  PickerAccountHealth,
} from '../../src/lib/account-picker-catalog.ts';
import { type DaemonAccountPickerPort, DaemonAccountPickerStore } from '../../src/lib/account-picker-store.ts';
import { daemonConnection, type RelayCarrier } from '../../src/lib/daemon-connection.ts';

const laptop = daemonConnection({
  daemonId: 'daemon/laptop',
  baseUrl: 'https://laptop.example.test',
  deviceToken: 'token-laptop',
});
const workstation = daemonConnection({
  daemonId: 'daemon/workstation',
  baseUrl: 'https://workstation.example.test',
  deviceToken: 'token-workstation',
});
const HOSTED_RELAY: RelayCarrier = { kind: 'relay', relayUrl: 'https://relay.example.test', operator: 'hosted' };
const laptopOverRelay = daemonConnection({
  daemonId: 'daemon/laptop',
  baseUrl: 'https://laptop.example.test',
  deviceToken: 'token-laptop',
  carriers: [{ kind: 'direct', daemonUrl: 'https://laptop.example.test' }, HOSTED_RELAY],
});

const catalog = (wrapper: string): AccountPickerCatalog => ({
  accounts: [
    {
      id: wrapper.startsWith('claude')
        ? '11111111-1111-4111-8111-111111111111'
        : '22222222-2222-4222-8222-222222222222',
      kind: wrapper.startsWith('claude') ? 'claude' : 'codex',
      mode: 'auto',
      wrapper,
      home: `/accounts/${wrapper}`,
      displayName: wrapper,
      defaultModel: 'model',
      models: [{ id: 'model', available: true }],
      available: true,
      unavailableReason: null,
    },
  ],
});

const healthRow: PickerAccountHealth = {
  accountId: '11111111-1111-4111-8111-111111111111',
  kind: 'claude',
  verdict: 'healthy',
  reason: 'provider_accepted',
  evidence: 'anthropic_usage',
  lastCheckedAt: 1,
  verdictAt: 1,
  lastCheckInconclusive: false,
};
const healthy: AccountPickerHealthCatalog = { health: new Map([[healthRow.accountId, healthRow]]), error: null };

const portFor = (answers: Map<string, () => Promise<AccountPickerCatalog>>): DaemonAccountPickerPort => ({
  catalog: async daemon => {
    const answer = answers.get(daemon.daemonId);
    if (answer === undefined) throw new Error(`no catalog for ${daemon.daemonId}`);
    return await answer();
  },
  health: async () => healthy,
  checkHealth: async () => healthy,
});

describe('DaemonAccountPickerStore', () => {
  it('starts unread and hydrates each daemon into a separate generation', async () => {
    const store = new DaemonAccountPickerStore(
      portFor(
        new Map([
          [laptop.daemonId, async () => catalog('claude-auto-laptop')],
          [workstation.daemonId, async () => catalog('codex-auto-workstation')],
        ]),
      ),
    );

    expect(store.slice(laptop.daemonId)).toMatchObject({
      generation: 0,
      catalog: null,
      status: 'idle',
      error: null,
      health: null,
      healthStatus: 'idle',
      healthError: null,
    });
    await store.hydrate(laptop);
    await store.hydrate(workstation);

    expect(store.sliceFor(laptop).catalog?.accounts[0]?.wrapper).toBe('claude-auto-laptop');
    expect(store.sliceFor(workstation).catalog?.accounts[0]?.wrapper).toBe('codex-auto-workstation');
    expect(store.sliceFor(laptop).generation).not.toBe(store.sliceFor(workstation).generation);
  });

  it('coalesces an in-flight read, reads once when settled, and refreshes only deliberately', async () => {
    let release!: () => void;
    let calls = 0;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const store = new DaemonAccountPickerStore({
      catalog: async () => {
        calls += 1;
        if (calls === 1) {
          await gate;
          return catalog('claude-auto-laptop');
        }
        throw new Error('pair expired');
      },
      health: async () => healthy,
      checkHealth: async () => healthy,
    });

    const first = store.hydrate(laptop);
    expect(store.hydrate(laptop)).toBe(first);
    expect(store.refresh(laptop)).toBe(first);
    release();
    await first;

    expect((await store.hydrate({ ...laptop })).accounts[0]?.wrapper).toBe('claude-auto-laptop');
    expect(calls).toBe(1);

    await expect(store.refresh(laptop)).rejects.toThrow('pair expired');
    expect(calls).toBe(2);
    expect(store.sliceFor(laptop)).toMatchObject({ status: 'error', error: 'pair expired' });
    expect(store.sliceFor(laptop).catalog?.accounts[0]?.wrapper).toBe('claude-auto-laptop');
  });

  it('caches a failed automatic read until an explicit refresh succeeds', async () => {
    let calls = 0;
    const store = new DaemonAccountPickerStore({
      catalog: async () => {
        calls += 1;
        if (calls === 1) throw new Error('manifest damaged');
        return catalog('claude-auto-recovered');
      },
      health: async () => healthy,
      checkHealth: async () => healthy,
    });

    await expect(store.hydrate(laptop)).rejects.toThrow('manifest damaged');
    await expect(store.hydrate({ ...laptop })).rejects.toThrow('manifest damaged');
    expect(calls).toBe(1);

    await store.refresh(laptop);
    expect(calls).toBe(2);
    expect(store.sliceFor(laptop)).toMatchObject({ status: 'ready', error: null });
  });

  it('returns a pure unread slice for a re-pair and ignores the old response', async () => {
    let release!: (value: AccountPickerCatalog) => void;
    const staleRead = new Promise<AccountPickerCatalog>(resolve => {
      release = resolve;
    });
    let calls = 0;
    const store = new DaemonAccountPickerStore({
      catalog: async () => {
        calls += 1;
        return calls === 1 ? await staleRead : catalog('claude-auto-rotated');
      },
      health: async () => healthy,
      checkHealth: async () => healthy,
    });

    const stale = store.hydrate(laptop);
    const rotated = { ...laptop, deviceToken: 'rotated-token' };
    expect(store.sliceFor(rotated)).toMatchObject({ generation: 0, catalog: null, status: 'idle' });
    expect(store.getSnapshot()).toBe(store.getSnapshot());

    await store.hydrate(rotated);
    release(catalog('claude-auto-stale'));
    await stale;

    expect(store.sliceFor(rotated).catalog?.accounts[0]?.wrapper).toBe('claude-auto-rotated');
  });

  it('treats a late hosted relay as the same authority and keeps every proved row', async () => {
    let catalogCalls = 0;
    let healthCalls = 0;
    const carriers: (string | undefined)[] = [];
    const store = new DaemonAccountPickerStore({
      catalog: async daemon => {
        catalogCalls += 1;
        carriers.push(daemon.carriers.find(carrier => carrier.kind === 'relay')?.relayUrl);
        return catalog('claude-auto-laptop');
      },
      health: async daemon => {
        healthCalls += 1;
        carriers.push(daemon.carriers.find(carrier => carrier.kind === 'relay')?.relayUrl);
        return healthy;
      },
      checkHealth: async daemon => {
        healthCalls += 1;
        carriers.push(daemon.carriers.find(carrier => carrier.kind === 'relay')?.relayUrl);
        return healthy;
      },
    });

    // Hydration reads the roster AND the stored health snapshot, so one mount is one of each.
    await store.hydrate(laptop);
    await store.checkHealth(laptop);
    const proved = store.sliceFor(laptop);

    expect((await store.hydrate(laptopOverRelay)).accounts[0]?.wrapper).toBe('claude-auto-laptop');
    // Re-hydrating the same authority reads NEITHER again: the roster is cached and health has its own
    // once-per-generation latch, so a republished carrier set cannot make a browser re-fetch anything.
    expect(catalogCalls).toBe(1);
    expect(healthCalls).toBe(2);

    const attached = store.sliceFor(laptopOverRelay);
    expect(attached.generation).toBe(proved.generation);
    expect(attached.catalog).toBe(proved.catalog);
    expect(attached.health).toBe(proved.health);
    expect(attached).toMatchObject({ status: 'ready', error: null, healthStatus: 'ready', healthError: null });
    expect(store.sliceFor(laptop).generation).toBe(proved.generation);

    await store.refresh(laptopOverRelay);
    await store.checkHealth(laptopOverRelay);
    // The first three reads went over the direct carrier and the last two over the republished relay:
    // adopting a new carrier does not unprove a cache, and later reads use the newest address.
    expect(carriers.slice(0, 3)).toEqual([undefined, undefined, undefined]);
    expect(carriers.slice(3)).toEqual([HOSTED_RELAY.relayUrl, HOSTED_RELAY.relayUrl]);
  });

  it('still fences a moved base URL when only the relay carrier stayed put', async () => {
    let release!: (value: AccountPickerCatalog) => void;
    const staleRead = new Promise<AccountPickerCatalog>(resolve => {
      release = resolve;
    });
    let calls = 0;
    const store = new DaemonAccountPickerStore({
      catalog: async () => {
        calls += 1;
        return calls === 1 ? await staleRead : catalog('claude-auto-moved');
      },
      health: async () => healthy,
      checkHealth: async () => healthy,
    });

    await store.checkHealth(laptopOverRelay);
    expect(store.sliceFor(laptopOverRelay).health?.get(healthRow.accountId)?.verdict).toBe('healthy');
    const stale = store.hydrate(laptopOverRelay);

    // A MOVED base URL is a re-pair, so it reads as unread: no generation, no roster, and — the point
    // — no inherited health. A verdict proved against one daemon address is not evidence about
    // another, whatever carrier set they happen to share.
    const moved = { ...laptopOverRelay, baseUrl: 'https://laptop-moved.example.test' };
    expect(store.sliceFor(moved)).toMatchObject({ generation: 0, catalog: null, status: 'idle', health: null });

    await store.hydrate(moved);
    release(catalog('claude-auto-stale'));
    await stale;

    expect(store.sliceFor(moved).catalog?.accounts[0]?.wrapper).toBe('claude-auto-moved');
    // And the previous authority is fenced back to unread rather than keeping what it proved.
    expect(store.sliceFor(laptopOverRelay)).toMatchObject({ generation: 0, catalog: null, status: 'idle' });
  });

  it('clears only one daemon and fences its late completion', async () => {
    let release!: (value: AccountPickerCatalog) => void;
    const pending = new Promise<AccountPickerCatalog>(resolve => {
      release = resolve;
    });
    const store = new DaemonAccountPickerStore(
      portFor(
        new Map([
          [laptop.daemonId, async () => await pending],
          [workstation.daemonId, async () => catalog('codex-auto-workstation')],
        ]),
      ),
    );

    const late = store.hydrate(laptop);
    await store.hydrate(workstation);
    expect(store.clearDaemon(laptop.daemonId)).toBeTrue();
    expect(store.clearDaemon(laptop.daemonId)).toBeFalse();
    release(catalog('claude-auto-too-late'));
    await late;

    expect(store.slice(laptop.daemonId).catalog).toBeNull();
    expect(store.sliceFor(workstation).catalog?.accounts).toHaveLength(1);
  });

  /**
   * HYDRATION READS THE SNAPSHOT AND NEVER COLLECTS.
   *
   * This block used to assert that hydration made NO health call at all, and that was right: health
   * meant starting every account's agent and asking a model to answer a sentinel, so a mount that
   * fetched it would have spent real money on a machine the reader is not sitting at.
   *
   * The probe is deleted. `health` is now a stored-snapshot GET the daemon answers from its own file,
   * so hydrating it is one local HTTP call — and the property worth keeping is no longer "health is
   * not fetched" but "a mount must not COLLECT". So: hydration calls `health` exactly once and
   * `checkHealth` never, and only a deliberate press reaches the collecting call.
   *
   * WHAT THIS CANNOT PROVE: it observes port calls only. It cannot see a process spawn, so it is not
   * the guard against a spend regression. That is
   * `packages/daemon/tests/integration/runtime/boot-lifecycle.test.ts`, the journey named "what an
   * unattended fleet pass may spend", which boots a real `fyd` and watches for a wrapper launch.
   */
  it('hydrates the stored snapshot, never the collecting check, and coalesces a partial result', async () => {
    let release!: (value: AccountPickerHealthCatalog) => void;
    const pending = new Promise<AccountPickerHealthCatalog>(resolve => {
      release = resolve;
    });
    let snapshotReads = 0;
    let collections = 0;
    const store = new DaemonAccountPickerStore({
      catalog: async () => catalog('claude-auto-laptop'),
      health: async () => {
        snapshotReads += 1;
        return await pending;
      },
      checkHealth: async () => {
        collections += 1;
        return await pending;
      },
    });

    // Act — a mount.
    const hydrated = store.hydrate(laptop);
    expect(snapshotReads).toBe(1);
    expect(collections).toBe(0);
    // The in-flight snapshot read is shared, so a press during hydration joins it rather than
    // starting a second request.
    const first = store.checkHealth(laptop);
    expect(store.checkHealth(laptop)).toBe(first);
    expect(store.sliceFor(laptop).healthStatus).toBe('loading');
    release({ health: healthy.health, error: 'the daemon returned ambiguous health rows' });
    await Promise.all([hydrated, first]);

    // Assert — one snapshot read, and STILL no collection: nothing here pressed the button after the
    // read had settled.
    expect(snapshotReads).toBe(1);
    expect(collections).toBe(0);
    expect(store.sliceFor(laptop)).toMatchObject({
      healthStatus: 'error',
      healthError: 'the daemon returned ambiguous health rows',
    });
    expect(store.sliceFor(laptop).health?.get(healthRow.accountId)?.verdict).toBe('healthy');
  });

  it('reaches the collecting check only from an explicit press, once hydration has settled', async () => {
    // Arrange
    let snapshotReads = 0;
    let collections = 0;
    const store = new DaemonAccountPickerStore({
      catalog: async () => catalog('claude-auto-laptop'),
      health: async () => {
        snapshotReads += 1;
        return healthy;
      },
      checkHealth: async () => {
        collections += 1;
        return healthy;
      },
    });

    // Act
    await store.hydrate(laptop);
    await store.checkHealth(laptop);

    // Assert — the two are different calls on different verbs, and the store cannot reach the second
    // one on its own. A single method with a flag would have put that distinction in an argument.
    expect(snapshotReads).toBe(1);
    expect(collections).toBe(1);
  });

  it('does not let a failed health read break the roster', async () => {
    // Arrange — a daemon that can list accounts and cannot serve verdicts still has accounts, so the
    // picker must still fill its text box. Awaiting health inside hydration would make an unrelated
    // failure look like an empty fleet.
    const store = new DaemonAccountPickerStore({
      catalog: async () => catalog('claude-auto-laptop'),
      health: async () => {
        throw new Error('the health document is unreadable');
      },
      checkHealth: async () => healthy,
    });

    // Act
    const roster = await store.hydrate(laptop);

    // Assert
    expect(roster.accounts[0]?.wrapper).toBe('claude-auto-laptop');
    expect(store.sliceFor(laptop).status).toBe('ready');
    expect(store.sliceFor(laptop).healthStatus).toBe('error');
    expect(store.sliceFor(laptop).health).toBeNull();
  });

  it('reports a health transport failure and ignores a cleared late result', async () => {
    let calls = 0;
    let release!: (value: AccountPickerHealthCatalog) => void;
    const pending = new Promise<AccountPickerHealthCatalog>(resolve => {
      release = resolve;
    });
    const store = new DaemonAccountPickerStore({
      catalog: async () => catalog('claude-auto-laptop'),
      health: async () => healthy,
      checkHealth: async () => {
        calls += 1;
        if (calls === 1) throw 'probe transport refused';
        return await pending;
      },
    });

    await expect(store.checkHealth(laptop)).rejects.toBe('probe transport refused');
    expect(store.sliceFor(laptop)).toMatchObject({ healthStatus: 'error', healthError: 'probe transport refused' });

    const late = store.checkHealth(laptop);
    store.clearDaemon(laptop.daemonId);
    release(healthy);
    await late;
    expect(store.slice(laptop.daemonId).health).toBeNull();
  });

  it('publishes immutable snapshot replacements only while subscribed', async () => {
    const store = new DaemonAccountPickerStore({
      catalog: async () => catalog('claude-auto-laptop'),
      health: async () => healthy,
      checkHealth: async () => healthy,
    });
    let publications = 0;
    const unsubscribe = store.subscribe(() => {
      publications += 1;
    });
    const before = store.getSnapshot();
    await store.hydrate(laptop);
    expect(store.getSnapshot()).not.toBe(before);
    expect(publications).toBeGreaterThan(0);

    unsubscribe();
    const published = publications;
    await store.checkHealth(laptop);
    expect(publications).toBe(published);
  });
});
