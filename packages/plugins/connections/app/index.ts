import { type BackgroundViewProps, type ConnectPorts, daemonOfClient, provideToShell } from '@ferretry/app';
import { implementApp, type AppContext } from '@ferretry/kernel/manifest';
import { createElement, useCallback, useEffect, useSyncExternalStore } from 'react';
import type { PublishedCarriers } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { CarrierRouter } from './carriers/router.ts';
import { bundledRelayDirectory, documentRelayDiscovery } from './discovery/hosted-relay.ts';
import { ActiveCarrierCard } from './features/carrier/active-carrier-card.tsx';
import { CarrierPreferenceSelector, tunnelSwitchOffer } from './features/carrier/carrier-preference-selector.tsx';
import { CarrierPreferenceStore } from './lib/carrier-preference.ts';
import { watchCarriers } from './lib/carrier-watch.ts';
import { type CarrierWriteBack, carrierWriteBack } from './lib/carrier-write-back.ts';
import {
  browserConnectionSignals,
  type ConnectionSignalEnvironment,
  watchConnectionSignals,
} from './lib/connection-signals.ts';
import type { ConnectionChoice } from './lib/connection.ts';
import { IntroducerRegistry } from './lib/introducers.ts';
import { readTunnelService, type TunnelServiceState } from './lib/tunnel-service.ts';
import { keptTunnel, type TunnelSwitchState, TunnelSwitchStore } from './lib/tunnel-switch.ts';
import { useCarrierRtt } from './lib/use-carrier-rtt.ts';
import { browserWebRtcDialer, type WebRtcDialer } from './lib/webrtc-carrier.ts';
import { pairingWalk } from './pairing/walk.ts';

/**
 * CONNECTIONS' APP HALF: the shell's carriers and the pairing walk (`shell`), and the Connection panel and preference
 * (`build`). Both halves share one router per document, so the panel shows exactly what the walks measured — a
 * carrier is never guessed from a published address.
 */

/** What the panel reads: the router's measured choice for one daemon, and its changes. */
export interface ConnectionMeasurements {
  choice(daemonId: string): ConnectionChoice | undefined;
  subscribe(listener: () => void): () => void;
}

const unmeasured: ConnectionMeasurements = { choice: () => undefined, subscribe: () => () => undefined };

/** A snapshot that never changes, for a half built with no tunnel switch (a store snapshot must be one stable value). */
const NO_TUNNEL_STATES: Readonly<Record<string, TunnelSwitchState>> = Object.freeze({});

/** The document's connect parts, built once per set of shell ports (`registeredConnect` runs once per document). */
type Connect = ReturnType<typeof buildConnect>;
const built = new WeakMap<ConnectPorts, Connect>();
let connect: Connect | undefined;

function connectFor(ports: ConnectPorts): Connect {
  const known = built.get(ports);
  if (known !== undefined) return known;
  const fresh = buildConnect(ports);
  built.set(ports, fresh);
  connect = fresh;
  return fresh;
}

/** Builds the document's router and pairing walk from the shell's ports (`registeredConnect`, once per document). */
export function buildConnect(
  ports: ConnectPorts,
  preferences = new CarrierPreferenceStore(),
  signals: ConnectionSignalEnvironment = browserConnectionSignals(),
  webrtc: WebRtcDialer | undefined = browserWebRtcDialer(),
) {
  const discovery = documentRelayDiscovery(ports.directory);
  let tunnelService: Promise<TunnelServiceState> | undefined;
  // The daemon's answer to `GET /v1/carriers` REPLACES what this device stores for it (P51, R170, R186, R210) — except
  // the tunnel, which a refresh does not withdraw by omission (R635).
  const carrierSets = carrierWriteBack(ports.daemons);
  // The clients this half holds, per paired daemon: the one way the router asks a machine anything (R636, §16).
  const introducers = new IntroducerRegistry();
  // The daemon's word on its own tunnel decides what this device keeps: up at a hostname is kept, off or unable to run
  // is forgotten. Its requests are carrier control, so they ride the introducers whatever the preference is (R634).
  const tunnelSwitch = new TunnelSwitchStore({
    control: async (daemon, url, init) => {
      const request = introducers.request(daemon.daemonId);
      if (request === undefined) throw new Error('no client holds this machine yet');
      return await request(url, init);
    },
    observed: (daemon, view) => {
      const tunnel = keptTunnel(view);
      if (tunnel !== undefined) carrierSets.replaceTunnel(daemon.daemonId, tunnel ?? undefined);
    },
  });
  const router = new CarrierRouter({
    openSocket: ports.openSocket,
    after: ports.after,
    now: ports.now,
    preference: preferences.preference,
    hostedRelay: discovery.hostedRelay,
    ...(webrtc === undefined ? {} : { webrtc }),
    introduce: daemonId => introducers.request(daemonId),
    // What a "Tunnel only" walk learned by asking the daemon is kept exactly as a refresh's tunnel is.
    learned: (daemonId, tunnel) => void carrierSets.replaceTunnel(daemonId, tunnel),
    tunnelSwitchedOff: daemonId => {
      const state = tunnelSwitch.state(daemonId);
      return state.kind === 'known' && !state.view.enabled;
    },
    // Read once, and only when something asks: "Tunnel only" with no tunnel to dial.
    tunnelService: async () => {
      tunnelService ??=
        ports.directory === undefined
          ? Promise.resolve<TunnelServiceState>('unavailable')
          : readTunnelService({ directoryUrl: bundledRelayDirectory(), fetcher: ports.directory });
      return await tunnelService;
    },
  });
  // A preference change forgets only that machine's winner; an unpair forgets the machine.
  preferences.subscribe(daemonId => router.rewalk(daemonId));
  // Back online, back in the foreground, a new network: prove every held session is still alive (4 s) rather than
  // waiting for its next ping. Document-lifetime, like the router (`registeredConnect` builds this once per document).
  // GAP(parity): R88's "retry every outage now" is NOT wired — no reconnect loop is built in this half yet, so a daemon
  // that is reconnecting waits for its backoff timer. Said out loud here (and in ports-pending.json) rather than hidden
  // by an optional field. A new network DOES drop every WebRTC path (R685: no ICE restart; the next dial negotiates
  // afresh over the network the device is on now).
  watchConnectionSignals(signals, {
    reconnecting: () => [],
    retryNow: () => {},
    networkChanged: () => webrtc?.networkChanged(),
    checkLiveness: () => router.checkLiveness(),
  });
  ports.daemons.registerCache({ clearDaemon: daemonId => router.clearDaemon(daemonId) });
  const pairing = pairingWalk({ openSocket: ports.openSocket, after: ports.after, hostedRelay: discovery.hostedRelay });
  return { router, preferences, discovery, pairing, carrierSets, introducers, tunnelSwitch, webrtc };
}

export function buildConnectionsApp(
  ctx: AppContext<typeof manifest>,
  measurements: ConnectionMeasurements = connect?.router ?? unmeasured,
  preferences: CarrierPreferenceStore = connect?.preferences ?? new CarrierPreferenceStore(),
  /** The machine's tunnel switch and the WebRTC dialer: what the preference screen and the panel read (R635, R677). */
  live: Pick<Connect, 'tunnelSwitch' | 'webrtc'> | undefined = connect,
) {
  const daemonId = daemonOfClient(ctx.client);
  const tunnelSwitch = live?.tunnelSwitch;
  const webrtc = live?.webrtc;
  /**
   * The published set as the daemon last answered it, for the screens of this half. It watches the daemon only while a
   * screen is subscribed to it, and stops with the last one, so a half rebuilt on every reconnect leaves no listener
   * behind. It stores nothing: the stored set is refreshed by {@link carrierWriteBackView}, which runs whatever screen
   * is open.
   */
  const published = (() => {
    let latest: PublishedCarriers = [];
    let stop: (() => void) | undefined;
    const listeners = new Set<() => void>();
    return {
      snapshot: (): PublishedCarriers => latest,
      subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener);
        stop ??= watchCarriers({
          client: ctx.client,
          onAnswer: carriers => {
            latest = carriers;
            for (const each of [...listeners]) each();
          },
        });
        return () => {
          listeners.delete(listener);
          if (listeners.size > 0) return;
          stop?.();
          stop = undefined;
        };
      },
    };
  })();
  function useCarriers(): PublishedCarriers {
    return useSyncExternalStore(published.subscribe, published.snapshot);
  }
  const noTunnelStates = {
    subscribe: () => () => undefined,
    snapshot: (): Readonly<Record<string, TunnelSwitchState>> => NO_TUNNEL_STATES,
  };
  function Preference() {
    const carriers = useCarriers();
    const snapshot = useSyncExternalStore(listener => preferences.subscribe(() => listener()), preferences.snapshot);
    const switches = useSyncExternalStore(
      tunnelSwitch?.subscribe.bind(tunnelSwitch) ?? noTunnelStates.subscribe,
      tunnelSwitch?.snapshot ?? noTunnelStates.snapshot,
    );
    // What the machine says about its own tunnel is asked when its preference is drawn, so the offer to turn one on
    // is there the moment "Tunnel only" or Auto is chosen (§15).
    useEffect(() => {
      if (daemonId !== undefined) void tunnelSwitch?.refresh({ daemonId });
    }, []);
    if (daemonId === undefined) return null;
    return createElement(CarrierPreferenceSelector, {
      legend: 'Connection preference',
      value: snapshot[daemonId] ?? 'relay',
      onChange: value => preferences.set(daemonId, value),
      availability: {
        // Without an RTCPeerConnection (a browser that switched WebRTC off) the walk passes WebRTC over untried and
        // says so.
        webrtc: webrtc !== undefined,
        tunnelNote: carriers.some(c => c.kind === 'tunnel') ? undefined : 'This machine has no tunnel yet.',
        tunnel:
          tunnelSwitch === undefined
            ? undefined
            : tunnelSwitchOffer(switches[daemonId], () => tunnelSwitch.set({ daemonId }, true)),
      },
    });
  }
  function Panel() {
    const carriers = useCarriers();
    const measured = useSyncExternalStore(measurements.subscribe.bind(measurements), () =>
      daemonId === undefined ? undefined : measurements.choice(daemonId),
    );
    // The round trip is asked of the peer connection only while a WebRTC choice is on screen (R686).
    const measureRtt = useCallback(
      () => (daemonId === undefined || webrtc === undefined ? Promise.resolve(undefined) : webrtc.rttMs(daemonId)),
      [],
    );
    const choice = useCarrierRtt(measured, webrtc === undefined ? undefined : measureRtt);
    return createElement(ActiveCarrierCard, { choice, relayAdvertised: carriers.some(c => c.kind === 'relay') });
  }
  return { panels: { carrier: Panel }, settings: { connection: Preference } };
}

/**
 * THE STORED CARRIER SET IS REFRESHED FOR EVERY PAIRED DAEMON, WHATEVER SCREEN IS OPEN (P51, R186, R198, R210).
 *
 * A background view: the shell mounts it ONCE PER PAIRED DAEMON at the frame root, outside the router, so it does not
 * wait for a Connections panel or tab to be drawn (a half is built only when one of its views is). It reads
 * `GET /v1/carriers` on mount, when the daemon says its carriers changed and when the feed comes back live (v4's
 * `carrier.onConnected`), and replaces what this device stores for that daemon with the answer. It renders nothing, and
 * its effect unsubscribes everything on unmount.
 */
export function carrierWriteBackView(
  writeBack: () => CarrierWriteBack | undefined,
  /** What this half asks the machine through: its clients, and the tunnel switch that tells "reconnecting" from "gone". */
  asks: () => Pick<Connect, 'introducers' | 'tunnelSwitch'> | undefined = () => undefined,
): (props: BackgroundViewProps) => null {
  return function CarrierWriteBackWatcher({ daemon, client }) {
    useEffect(() => {
      const held = asks();
      // The router asks this machine through this client (the tunnel lookup, WebRTC's signalling) for as long as it is
      // paired: the background view is mounted once per paired daemon, whatever screen is open.
      const release = held?.introducers.attach(daemon, client);
      const writer = writeBack();
      const stop = watchCarriers({
        client,
        daemon,
        writeBack: writer,
        onAnswer: carriers => {
          // A set that names no tunnel cannot tell "reconnecting" from "gone"; the machine's own word can (R635).
          if (writer?.holdsTunnel(daemon) === true && !carriers.some(carrier => carrier.kind === 'tunnel'))
            void held?.tunnelSwitch.refresh({ daemonId: daemon });
        },
      });
      return () => {
        stop();
        release?.();
      };
    }, [client, daemon]);
    return null;
  };
}

export default provideToShell(implementApp(manifest, { build: ctx => buildConnectionsApp(ctx) }), {
  background: {
    'carrier-set': carrierWriteBackView(
      () => connect?.carrierSets,
      () => connect,
    ),
  },
  carriers: ports => [connectFor(ports).router.dialer()],
  pairing: ports => connectFor(ports).pairing,
});
