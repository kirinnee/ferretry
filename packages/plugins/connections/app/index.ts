import { type ConnectPorts, daemonOfClient, provideToShell } from '@ferretry/app';
import { implementApp, type AppContext } from '@ferretry/kernel/manifest';
import { createElement, useSyncExternalStore } from 'react';
import { CarriersChanged, CarriersViewSchema, type PublishedCarriers } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { CarrierRouter } from './carriers/router.ts';
import { bundledRelayDirectory, documentRelayDiscovery } from './discovery/hosted-relay.ts';
import { ActiveCarrierCard } from './features/carrier/active-carrier-card.tsx';
import { CarrierPreferenceSelector } from './features/carrier/carrier-preference-selector.tsx';
import { CarrierPreferenceStore } from './lib/carrier-preference.ts';
import { type CarrierWriteBack, carrierWriteBack } from './lib/carrier-write-back.ts';
import {
  browserConnectionSignals,
  type ConnectionSignalEnvironment,
  watchConnectionSignals,
} from './lib/connection-signals.ts';
import type { ConnectionChoice } from './lib/connection.ts';
import { readTunnelService, type TunnelServiceState } from './lib/tunnel-service.ts';
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
) {
  const discovery = documentRelayDiscovery(ports.directory);
  let tunnelService: Promise<TunnelServiceState> | undefined;
  const router = new CarrierRouter({
    openSocket: ports.openSocket,
    after: ports.after,
    now: ports.now,
    preference: preferences.preference,
    hostedRelay: discovery.hostedRelay,
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
  // GAP(parity): R88's "retry every outage now" and the WebRTC network nudge are NOT wired — no reconnect loop is built in
  // this half yet, so a daemon that is reconnecting waits for its backoff timer. Said out loud here (and in
  // ports-pending.json) rather than hidden by an optional field.
  watchConnectionSignals(signals, {
    reconnecting: () => [],
    retryNow: () => {},
    networkChanged: () => {},
    checkLiveness: () => router.checkLiveness(),
  });
  ports.daemons.registerCache({ clearDaemon: daemonId => router.clearDaemon(daemonId) });
  const pairing = pairingWalk({ openSocket: ports.openSocket, after: ports.after, hostedRelay: discovery.hostedRelay });
  // The daemon's answer to `GET /v1/carriers` REPLACES what this device stores for it (P51, R170, R186, R210).
  const carrierSets = carrierWriteBack(ports.daemons);
  return { router, preferences, discovery, pairing, carrierSets };
}

export function buildConnectionsApp(
  ctx: AppContext<typeof manifest>,
  measurements: ConnectionMeasurements = connect?.router ?? unmeasured,
  preferences: CarrierPreferenceStore = connect?.preferences ?? new CarrierPreferenceStore(),
  carrierSets: CarrierWriteBack | undefined = connect?.carrierSets,
) {
  const daemonId = daemonOfClient(ctx.client);
  /**
   * The published set as the daemon last answered it, for every screen of this half. One refresh path: a successful
   * answer is the connection proving itself, so it is also written back as this device's stored set. Read when the half
   * is built for the daemon (whether or not a screen is open), and again whenever the daemon says its carriers changed.
   */
  const published = (() => {
    let latest: PublishedCarriers = [];
    const listeners = new Set<() => void>();
    const refresh = () => {
      const adopt = daemonId === undefined ? undefined : carrierSets?.begin(daemonId);
      void Promise.resolve()
        .then(() => ctx.client.call('GET /v1/carriers'))
        .then(value => {
          const parsed = CarriersViewSchema.safeParse(value);
          if (!parsed.success) return;
          adopt?.(parsed.data.carriers);
          latest = parsed.data.carriers;
          for (const listener of [...listeners]) listener();
        })
        .catch(() => undefined);
    };
    refresh();
    ctx.client.subscribe(CarriersChanged, refresh);
    return {
      snapshot: (): PublishedCarriers => latest,
      subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
  })();
  function useCarriers(): PublishedCarriers {
    return useSyncExternalStore(published.subscribe, published.snapshot);
  }
  function Preference() {
    const carriers = useCarriers();
    const snapshot = useSyncExternalStore(listener => preferences.subscribe(() => listener()), preferences.snapshot);
    if (daemonId === undefined) return null;
    return createElement(CarrierPreferenceSelector, {
      legend: 'Connection preference',
      value: snapshot[daemonId] ?? 'relay',
      onChange: value => preferences.set(daemonId, value),
      availability: {
        // This build has no WebRTC dialer: the walk passes it over untried and says so.
        webrtc: false,
        tunnelNote: carriers.some(c => c.kind === 'tunnel') ? undefined : 'This machine has no tunnel yet.',
      },
    });
  }
  function Panel() {
    const carriers = useCarriers();
    const choice = useSyncExternalStore(measurements.subscribe.bind(measurements), () =>
      daemonId === undefined ? undefined : measurements.choice(daemonId),
    );
    return createElement(ActiveCarrierCard, { choice, relayAdvertised: carriers.some(c => c.kind === 'relay') });
  }
  return { panels: { carrier: Panel }, settings: { connection: Preference } };
}

export default provideToShell(implementApp(manifest, { build: ctx => buildConnectionsApp(ctx) }), {
  carriers: ports => [connectFor(ports).router.dialer()],
  pairing: ports => connectFor(ports).pairing,
});
