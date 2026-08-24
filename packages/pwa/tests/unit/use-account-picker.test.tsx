import { describe, expect, it } from 'bun:test';
import { useAccountPickerSlice } from '../../src/hooks/use-account-picker.ts';
import type { AccountPickerCatalog, AccountPickerHealthCatalog } from '../../src/lib/account-picker-catalog.ts';
import { DaemonAccountPickerStore } from '../../src/lib/account-picker-store.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { interact, mount } from '../support/dom.ts';

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
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'claude',
      mode: 'auto',
      wrapper,
      home: `/accounts/${wrapper}`,
      displayName: wrapper,
      defaultModel: 'opus',
      models: [{ id: 'opus', available: true }],
      available: true,
      unavailableReason: null,
    },
  ],
});
const noHealth: AccountPickerHealthCatalog = { health: new Map(), error: null };

function Status({ store, daemon }: { readonly store: DaemonAccountPickerStore; readonly daemon: typeof laptop }) {
  const slice = useAccountPickerSlice(store, daemon);
  return <output>{`${slice.status}:${slice.catalog?.accounts[0]?.wrapper ?? slice.error ?? '—'}`}</output>;
}

describe('useAccountPickerSlice', () => {
  it('hydrates the selected daemon and replaces it without leaking the previous roster', async () => {
    const reads: string[] = [];
    const store = new DaemonAccountPickerStore({
      catalog: async daemon => {
        reads.push(daemon.daemonId);
        return catalog(daemon.daemonId);
      },
      health: async () => noHealth,
      checkHealth: async () => noHealth,
    });
    const mounted = await mount(<Status store={store} daemon={laptop} />);
    expect(mounted.container.textContent).toBe('ready:daemon/laptop');

    await mounted.render(<Status store={store} daemon={workstation} />);
    expect(mounted.container.textContent).toBe('ready:daemon/workstation');
    expect(reads).toEqual([laptop.daemonId, workstation.daemonId]);
    await mounted.unmount();
  });

  it('renders a failed read as state and does not retry an equivalent connection automatically', async () => {
    let reads = 0;
    const store = new DaemonAccountPickerStore({
      catalog: async () => {
        reads += 1;
        throw new Error('fleet unavailable');
      },
      health: async () => noHealth,
      checkHealth: async () => noHealth,
    });
    const mounted = await mount(<Status store={store} daemon={laptop} />);
    expect(mounted.container.textContent).toBe('error:fleet unavailable');

    await mounted.render(<Status store={store} daemon={{ ...laptop }} />);
    expect(mounted.container.textContent).toBe('error:fleet unavailable');
    expect(reads).toBe(1);
    await mounted.unmount();
  });

  it('never paints a previous roster under a re-paired connection with the same daemon id', async () => {
    let release!: (answer: AccountPickerCatalog) => void;
    const pending = new Promise<AccountPickerCatalog>(resolve => {
      release = resolve;
    });
    let reads = 0;
    const store = new DaemonAccountPickerStore({
      catalog: async () => {
        reads += 1;
        return reads === 1 ? catalog('first pairing') : await pending;
      },
      health: async () => noHealth,
      checkHealth: async () => noHealth,
    });
    const mounted = await mount(<Status store={store} daemon={laptop} />);
    expect(mounted.container.textContent).toBe('ready:first pairing');

    const rotated = { ...laptop, deviceToken: 'rotated-token' };
    await mounted.render(<Status store={store} daemon={rotated} />);
    expect(reads).toBe(2);
    expect(mounted.container.textContent).toBe('loading:—');

    await interact(async () => {
      release(catalog('replacement pairing'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mounted.container.textContent).toBe('ready:replacement pairing');
    await mounted.unmount();
  });

  it('reuses a settled roster when a parent rebuilds an equivalent connection object', async () => {
    let reads = 0;
    const store = new DaemonAccountPickerStore({
      catalog: async () => {
        reads += 1;
        return catalog('stable pairing');
      },
      health: async () => noHealth,
      checkHealth: async () => noHealth,
    });
    const mounted = await mount(<Status store={store} daemon={laptop} />);
    await mounted.render(<Status store={store} daemon={{ ...laptop }} />);

    expect(mounted.container.textContent).toBe('ready:stable pairing');
    expect(reads).toBe(1);
    await mounted.unmount();
  });
});
