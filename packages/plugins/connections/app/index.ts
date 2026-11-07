import { type ConnectPorts, daemonOfClient, provideToShell } from '@ferretry/app';
import { implementApp, type AppContext } from '@ferretry/kernel/manifest';
import { createElement, useEffect, useState, useSyncExternalStore } from 'react';
import { CarriersChanged, CarriersViewSchema, type PublishedCarriers } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { CarrierRouter } from './carriers/router.ts';
import { bundledRelayDirectory, documentRelayDiscovery } from './discovery/hosted-relay.ts';
import { ActiveCarrierCard } from './features/carrier/active-carrier-card.tsx';
import { CarrierPreferenceSelector } from './features/carrier/carrier-preference-selector.tsx';
import { CarrierPreferenceStore } from './lib/carrier-preference.ts';
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
  watchConnectionSignals(signals, { checkLiveness: () => router.checkLiveness() });
  ports.daemons.registerCache({ clearDaemon: daemonId => router.clearDaemon(daemonId) });
  const pairing = pairingWalk({ openSocket: ports.openSocket, after: ports.after, hostedRelay: discovery.hostedRelay });
  return { router, preferences, discovery, pairing };
}

export function buildConnectionsApp(
  ctx: AppContext<typeof manifest>,
  measurements: ConnectionMeasurements = connect?.router ?? unmeasured,
  preferences: CarrierPreferenceStore = connect?.preferences ?? new CarrierPreferenceStore(),
) {
  const daemonId = daemonOfClient(ctx.client);
  function useCarriers(): PublishedCarriers {
    const [carriers, setCarriers] = useState<PublishedCarriers>([]);
    useEffect(() => {
      let alive = true;
      const refresh = () => {
        void ctx.client
          .call('GET /v1/carriers')
          .then(value => {
            const parsed = CarriersViewSchema.safeParse(value);
            if (alive && parsed.success) setCarriers(parsed.data.carriers);
          })
          .catch(() => undefined);
      };
      refresh();
      const stop = ctx.client.subscribe(CarriersChanged, refresh);
      return () => {
        alive = false;
        stop();
      };
    }, []);
    return carriers;
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
