import { describe, expect, it } from 'bun:test';
import type { SessionView } from '../../../contract/index.ts';
import { machineIsOlder, useMachineIsOlder } from '../../../app/hooks/use-machine-dates-turns.ts';
import { type DaemonConnection, daemonConnection, daemonId } from '../../../app/lib/daemon-connection.ts';
import { type DaemonFleetPort, DaemonFleetStore } from '../../../app/lib/fleet-store.ts';
import type { AppStore } from '@ferretry/app';
import { render, runAsync } from '@ferretry/app/testing';
import { sessionView } from '@ferretry/app/testing';

/** Is the connected computer too old to auto-read? Only a machine with live ferrets that carry no turn is. */

const alpha = daemonId('alpha');
const connection: DaemonConnection = daemonConnection({
  daemonId: alpha,
  baseUrl: 'https://alpha.example.test',
  deviceId: 'token-alpha',
});

const turnless = sessionView('old1');
const dated = sessionView('new1', { state: { turnState: 'working', turnStateAt: '2026-01-01T00:00:00.000Z' } });
const finished = sessionView('done1', { state: { status: 'completed' } });

describe('machineIsOlder', () => {
  it('is older only when it has live ferrets and none of them carries a turn', () => {
    expect(machineIsOlder([turnless])).toBe(true);
    expect(machineIsOlder([turnless, finished])).toBe(true);
    expect(machineIsOlder([turnless, dated])).toBe(false);
    expect(machineIsOlder([dated])).toBe(false);
  });

  it('proves nothing from a machine with no ferrets, only finished ones, or nothing read yet', () => {
    expect(machineIsOlder([])).toBe(false);
    expect(machineIsOlder([finished])).toBe(false);
    expect(machineIsOlder(null)).toBe(false);
  });
});

const port = (sessions: readonly SessionView[]): DaemonFleetPort => ({
  list: () => Promise.resolve(sessions),
  get: () => Promise.reject(new Error('unused')),
});

const Probe = ({
  store,
  daemon,
  on,
}: {
  store: AppStore | null;
  daemon?: DaemonConnection;
  on: (v: boolean) => void;
}) => {
  on(useMachineIsOlder(store, daemon));
  return null;
};

const mountHook = async (store: AppStore | null, daemon: DaemonConnection | undefined) => {
  let latest: boolean | undefined;
  let renderer: ReturnType<typeof render> | undefined;
  await runAsync(async () => {
    renderer = render(<Probe daemon={daemon} on={v => (latest = v)} store={store} />);
  });
  return Object.assign(() => latest, {
    unmount: () => runAsync(async () => renderer?.unmount()),
  });
};

describe('useMachineIsOlder', () => {
  it('follows the machine’s fleet as it is read', async () => {
    const fleet = new DaemonFleetStore(port([turnless]));
    const latest = await mountHook({ fleet } as unknown as AppStore, connection);
    expect(latest()).toBe(false);
    await runAsync(async () => {
      await fleet.hydrate(connection);
    });
    expect(latest()).toBe(true);
  });

  it('says false for a machine whose ferrets carry a turn', async () => {
    const fleet = new DaemonFleetStore(port([dated]));
    const latest = await mountHook({ fleet } as unknown as AppStore, connection);
    await runAsync(async () => {
      await fleet.hydrate(connection);
    });
    expect(latest()).toBe(false);
  });

  it('says false without a store or without a machine', async () => {
    const without = await mountHook(null, connection);
    expect(without()).toBe(false);
    await without.unmount();
    const fleet = new DaemonFleetStore(port([turnless]));
    expect((await mountHook({ fleet } as unknown as AppStore, undefined))()).toBe(false);
  });
});
