/**
 * SETTINGS › THIS DEVICE › CONNECTION: how this device reaches each paired machine (`docs/relay-protocol.md` §15).
 *
 * The preference is this browser's, kept per machine and never sent to a daemon, so it needs no machine to be reachable:
 * this panel lists every paired machine with the same selector the machine's own Connection panel carries. It exists
 * because the machine's panel is a screen OF that machine — when a whole machine is blocked (its plugin list could not be
 * read through the carrier this device chose) the block screen links here, and the person can change the carrier from it.
 */

import type { DaemonList, PairedDaemon } from '@ferretry/app';
import { createElement, useSyncExternalStore } from 'react';
import type { CarrierPreferenceStore } from '../../lib/carrier-preference.ts';
import { settingOf } from '../../lib/carrier-preference.ts';
import { CarrierDropsCard, type CarrierDropsSource } from './carrier-drops-card.tsx';
import { CarrierPreferenceSelector } from './carrier-preference-selector.tsx';

export interface DeviceConnectionPorts {
  readonly daemons: Pick<DaemonList, 'snapshot' | 'subscribe'>;
  readonly preferences: CarrierPreferenceStore;
  /** The sessions this browser lost; absent where nothing records them, which draws no card. */
  readonly drops?: CarrierDropsSource;
  /** Whether this build can dial WebRTC at all. */
  readonly webrtc: boolean;
}

const machineName = (daemon: PairedDaemon): string => daemon.machine;

export function DeviceConnectionPanel({ daemons, preferences, drops, webrtc }: DeviceConnectionPorts) {
  const list = useSyncExternalStore(daemons.subscribe, daemons.snapshot, daemons.snapshot);
  const chosen = useSyncExternalStore(
    listener => preferences.subscribe(() => listener()),
    preferences.snapshot,
    preferences.snapshot,
  );
  if (list.daemons.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="device-connection-heading" data-device-connection="">
      <h3 id="device-connection-heading" className="m-0 text-row font-semibold text-fg">
        Connection
      </h3>
      <p className="m-0 text-cell leading-base text-muted">
        How this device reaches each machine. It is kept on this device only.
      </p>
      {list.daemons.map(daemon =>
        createElement(CarrierPreferenceSelector, {
          key: daemon.daemon,
          legend: machineName(daemon),
          value: settingOf(chosen[daemon.daemon]),
          onChange: value =>
            value === 'default' ? preferences.reset(daemon.daemon) : preferences.set(daemon.daemon, value),
          availability: { webrtc },
        }),
      )}
      {drops === undefined ? null : <CarrierDropsCard log={drops} />}
    </section>
  );
}
