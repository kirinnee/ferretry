import { describe, expect, it } from 'bun:test';
import type {
  AccountPickerCatalog,
  AccountPickerHealthCatalog,
  PickerAccountHealth,
} from '../../../app/lib/account-picker-catalog.ts';
import { AccountPickerStore, type AccountPickerPort } from '../../../app/lib/account-picker-store.ts';
import { healthMap, pickerAccount, pickerHealth } from './support/picker.ts';

const catalog = (wrapper: string): AccountPickerCatalog => ({
  accounts: [pickerAccount({ wrapper, defaultModel: 'model', models: [{ id: 'model', available: true }] })],
});

const healthRow: PickerAccountHealth = pickerHealth('login-claude-auto-a');
const healthy: AccountPickerHealthCatalog = { health: healthMap(healthRow), error: null };

const port = (overrides: Partial<AccountPickerPort> = {}): AccountPickerPort => ({
  catalog: async () => catalog('claude-auto-a'),
  health: async () => healthy,
  checkHealth: async () => healthy,
  ...overrides,
});

describe('AccountPickerStore', () => {
  it('starts unread, and hydrates the roster with the stored health beside it', async () => {
    const store = new AccountPickerStore(port());
    expect(store.getSnapshot()).toMatchObject({
      catalog: null,
      status: 'idle',
      error: null,
      health: null,
      healthStatus: 'idle',
      healthError: null,
    });

    await store.hydrate();
    await Promise.resolve();

    expect(store.getSnapshot().catalog?.accounts[0]?.wrapper).toBe('claude-auto-a');
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', healthStatus: 'ready' });
    expect(store.getSnapshot().health?.get('login-claude-auto-a')?.word).toBe('ready');
  });

  it('coalesces an in-flight read, reads once when settled, and refreshes only deliberately', async () => {
    let release!: () => void;
    let calls = 0;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const store = new AccountPickerStore(
      port({
        catalog: async () => {
          calls += 1;
          if (calls === 1) {
            await gate;
            return catalog('claude-auto-a');
          }
          throw new Error('pair expired');
        },
      }),
    );

    const first = store.hydrate();
    expect(store.hydrate()).toBe(first);
    expect(store.refresh()).toBe(first);
    release();
    await first;

    expect((await store.hydrate()).accounts[0]?.wrapper).toBe('claude-auto-a');
    expect(calls).toBe(1);

    await expect(store.refresh()).rejects.toThrow('pair expired');
    expect(calls).toBe(2);
    expect(store.getSnapshot()).toMatchObject({ status: 'error', error: 'pair expired' });
    // A failed read never replaces a proved catalog with an empty one.
    expect(store.getSnapshot().catalog?.accounts[0]?.wrapper).toBe('claude-auto-a');
  });

  it('caches a failed automatic read until an explicit refresh succeeds', async () => {
    let calls = 0;
    const store = new AccountPickerStore(
      port({
        catalog: async () => {
          calls += 1;
          if (calls === 1) throw new Error('manifest damaged');
          return catalog('claude-auto-recovered');
        },
      }),
    );

    await expect(store.hydrate()).rejects.toThrow('manifest damaged');
    await expect(store.hydrate()).rejects.toThrow('manifest damaged');
    expect(calls).toBe(1);

    await store.refresh();
    expect(store.getSnapshot().catalog?.accounts[0]?.wrapper).toBe('claude-auto-recovered');
  });

  it('never makes a health failure the roster’s', async () => {
    const store = new AccountPickerStore(
      port({
        health: async () => {
          throw new Error('logins unavailable');
        },
      }),
    );

    const roster = await store.hydrate();
    await Promise.resolve();
    await Promise.resolve();

    expect(roster.accounts).toHaveLength(1);
    expect(store.getSnapshot()).toMatchObject({
      status: 'ready',
      error: null,
      healthStatus: 'error',
      healthError: 'logins unavailable',
      health: null,
    });
  });

  it('reads health once per store, and checks it only on a deliberate call that shares the slot', async () => {
    let reads = 0;
    let checks = 0;
    const store = new AccountPickerStore(
      port({
        health: async () => {
          reads += 1;
          return healthy;
        },
        checkHealth: async () => {
          checks += 1;
          return { health: healthMap(pickerHealth('login-claude-auto-a', 'needs_sign_in')), error: null };
        },
      }),
    );

    await store.hydrate();
    await store.hydrate();
    await Promise.resolve();
    expect(reads).toBe(1);
    expect(checks).toBe(0);

    const first = store.checkHealth();
    expect(store.checkHealth()).toBe(first);
    await first;
    expect(checks).toBe(1);
    expect(store.getSnapshot().health?.get('login-claude-auto-a')?.word).toBe('needs_sign_in');
  });

  it('shows a partial check’s error beside the rows it did read', async () => {
    const store = new AccountPickerStore(
      port({ checkHealth: async () => ({ health: healthMap(healthRow), error: 'one login locked' }) }),
    );
    await store.checkHealth();
    expect(store.getSnapshot()).toMatchObject({ healthStatus: 'error', healthError: 'one login locked' });
    expect(store.getSnapshot().health?.size).toBe(1);
  });

  it('reread keeps the rows on screen until the new answers land, and joins a read in flight', async () => {
    let roster = 'claude-auto-before';
    let reads = 0;
    const store = new AccountPickerStore(
      port({
        catalog: async () => {
          reads += 1;
          return catalog(roster);
        },
      }),
    );
    await store.hydrate();
    roster = 'codex-auto-added';
    store.reread();
    store.reread();
    expect(store.getSnapshot().catalog?.accounts[0]?.wrapper).toBe('claude-auto-before');
    await store.refresh();
    expect(store.getSnapshot().catalog?.accounts[0]?.wrapper).toBe('codex-auto-added');
    expect(reads).toBe(2);
  });

  it('notifies subscribers on every change and stops after unsubscribe', async () => {
    const store = new AccountPickerStore(port());
    let notified = 0;
    const stop = store.subscribe(() => {
      notified += 1;
    });
    await store.hydrate();
    expect(notified).toBeGreaterThan(0);
    stop();
    const seen = notified;
    await store.refresh();
    expect(notified).toBe(seen);
  });
});
