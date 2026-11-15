/**
 * How Connections' app half wires the tunnel switch, the clients the router asks through and the WebRTC dialer
 * (`app/index.ts`): the background view hands the router its client for as long as a machine is paired and checks a
 * tunnel a refresh omitted with the machine itself (R635, R636), the Connection panel polls a WebRTC round trip only
 * while it is drawn (R686), and a new network drops the peer-to-peer paths (R685).
 */
import { describe, expect, test } from 'bun:test';
import type { ConnectPorts, PairedDaemon } from '@ferretry/app';
import { noteClientDaemon, render, run, runAsync } from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { createElement } from 'react';
import { buildConnect, buildConnectionsApp, carrierWriteBackView } from '../../../app/index.ts';
import { CarrierPreferenceStore } from '../../../app/lib/carrier-preference.ts';
import type { ConnectionSignal } from '../../../app/lib/connection-signals.ts';
import type { ConnectionChoice } from '../../../app/lib/connection.ts';
import type { WebRtcDialer } from '../../../app/lib/webrtc-carrier.ts';
import { CarriersChanged, TUNNEL_OFF_SENTENCE, type TunnelStatusView } from '../../../contract/index.ts';
import { TUNNEL_SWITCHED_OFF } from '../../../app/lib/tunnel-service.ts';
import manifest from '../../../manifest.ts';

const DAEMON = `fy_daemon_${'A'.repeat(43)}`;
const ADDRESS = 'https://studio.example';
const DIRECT = { kind: 'direct', url: ADDRESS } as const;
const TUNNEL = { kind: 'tunnel', url: 'https://k3x9.tunnels.example.com' } as const;
const OFF: TunnelStatusView = {
  enabled: false,
  explicit: false,
  state: 'off',
  tunnelUrl: null,
  sentence: TUNNEL_OFF_SENTENCE,
};
const UP: TunnelStatusView = {
  enabled: true,
  explicit: true,
  state: 'up',
  tunnelUrl: TUNNEL.url,
  sentence: `Tunnel: on — ${TUNNEL.url}`,
};

/** A client that answers each route from a table, and counts the calls. */
function fakeClient(answers: Record<string, unknown>) {
  const calls: string[] = [];
  const client = {
    call: async (route: string) => {
      calls.push(route);
      const answer = answers[route];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    subscribe: (event: { readonly name: string }, _listener: () => void) =>
      event.name === CarriersChanged.name ? () => undefined : () => undefined,
  } as unknown as PluginClient;
  noteClientDaemon(client, DAEMON);
  return { client, calls };
}

/** The shell's stored list for one paired daemon, as far as Connections touches it. */
function storedList(carriers: readonly unknown[]) {
  let record: PairedDaemon = {
    daemon: DAEMON,
    machine: 'studio',
    deviceId: 'fy_device_x',
    address: ADDRESS,
    carriers: [...carriers],
    pairedAt: 1,
    lastSelectedAt: 1,
  };
  return {
    get: (daemon: string) => (daemon === DAEMON ? record : undefined),
    setCarriers: (_daemon: string, set: readonly unknown[]) => {
      record = { ...record, carriers: [...set] };
    },
    carriers: () => record.carriers,
  };
}

function connectWith(
  list: ReturnType<typeof storedList>,
  webrtc?: WebRtcDialer,
  preferences?: Parameters<typeof buildConnect>[1],
) {
  const listeners: Array<(signal: ConnectionSignal) => void> = [];
  const caches: Array<{ clearDaemon(daemonId: string): void }> = [];
  const timers: Array<{ readonly delayMs: number; readonly run: () => void }> = [];
  const ports = {
    openSocket: () => {
      throw new Error('nothing dials here');
    },
    after: (delayMs: number, run: () => void) => void timers.push({ delayMs, run }),
    now: () => 0,
    daemons: {
      registerCache: (cache: { clearDaemon(daemonId: string): void }) => {
        caches.push(cache);
        return () => undefined;
      },
      get: list.get,
      setCarriers: list.setCarriers,
    },
  } as unknown as ConnectPorts;
  const connect = buildConnect(
    ports,
    preferences,
    {
      listen: listener => {
        listeners.push(listener);
        return () => undefined;
      },
    },
    webrtc,
  );
  return {
    connect,
    timers,
    caches,
    signal: (signal: ConnectionSignal) => {
      for (const listener of listeners) listener(signal);
    },
  };
}

const OUTAGE = { failures: [], daemonAbsent: true, relaysNeverOpened: false } as const;

const settle = () => runAsync(async () => void (await new Promise(resolve => setTimeout(resolve, 5))));

describe('the background view and the clients the router asks through', () => {
  test('R636 the router is handed this machine’s client for as long as the view is mounted', async () => {
    const list = storedList([DIRECT]);
    const { connect } = connectWith(list);
    const fake = fakeClient({ 'GET /v1/carriers': { carriers: [DIRECT] } });
    const View = carrierWriteBackView(
      () => connect.carrierSets,
      () => connect,
    );

    expect(connect.introducers.request(DAEMON)).toBeUndefined();
    const mounted = render(createElement(View, { daemon: DAEMON, client: fake.client }));
    await settle();
    expect(connect.introducers.request(DAEMON)).toBeDefined();
    run(() => mounted.unmount());

    expect(connect.introducers.request(DAEMON)).toBeUndefined();
  });

  test('R635 a refresh that names no tunnel while one is kept asks the machine, which forgets a tunnel that is off', async () => {
    const list = storedList([DIRECT, TUNNEL]);
    const { connect } = connectWith(list);
    const fake = fakeClient({ 'GET /v1/carriers': { carriers: [DIRECT] }, 'GET /v1/tunnel': OFF });
    const View = carrierWriteBackView(
      () => connect.carrierSets,
      () => connect,
    );

    render(createElement(View, { daemon: DAEMON, client: fake.client }));
    await settle();

    // The refresh kept the tunnel (omission withdraws nothing); the machine's own word then said it is off.
    expect(fake.calls).toEqual(['GET /v1/carriers', 'GET /v1/tunnel']);
    expect(list.carriers()).toEqual([DIRECT]);
  });

  test('R635 a machine that says its tunnel is up keeps it, and one that is only reconnecting forgets nothing', async () => {
    const up = storedList([DIRECT, TUNNEL]);
    const upFake = fakeClient({ 'GET /v1/carriers': { carriers: [DIRECT] }, 'GET /v1/tunnel': UP });
    const upConnect = connectWith(up).connect;
    render(
      createElement(
        carrierWriteBackView(
          () => upConnect.carrierSets,
          () => upConnect,
        ),
        { daemon: DAEMON, client: upFake.client },
      ),
    );
    await settle();
    expect(up.carriers()).toEqual([DIRECT, TUNNEL]);

    const coming = storedList([DIRECT, TUNNEL]);
    const comingFake = fakeClient({
      'GET /v1/carriers': { carriers: [DIRECT] },
      'GET /v1/tunnel': { ...UP, state: 'connecting' },
    });
    const comingConnect = connectWith(coming).connect;
    render(
      createElement(
        carrierWriteBackView(
          () => comingConnect.carrierSets,
          () => comingConnect,
        ),
        {
          daemon: DAEMON,
          client: comingFake.client,
        },
      ),
    );
    await settle();
    expect(coming.carriers()).toEqual([DIRECT, TUNNEL]);
  });

  test('R635 a refresh that names a tunnel, or finds none kept, asks the machine nothing', async () => {
    const named = storedList([DIRECT]);
    const namedFake = fakeClient({ 'GET /v1/carriers': { carriers: [DIRECT, TUNNEL] } });
    const namedConnect = connectWith(named).connect;
    render(
      createElement(
        carrierWriteBackView(
          () => namedConnect.carrierSets,
          () => namedConnect,
        ),
        { daemon: DAEMON, client: namedFake.client },
      ),
    );
    await settle();
    expect(namedFake.calls).toEqual(['GET /v1/carriers']);

    const none = storedList([DIRECT]);
    const noneFake = fakeClient({ 'GET /v1/carriers': { carriers: [DIRECT] } });
    const noneConnect = connectWith(none).connect;
    render(
      createElement(
        carrierWriteBackView(
          () => noneConnect.carrierSets,
          () => noneConnect,
        ),
        { daemon: DAEMON, client: noneFake.client },
      ),
    );
    await settle();
    expect(noneFake.calls).toEqual(['GET /v1/carriers']);
  });

  test('R635 the tunnel switch asks through the router’s clients, and says so when none holds the machine', async () => {
    const list = storedList([DIRECT]);
    const { connect } = connectWith(list);
    const fake = fakeClient({ 'GET /v1/tunnel': UP });

    // No client yet: the read keeps whatever was known (nothing).
    expect(await connect.tunnelSwitch.refresh({ daemonId: DAEMON })).toEqual({ kind: 'unknown' });
    connect.introducers.attach(DAEMON, fake.client);
    expect(await connect.tunnelSwitch.refresh({ daemonId: DAEMON })).toEqual({ kind: 'known', view: UP });
    // The daemon saying the tunnel is up at a hostname is kept in the stored set.
    expect(list.carriers()).toEqual([DIRECT, TUNNEL]);
  });

  test('R636 a "Tunnel only" walk names a switched-off tunnel when the machine said so, and the service when it said nothing', async () => {
    const tunnelOnly = new CarrierPreferenceStore({
      getItem: () => JSON.stringify({ [DAEMON]: 'tunnel' }),
      setItem: () => undefined,
    });
    const walkFailure = async (
      connect: ReturnType<typeof connectWith>['connect'],
      list: ReturnType<typeof storedList>,
    ) =>
      await new Promise<string>(resolve => {
        const daemon = list.get(DAEMON) as PairedDaemon;
        connect.router.dial(daemon)({
          onBinary: () => undefined,
          onText: () => undefined,
          onClose: (_code, reason) => resolve(reason),
        });
      });

    // The machine answered "off": the sentence is the switch's, whatever the service would have said.
    const offList = storedList([DIRECT]);
    const off = connectWith(offList, undefined, tunnelOnly).connect;
    off.introducers.attach(DAEMON, fakeClient({ 'GET /v1/tunnel': OFF }).client);
    await off.tunnelSwitch.refresh({ daemonId: DAEMON });
    expect(await walkFailure(off, offList)).toContain(TUNNEL_SWITCHED_OFF);

    // Nothing is known about the machine's switch, and no directory is reachable: the service's own absence is said.
    const quietList = storedList([DIRECT]);
    const quiet = connectWith(quietList, undefined, tunnelOnly).connect;
    const reason = await walkFailure(quiet, quietList);
    expect(reason).toContain('Tunnel only — ');
    expect(reason).not.toContain(TUNNEL_SWITCHED_OFF);
  });
});

describe('the new network and the Connection panel', () => {
  const dialer = (rtt: number | undefined) => {
    const log = { networkChanges: 0, asked: 0 };
    const stand = {
      dial: async () => {
        throw new Error('not dialled here');
      },
      release: () => undefined,
      networkChanged: () => {
        log.networkChanges += 1;
      },
      rttMs: async () => {
        log.asked += 1;
        return rtt;
      },
    } as unknown as WebRtcDialer;
    return { stand, log };
  };

  test('R685 coming back online or on a new network drops every peer-to-peer path; coming to the foreground does not', () => {
    const { stand, log } = dialer(undefined);
    const wired = connectWith(storedList([DIRECT]), stand);

    wired.signal('visible');
    expect(log.networkChanges).toBe(0);
    wired.signal('online');
    wired.signal('network-change');
    expect(log.networkChanges).toBe(2);
  });

  test('R686 the panel asks the peer connection for its round trip only while a WebRTC choice is drawn', async () => {
    const { stand, log } = dialer(31);
    const webrtc: ConnectionChoice = {
      ok: true,
      method: { kind: 'webrtc' },
      reason: 'Connected over WebRTC.',
      passedOver: [],
    };
    const relay: ConnectionChoice = {
      ok: true,
      method: { kind: 'relay', relayUrl: 'https://relay.example' },
      reason: 'Connected via relay.',
      passedOver: [],
    };
    const fake = fakeClient({ 'GET /v1/carriers': { carriers: [DIRECT] } });
    const measuring = { choice: () => webrtc, subscribe: () => () => undefined };
    const Panel = buildConnectionsApp({ manifest, client: fake.client }, measuring, undefined, {
      webrtc: stand,
      tunnelSwitch: connectWith(storedList([DIRECT])).connect.tunnelSwitch,
    }).panels.carrier;

    const drawn = render(createElement(Panel));
    await settle();
    expect(log.asked).toBeGreaterThan(0);
    expect(JSON.stringify(drawn.toJSON())).toContain('31');
    run(() => drawn.unmount());

    // A relay on screen is never asked.
    const before = log.asked;
    const Relay = buildConnectionsApp(
      { manifest, client: fake.client },
      { choice: () => relay, subscribe: () => () => undefined },
      undefined,
      {
        webrtc: stand,
        tunnelSwitch: connectWith(storedList([DIRECT])).connect.tunnelSwitch,
      },
    ).panels.carrier;
    const other = render(createElement(Relay));
    await settle();
    run(() => other.unmount());
    expect(log.asked).toBe(before);
  });

  test('R635 before the shell has built the connect half the preference screen offers no tunnel switch and says nothing false', async () => {
    const fake = fakeClient({ 'GET /v1/carriers': { carriers: [DIRECT] } });
    const chosen = { [DAEMON]: 'relay' };
    const preferences = { snapshot: () => chosen, subscribe: () => () => undefined, set: () => undefined };
    const unbuilt = buildConnectionsApp({ manifest, client: fake.client }, undefined, preferences as never, {} as never)
      .settings.connection;

    const shown = render(createElement(unbuilt));
    await settle();
    expect(JSON.stringify(shown.toJSON())).toContain('This machine has no tunnel yet.');
    expect(fake.calls).not.toContain('GET /v1/tunnel');
    run(() => shown.unmount());
  });

  test('R677 a build with no WebRTC dialer says so under "WebRTC only"; one with a dialer does not', async () => {
    const fake = fakeClient({ 'GET /v1/carriers': { carriers: [DIRECT] }, 'GET /v1/tunnel': OFF });
    const chosen = { [DAEMON]: 'webrtc' };
    const preferences = { snapshot: () => chosen, subscribe: () => () => undefined, set: () => undefined };
    const { connect } = connectWith(storedList([DIRECT]));
    const without = buildConnectionsApp({ manifest, client: fake.client }, undefined, preferences as never, {
      webrtc: undefined,
      tunnelSwitch: connect.tunnelSwitch,
    }).settings.connection;
    const withDialer = buildConnectionsApp({ manifest, client: fake.client }, undefined, preferences as never, {
      webrtc: dialer(undefined).stand,
      tunnelSwitch: connect.tunnelSwitch,
    }).settings.connection;

    const bare = render(createElement(without));
    await settle();
    expect(JSON.stringify(bare.toJSON())).toContain('WebRTC isn’t available in this build yet');
    run(() => bare.unmount());
    const full = render(createElement(withDialer));
    await settle();
    expect(JSON.stringify(full.toJSON())).not.toContain('WebRTC isn’t available in this build yet');
    run(() => full.unmount());
  });
});

describe('a reconnecting machine and its outage sheet', () => {
  /** A mounted background view: the router's client for this machine, so the reconnect loop has something to read through. */
  async function held(wired: ReturnType<typeof connectWith>, answers: Record<string, unknown>) {
    const fake = fakeClient({ 'GET /v1/carriers': { carriers: [DIRECT] }, ...answers });
    const View = carrierWriteBackView(
      () => wired.connect.carrierSets,
      () => wired.connect,
    );
    const mounted = render(createElement(View, { daemon: DAEMON, client: fake.client }));
    await settle();
    return { fake, unmount: () => run(() => mounted.unmount()) };
  }
  const carrierReads = (calls: readonly string[]): number => calls.filter(call => call === 'GET /v1/carriers').length;

  test('R88 back online or back in the foreground, a reconnecting machine is retried at once, not at its backoff timer', async () => {
    for (const signal of ['online', 'visible', 'network-change'] as const) {
      const wired = connectWith(storedList([DIRECT]));
      const { fake, unmount } = await held(wired, {});
      wired.connect.health.outage(DAEMON, OUTAGE);
      // The first retry waits out its backoff: nothing has asked the machine again, however long the test waits.
      await settle();
      const before = carrierReads(fake.calls);
      expect(wired.timers.some(timer => timer.delayMs >= 150)).toBe(true);
      expect(wired.connect.health.state(DAEMON)).toMatchObject({ kind: 'reconnecting', attempt: 0 });

      wired.signal(signal);
      await settle();

      // One real read, and the machine's answer to it ends the outage (it is no longer waiting on a backoff).
      expect(carrierReads(fake.calls)).toBe(before + 1);
      expect(wired.connect.health.state(DAEMON)).toEqual({ kind: 'connected' });
      unmount();
    }
  });

  test('R88 a machine that is not reconnecting is not asked again by a signal', async () => {
    const wired = connectWith(storedList([DIRECT]));
    const { fake, unmount } = await held(wired, {});
    const before = carrierReads(fake.calls);

    wired.signal('online');
    await settle();

    expect(carrierReads(fake.calls)).toBe(before);
    expect(wired.connect.health.state(DAEMON)).toEqual({ kind: 'unknown' });
    unmount();
  });

  test('R88 the loop schedules its attempts on the shell’s timer, and a retry done at once leaves the old timer inert', async () => {
    const wired = connectWith(storedList([DIRECT]));
    const { fake, unmount } = await held(wired, {});
    wired.connect.health.outage(DAEMON, OUTAGE);
    const backoff = wired.timers.at(-1);
    wired.signal('online');
    await settle();
    const after = carrierReads(fake.calls);

    // The backoff the retry-now cancelled fires anyway (the shell's timer cannot be recalled): it does nothing.
    backoff?.run();
    await settle();

    expect(carrierReads(fake.calls)).toBe(after);
    unmount();
  });

  test('R88 a walk that finds nothing to carry is an outage (the router feeds the health model)', async () => {
    // Auto walks the published direct address first; nothing answers it here.
    const preferences = new CarrierPreferenceStore();
    preferences.set(DAEMON, 'auto');
    const wired = connectWith(storedList([DIRECT]), undefined, preferences);
    const daemon = storedList([DIRECT]).get(DAEMON) as PairedDaemon;
    const closed: number[] = [];
    run(() => {
      wired.connect.router.dial(daemon)({
        onBinary: () => undefined,
        onText: () => undefined,
        onClose: code => closed.push(code),
      });
    });
    await settle();

    expect(closed).toHaveLength(1);
    expect(wired.connect.health.state(DAEMON).kind).toBe('reconnecting');
  });

  test('an unpaired machine is no longer reconnecting', async () => {
    const wired = connectWith(storedList([DIRECT]));
    wired.connect.health.outage(DAEMON, OUTAGE);
    expect(wired.connect.health.reconnecting()).toEqual([DAEMON]);

    for (const cache of wired.caches) cache.clearDaemon(DAEMON);

    expect(wired.connect.health.reconnecting()).toEqual([]);
  });

  test('S-0145 the Connection panel shows one machine’s outage while it is reconnecting, and not before', async () => {
    const wired = connectWith(storedList([DIRECT]));
    const fake = fakeClient({ 'GET /v1/carriers': { carriers: [DIRECT] } });
    const Panel = buildConnectionsApp({ manifest, client: fake.client }, undefined, undefined, {
      webrtc: undefined,
      tunnelSwitch: wired.connect.tunnelSwitch,
      health: wired.connect.health,
      now: () => 0,
    }).panels.carrier;

    const drawn = render(createElement(Panel));
    await settle();
    expect(JSON.stringify(drawn.toJSON())).not.toContain('data-connection-outage');

    run(() => wired.connect.health.outage(DAEMON, OUTAGE));
    expect(JSON.stringify(drawn.toJSON())).toContain('data-connection-outage');
    expect(JSON.stringify(drawn.toJSON())).toContain('"data-connection-status":"reconnecting"');
    // The lost-for time and the attempt count, and a Retry now wired to THIS machine's health (not another's).
    expect(JSON.stringify(drawn.toJSON())).toContain('Lost 0 seconds ago');
    expect(JSON.stringify(drawn.toJSON())).toContain('0 automatic attempts');
    const retry = drawn.root.findByProps({ 'data-connection-retry': '' });
    run(() => retry.props.onClick());
    expect(wired.connect.health.state(DAEMON)).toMatchObject({ kind: 'reconnecting', attempt: 1 });
    expect(JSON.stringify(drawn.toJSON())).toContain('1 automatic attempt');

    run(() => wired.connect.health.answered(DAEMON));
    expect(JSON.stringify(drawn.toJSON())).not.toContain('data-connection-outage');
    run(() => drawn.unmount());
  });
});
