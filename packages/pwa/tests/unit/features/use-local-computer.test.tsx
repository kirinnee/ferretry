/**
 * `useLocalComputer`: the daemon on this computer, as the link hand-off sees it. The store is a small
 * fake of the three things the hook reads — pairing, the measured carrier and the client factory — so
 * what is proved is the hook's own contract: offered only for a direct loopback carrier, re-read when
 * either source changes, and the port calls `openUrl` on that daemon's client.
 */
import { describe, expect, it } from 'bun:test';
import type { ConnectionChoice } from '@ferretry/relay';
import { useLocalComputer } from '../../../src/features/browser/use-local-computer.ts';
import { type DaemonConnection, daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { type AppStore, StoreProvider } from '../../../src/lib/store.tsx';
import { interact, mount } from '../../support/dom.ts';

const LOCAL = daemonConnection({
  daemonId: 'local',
  baseUrl: 'http://127.0.0.1:40245',
  deviceId: 'fy_device_id_localDevice0000000001',
});

const choiceFor = (daemonUrl: string): ConnectionChoice => ({
  ok: true,
  method: { kind: 'direct', daemonUrl },
  reason: 'carried',
  passedOver: [],
});

interface FakeWorld {
  readonly store: AppStore;
  readonly opened: string[];
  readonly setPaired: (paired: readonly DaemonConnection[]) => void;
  readonly setChoice: (daemonUrl: string | undefined) => void;
}

const fakeWorld = (paired: readonly DaemonConnection[], daemonUrl: string | undefined): FakeWorld => {
  let connections = paired;
  let url = daemonUrl;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const opened: string[] = [];
  const store = {
    connections: { list: () => connections, subscribe },
    carrier: { choice: () => (url === undefined ? undefined : choiceFor(url)), subscribe },
    clients: { client: async () => ({ openUrl: async (href: string) => void opened.push(href) }) },
  } as unknown as AppStore;
  return {
    store,
    opened,
    setPaired: next => {
      connections = next;
      for (const listener of listeners) listener();
    },
    setChoice: next => {
      url = next;
      for (const listener of listeners) listener();
    },
  };
};

const probe = (seen: { port: ReturnType<typeof useLocalComputer> }) =>
  function Probe() {
    seen.port = useLocalComputer();
    return null;
  };

const render = async (world: FakeWorld | null) => {
  const seen: { port: ReturnType<typeof useLocalComputer> } = { port: undefined };
  const Probe = probe(seen);
  const view = await mount(
    world === null ? (
      <Probe />
    ) : (
      <StoreProvider store={world.store}>
        <Probe />
      </StoreProvider>
    ),
  );
  return { seen, view };
};

describe('useLocalComputer', () => {
  it('offers nothing outside an app store', async () => {
    const { seen, view } = await render(null);
    expect(seen.port).toBeUndefined();
    await view.unmount();
  });

  it('offers a port when a paired daemon is carried directly on loopback, and calls that daemon', async () => {
    const world = fakeWorld([LOCAL], 'http://127.0.0.1:40245');
    const { seen, view } = await render(world);
    expect(seen.port).toBeDefined();
    await seen.port?.('https://docs.example.test/a');
    expect(world.opened).toEqual(['https://docs.example.test/a']);
    await view.unmount();
  });

  it('offers nothing for a remote or unmeasured carrier, and follows the carrier as it changes', async () => {
    const world = fakeWorld([LOCAL], 'https://daemon.example.test');
    const { seen, view } = await render(world);
    expect(seen.port).toBeUndefined();
    await interact(() => world.setChoice('http://localhost:40245'));
    expect(seen.port).toBeDefined();
    await interact(() => world.setChoice(undefined));
    expect(seen.port).toBeUndefined();
    await view.unmount();
  });

  it('refuses, so the caller falls back to a tab, once the local daemon is no longer paired', async () => {
    const world = fakeWorld([LOCAL], 'http://127.0.0.1:40245');
    const { seen, view } = await render(world);
    const stale = seen.port;
    world.setPaired([]);
    await expect(stale?.('https://docs.example.test/a')).rejects.toThrow('no longer paired');
    expect(world.opened).toEqual([]);
    await view.unmount();
  });
});
