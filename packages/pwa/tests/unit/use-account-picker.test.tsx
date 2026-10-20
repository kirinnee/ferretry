import { describe, expect, it } from 'bun:test';
import { useAccountPickerSlice, useMachineRosters } from '../../src/hooks/use-account-picker.ts';
import type { AccountPickerCatalog, AccountPickerHealthCatalog } from '../../src/lib/account-picker-catalog.ts';
import { DaemonAccountPickerStore } from '../../src/lib/account-picker-store.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { interact, mount } from '../support/dom.ts';
import { configChangeHarness } from './config-change-support.tsx';

const laptop = daemonConnection({
  daemonId: 'daemon/laptop',
  baseUrl: 'https://laptop.example.test',
  deviceId: 'token-laptop',
});
const workstation = daemonConnection({
  daemonId: 'daemon/workstation',
  baseUrl: 'https://workstation.example.test',
  deviceId: 'token-workstation',
});

const catalog = (wrapper: string): AccountPickerCatalog => ({
  accounts: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'claude',
      agent: true,
      credentialId: `login-${wrapper}`,
      wrapper,
      displayName: wrapper,
      defaultModel: 'opus',
      models: [{ id: 'opus', available: true }],
      available: true,
      unavailableReason: null,
    },
  ],
});
const noHealth: AccountPickerHealthCatalog = { health: new Map(), error: null };

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
};

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

    const rotated = { ...laptop, deviceId: 'rotated-token' };
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
  it('shows a runtime added on another device without a reload, and ignores unrelated changes', async () => {
    // Arrange — the roster was read once on mount
    let roster = 'claude-auto-before';
    let reads = 0;
    const store = new DaemonAccountPickerStore({
      catalog: async () => {
        reads += 1;
        return catalog(roster);
      },
      health: async () => noHealth,
      checkHealth: async () => noHealth,
    });
    const harness = configChangeHarness(laptop.daemonId);
    const mounted = await mount(harness.wrap(<Status store={store} daemon={laptop} />));
    expect(mounted.container.textContent).toBe('ready:claude-auto-before');
    expect(reads).toBe(1);

    // Act + Assert — a change to something the picker does not show reads nothing
    await harness.move(['profiles']);
    await settle();
    expect(reads).toBe(1);

    // Act — `fy` adds a runtime on the machine
    roster = 'codex-auto-added';
    await harness.move(['runtimes']);
    await settle();

    // Assert
    expect(mounted.container.textContent).toBe('ready:codex-auto-added');
    expect(reads).toBe(2);

    // Act — a login moved, which changes each runtime's health
    await harness.move(['credentials']);
    await settle();
    expect(reads).toBe(3);
    await mounted.unmount();
  });
});

describe('useMachineRosters', () => {
  function Rosters({
    store,
    machines,
  }: {
    readonly store: DaemonAccountPickerStore;
    readonly machines: (typeof laptop)[];
  }) {
    const rosters = useMachineRosters(store, machines);
    return <output>{machines.map(machine => rosters.get(machine.daemonId)?.[0]?.wrapper ?? '—').join(' ')}</output>;
  }

  it('reads every listed machine’s roster through its own pairing and keeps each under its own id', async () => {
    const reads: string[] = [];
    const store = new DaemonAccountPickerStore({
      catalog: async daemon => {
        reads.push(daemon.daemonId);
        if (daemon.daemonId === workstation.daemonId) throw new Error('no roster here');
        return catalog(daemon.daemonId);
      },
      health: async () => noHealth,
      checkHealth: async () => noHealth,
    });
    const mounted = await mount(<Rosters machines={[laptop, workstation]} store={store} />);
    await settle();
    // The workstation's roster is unread, so its rows name no account — never the laptop's.
    expect(mounted.container.textContent).toBe('daemon/laptop —');
    expect([...reads].sort()).toEqual([laptop.daemonId, workstation.daemonId].sort());
    await mounted.unmount();
  });
});
