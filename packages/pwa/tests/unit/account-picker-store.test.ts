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
  state: 'healthy',
  cached: false,
  checkedAt: 1,
  ms: 1,
};
const healthy: AccountPickerHealthCatalog = { health: new Map([[healthRow.accountId, healthRow]]), error: null };

const portFor = (answers: Map<string, () => Promise<AccountPickerCatalog>>): DaemonAccountPickerPort => ({
  catalog: async daemon => {
    const answer = answers.get(daemon.daemonId);
    if (answer === undefined) throw new Error(`no catalog for ${daemon.daemonId}`);
    return await answer();
  },
  health: async () => healthy,
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
    });

    await store.hydrate(laptop);
    await store.checkHealth(laptop);
    const proved = store.sliceFor(laptop);

    expect((await store.hydrate(laptopOverRelay)).accounts[0]?.wrapper).toBe('claude-auto-laptop');
    expect(catalogCalls).toBe(1);
    expect(healthCalls).toBe(1);

    const attached = store.sliceFor(laptopOverRelay);
    expect(attached.generation).toBe(proved.generation);
    expect(attached.catalog).toBe(proved.catalog);
    expect(attached.health).toBe(proved.health);
    expect(attached).toMatchObject({ status: 'ready', error: null, healthStatus: 'ready', healthError: null });
    expect(store.sliceFor(laptop).generation).toBe(proved.generation);

    await store.refresh(laptopOverRelay);
    await store.checkHealth(laptopOverRelay);
    expect(carriers).toEqual([undefined, undefined, HOSTED_RELAY.relayUrl, HOSTED_RELAY.relayUrl]);
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
    });

    await store.checkHealth(laptopOverRelay);
    expect(store.sliceFor(laptopOverRelay).health?.get(healthRow.accountId)?.state).toBe('healthy');
    const stale = store.hydrate(laptopOverRelay);

    const moved = { ...laptopOverRelay, baseUrl: 'https://laptop-moved.example.test' };
    expect(store.sliceFor(moved)).toMatchObject({ generation: 0, catalog: null, status: 'idle', health: null });

    await store.hydrate(moved);
    release(catalog('claude-auto-stale'));
    await stale;

    expect(store.sliceFor(moved).catalog?.accounts[0]?.wrapper).toBe('claude-auto-moved');
    expect(store.sliceFor(moved).health).toBeNull();
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

  it('never probes health during hydration and coalesces an explicit partial result', async () => {
    let release!: (value: AccountPickerHealthCatalog) => void;
    const pending = new Promise<AccountPickerHealthCatalog>(resolve => {
      release = resolve;
    });
    let healthCalls = 0;
    const store = new DaemonAccountPickerStore({
      catalog: async () => catalog('claude-auto-laptop'),
      health: async () => {
        healthCalls += 1;
        return await pending;
      },
    });

    await store.hydrate(laptop);
    expect(healthCalls).toBe(0);

    const first = store.checkHealth(laptop);
    expect(store.checkHealth(laptop)).toBe(first);
    expect(store.sliceFor(laptop).healthStatus).toBe('loading');
    release({ health: healthy.health, error: 'the daemon returned ambiguous health rows' });
    await first;

    expect(healthCalls).toBe(1);
    expect(store.sliceFor(laptop)).toMatchObject({
      healthStatus: 'error',
      healthError: 'the daemon returned ambiguous health rows',
    });
    expect(store.sliceFor(laptop).health?.get(healthRow.accountId)?.state).toBe('healthy');
  });

  it('reports a health transport failure and ignores a cleared late result', async () => {
    let calls = 0;
    let release!: (value: AccountPickerHealthCatalog) => void;
    const pending = new Promise<AccountPickerHealthCatalog>(resolve => {
      release = resolve;
    });
    const store = new DaemonAccountPickerStore({
      catalog: async () => catalog('claude-auto-laptop'),
      health: async () => {
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
