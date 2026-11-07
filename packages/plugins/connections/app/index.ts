import { implementApp, type AppContext } from '@ferretry/kernel/manifest';
import { createElement, useEffect, useState, useSyncExternalStore } from 'react';
import { CarriersChanged, CarriersViewSchema, type PublishedCarriers } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { ActiveCarrierCard, type ActiveCarrierCardProps } from './features/carrier/active-carrier-card.tsx';
import { CarrierPreferenceSelector } from './features/carrier/carrier-preference-selector.tsx';
import { CarrierPreferenceStore } from './lib/carrier-preference.ts';

/** The app shell owns measured session state. A carrier is never guessed from a published address. */
export interface ConnectionMeasurements {
  readonly daemonId?: string;
  current(): Pick<ActiveCarrierCardProps, 'choice' | 'health' | 'machine'>;
  subscribe(listener: () => void): () => void;
  readonly webrtc?: boolean;
}
const UNKNOWN: ReturnType<ConnectionMeasurements['current']> = { choice: undefined };
const unmeasured: ConnectionMeasurements = { current: () => UNKNOWN, subscribe: () => () => undefined };
// TODO: copy today's relay-carrier/session/pairing-unreachable walk into the Connections app half, then bind the
// shell CarrierDialers and live measurements. The document's hosted directory read must be shared with Access's
// pairing walk; it must ignore carrier preference and prove the pinned identity before the code leaves the page.
export function buildConnectionsApp(
  ctx: AppContext<typeof manifest>,
  measurements: ConnectionMeasurements = unmeasured,
) {
  const preferences = new CarrierPreferenceStore();
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
    if (measurements.daemonId === undefined) return null;
    return createElement(CarrierPreferenceSelector, {
      legend: 'Connection preference',
      value: snapshot[measurements.daemonId] ?? 'relay',
      onChange: value => preferences.set(measurements.daemonId!, value),
      availability: {
        webrtc: measurements.webrtc === true,
        tunnelNote: carriers.some(c => c.kind === 'tunnel') ? undefined : 'This machine has no tunnel yet.',
      },
    });
  }
  function Panel() {
    const carriers = useCarriers();
    const measured = useSyncExternalStore(measurements.subscribe, measurements.current);
    return createElement(ActiveCarrierCard, { ...measured, relayAdvertised: carriers.some(c => c.kind === 'relay') });
  }
  return { panels: { carrier: Panel }, settings: { connection: Preference } };
}
export default implementApp(manifest, { build: ctx => buildConnectionsApp(ctx) });
