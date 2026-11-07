import { describe, expect, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { useAccountPickerSlice } from '../../../app/hooks/use-account-picker.ts';
import type { AccountPickerCatalog, AccountPickerHealthCatalog } from '../../../app/lib/account-picker-catalog.ts';
import { AccountPickerStore } from '../../../app/lib/account-picker-store.ts';
import { interact, mount } from '../support/dom.ts';
import { pickerAccount } from './support/picker.ts';

const catalog = (wrapper: string): AccountPickerCatalog => ({
  accounts: [pickerAccount({ wrapper, defaultModel: 'opus', models: [{ id: 'opus', available: true }] })],
});
const noHealth: AccountPickerHealthCatalog = { health: new Map(), error: null };

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
};

type Change = { runtimes: string[] };

/** A client that only carries events: a test fires `runtimes.changed` the way the daemon would. */
const events = () => {
  const named = new Map<string, Set<(payload: unknown) => void>>();
  return {
    client: {
      subscribe: (event: { name: string }, listener: (payload: unknown) => void) => {
        const set = named.get(event.name) ?? new Set();
        set.add(listener);
        named.set(event.name, set);
        return () => set.delete(listener);
      },
    } as unknown as Pick<PluginClient, 'subscribe'>,
    emit: (name: string, payload: unknown) =>
      interact(
        async () =>
          void [...(named.get(name) ?? [])].forEach(listener => {
            listener(payload);
          }),
      ),
    changed: (runtimes: string[]) => {
      const payload: Change & { profiles: string[]; modelSets: string[] } = { runtimes, profiles: [], modelSets: [] };
      return interact(
        async () =>
          void [...(named.get('runtimes.changed') ?? [])].forEach(listener => {
            listener(payload);
          }),
      );
    },
  };
};

function Status({
  store,
  client,
}: {
  readonly store: AccountPickerStore;
  readonly client: Pick<PluginClient, 'subscribe'>;
}) {
  const slice = useAccountPickerSlice(store, client);
  return <output>{`${slice.status}:${slice.catalog?.accounts[0]?.wrapper ?? slice.error ?? '—'}`}</output>;
}

describe('useAccountPickerSlice', () => {
  it('hydrates the roster on mount', async () => {
    const store = new AccountPickerStore({
      catalog: async () => catalog('claude-auto-a'),
      health: async () => noHealth,
      checkHealth: async () => noHealth,
    });
    const mounted = await mount(<Status store={store} client={events().client} />);
    await settle();
    expect(mounted.container.textContent).toBe('ready:claude-auto-a');
    await mounted.unmount();
  });

  it('renders a failed read as state and does not retry it automatically', async () => {
    let reads = 0;
    const store = new AccountPickerStore({
      catalog: async () => {
        reads += 1;
        throw new Error('runtimes unavailable');
      },
      health: async () => noHealth,
      checkHealth: async () => noHealth,
    });
    const bus = events();
    const mounted = await mount(<Status store={store} client={bus.client} />);
    await settle();
    expect(mounted.container.textContent).toBe('error:runtimes unavailable');
    await mounted.render(<Status store={store} client={bus.client} />);
    expect(reads).toBe(1);
    await mounted.unmount();
  });

  it('shows a runtime added on another device without a reload, and ignores unrelated changes', async () => {
    // Arrange — the roster was read once on mount
    let roster = 'claude-auto-before';
    let reads = 0;
    const store = new AccountPickerStore({
      catalog: async () => {
        reads += 1;
        return catalog(roster);
      },
      health: async () => noHealth,
      checkHealth: async () => noHealth,
    });
    const bus = events();
    const mounted = await mount(<Status store={store} client={bus.client} />);
    await settle();
    expect(mounted.container.textContent).toBe('ready:claude-auto-before');
    expect(reads).toBe(1);

    // Act + Assert — a change to something the picker does not show (a profile names no runtime) reads nothing
    await bus.changed([]);
    await settle();
    expect(reads).toBe(1);

    // Act — `fy` adds a runtime on the machine
    roster = 'codex-auto-added';
    await bus.changed(['codex-auto-added']);
    await settle();
    expect(mounted.container.textContent).toBe('ready:codex-auto-added');
    expect(reads).toBe(2);

    // The default moving is a roster change too.
    roster = 'codex-auto-default';
    await bus.emit('runtimes.default-changed', { defaultRuntime: 'codex-auto-default' });
    await settle();
    expect(mounted.container.textContent).toBe('ready:codex-auto-default');

    // A sign-in changing re-reads the roster too: the picker's health rows come from it.
    roster = 'codex-auto-signed-in';
    await bus.emit('logins.changed', { loginId: 'codex' });
    await settle();
    expect(mounted.container.textContent).toBe('ready:codex-auto-signed-in');
    await mounted.unmount();
  });
});
