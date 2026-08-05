import { describe, expect, it } from 'bun:test';

import type { AccountPickerCatalog } from '../../src/components/picker-catalog.ts';
import { type DaemonAccountPickerPort, DaemonAccountPickerStore } from '../../src/lib/account-picker-store.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';

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
  accountsError: null,
  usage: new Map(),
  usageError: null,
  health: new Map(),
  healthError: null,
});

const portFor = (answers: Map<string, () => Promise<AccountPickerCatalog>>): DaemonAccountPickerPort => ({
  catalog: async daemon => {
    const answer = answers.get(daemon.daemonId);
    if (answer === undefined) throw new Error(`no catalog for ${daemon.daemonId}`);
    return await answer();
  },
});

describe('DaemonAccountPickerStore', () => {
  it('starts unread and hydrates each daemon into a separate slice', async () => {
    const store = new DaemonAccountPickerStore(
      portFor(
        new Map([
          [laptop.daemonId, async () => catalog('claude-auto-laptop')],
          [workstation.daemonId, async () => catalog('codex-auto-workstation')],
        ]),
      ),
    );

    expect(store.slice(laptop.daemonId)).toEqual({ catalog: null, status: 'idle', error: null });
    await store.hydrate(laptop);
    await store.hydrate(workstation);
    expect(store.slice(laptop.daemonId).catalog?.accounts?.[0]?.wrapper).toBe('claude-auto-laptop');
    expect(store.slice(workstation.daemonId).catalog?.accounts?.[0]?.wrapper).toBe('codex-auto-workstation');
  });

  it('coalesces one connection and keeps the last proved catalog on a transport failure', async () => {
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
    });

    const first = store.hydrate(laptop);
    expect(store.hydrate(laptop)).toBe(first);
    release();
    await first;
    expect(calls).toBe(1);

    await expect(store.hydrate(laptop)).rejects.toThrow('pair expired');
    expect(store.slice(laptop.daemonId)).toMatchObject({ status: 'error', error: 'pair expired' });
    expect(store.slice(laptop.daemonId).catalog?.accounts?.[0]?.wrapper).toBe('claude-auto-laptop');
  });

  it('resets on re-pair and ignores the old connection response', async () => {
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
    });

    const stale = store.hydrate(laptop);
    await store.hydrate({ ...laptop, deviceToken: 'rotated-token' });
    release(catalog('claude-auto-stale'));
    await stale;

    expect(store.slice(laptop.daemonId).catalog?.accounts?.[0]?.wrapper).toBe('claude-auto-rotated');
  });

  it('drops the previous pairing synchronously before a replacement hydrate begins', async () => {
    const store = new DaemonAccountPickerStore({ catalog: async () => catalog('claude-auto-laptop') });
    await store.hydrate(laptop);

    const rotated = { ...laptop, deviceToken: 'rotated-token' };
    expect(store.sliceFor(rotated)).toEqual({ catalog: null, status: 'idle', error: null });
    expect(store.slice(laptop.daemonId).catalog).toBeNull();
  });

  it('clears only the requested daemon', async () => {
    const store = new DaemonAccountPickerStore(
      portFor(
        new Map([
          [laptop.daemonId, async () => catalog('claude-auto-laptop')],
          [workstation.daemonId, async () => catalog('codex-auto-workstation')],
        ]),
      ),
    );
    await store.hydrate(laptop);
    await store.hydrate(workstation);

    expect(store.clearDaemon(laptop.daemonId)).toBeTrue();
    expect(store.slice(laptop.daemonId).catalog).toBeNull();
    expect(store.slice(workstation.daemonId).catalog?.accounts).toHaveLength(1);
  });
});
