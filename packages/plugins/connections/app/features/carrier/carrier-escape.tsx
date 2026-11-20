/**
 * THE WAY OUT OF A CARRIER THIS DEVICE CANNOT REACH A MACHINE OVER.
 *
 * A device that chose one carrier ("Tunnel only", "WebRTC only", "Relay only") and cannot reach its machine over it has
 * nowhere to go: every screen of the machine is replaced by "this device cannot reach this daemon", and the preference
 * that caused it lives on a screen of the very machine it hides. The preference is this browser's own, so clearing it
 * needs no machine. This view is mounted once at the frame root (a device view), whatever screen is open, and says so
 * for each machine that is in an outage on a carrier its person narrowed to: one button, "Use the default (Relay)",
 * which forgets the choice and sends nothing to the machine.
 */

import type { DaemonList, PairedDaemon } from '@ferretry/app';
import { createElement, useSyncExternalStore } from 'react';
import {
  CARRIER_PREFERENCE_LABEL,
  type CarrierPreference,
  type CarrierPreferenceStore,
} from '../../lib/carrier-preference.ts';
import type { ConnectionHealthState, DaemonConnectionHealth } from '../../lib/connection-health.ts';
import { Button } from '../../shell/primitives.tsx';

/** What the escape reads: this device's choices, and how well each machine is being reached. */
export interface CarrierEscapePorts {
  readonly preferences: Pick<CarrierPreferenceStore, 'snapshot' | 'subscribe' | 'reset'>;
  readonly health: Pick<DaemonConnectionHealth, 'state' | 'subscribe'>;
}

/** Said when the escape is offered. */
const CARRIER_ESCAPE_ACTION = 'Use the default (Relay)';

/**
 * The choice that is to blame, if any: a preference that narrows the walk (anything but Auto) for a machine that is in
 * an outage which is not the device's own network. Auto walks every carrier, so it is never the reason nothing carries.
 */
export const stuckPreference = (
  chosen: CarrierPreference | undefined,
  health: ConnectionHealthState,
): CarrierPreference | undefined =>
  chosen === undefined || chosen === 'auto' || health.kind !== 'reconnecting' || health.cause === 'device-offline'
    ? undefined
    : chosen;

const noHealth: ConnectionHealthState = Object.freeze({ kind: 'unknown' });

function EscapeFor({ daemon, ports }: { readonly daemon: PairedDaemon; readonly ports: CarrierEscapePorts }) {
  const chosen = useSyncExternalStore(
    listener => ports.preferences.subscribe(() => listener()),
    ports.preferences.snapshot,
    ports.preferences.snapshot,
  );
  const health = useSyncExternalStore(
    listener => ports.health.subscribe(daemon.daemon, listener),
    () => ports.health.state(daemon.daemon),
    () => noHealth,
  );
  const stuck = stuckPreference(chosen[daemon.daemon], health);
  if (stuck === undefined) return null;
  return (
    <div
      role="status"
      data-carrier-escape={daemon.daemon}
      className="fy-shell-line m-0 flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-fg"
    >
      <span className="min-w-0">
        {`This device can’t reach ${daemon.machine} over “${CARRIER_PREFERENCE_LABEL[stuck]}”.`}
      </span>
      <Button
        type="button"
        variant="primary"
        className="min-h-[44px]"
        data-carrier-escape-action=""
        onClick={() => ports.preferences.reset(daemon.daemon)}
      >
        {CARRIER_ESCAPE_ACTION}
      </Button>
    </div>
  );
}

/** One line per machine that is stuck, and nothing at all when none is. */
function CarrierEscapeLines({
  daemons,
  ports,
}: {
  readonly daemons: readonly PairedDaemon[];
  readonly ports: CarrierEscapePorts;
}) {
  const list = useSyncExternalStore(
    listener => ports.preferences.subscribe(() => listener()),
    ports.preferences.snapshot,
    ports.preferences.snapshot,
  );
  if (Object.keys(list).length === 0) return null;
  return createElement(
    'div',
    { className: 'flex min-w-0 flex-col gap-1' },
    daemons.map(daemon => createElement(EscapeFor, { key: daemon.daemon, daemon, ports })),
  );
}

/**
 * The document's own list of paired machines. A device view is drawn under `WithoutShell`, where `usePairedDaemons`
 * answers nothing, so the view reads the list Connections already holds (`connect.daemons`), never the shell's.
 */
export type PairedMachines = Pick<DaemonList, 'snapshot' | 'subscribe'>;

/** The device view the frame mounts once, over the machines this device is paired with. */
export function carrierEscapeView(
  ports: () => (CarrierEscapePorts & { readonly daemons: PairedMachines }) | undefined,
) {
  return function CarrierEscape() {
    const held = ports();
    return held === undefined ? null : createElement(PairedEscape, { held });
  };
}

function PairedEscape({ held }: { readonly held: CarrierEscapePorts & { readonly daemons: PairedMachines } }) {
  const snapshot = useSyncExternalStore(
    listener => held.daemons.subscribe(listener),
    () => held.daemons.snapshot(),
    () => held.daemons.snapshot(),
  );
  return createElement(CarrierEscapeLines, { daemons: snapshot.daemons, ports: held });
}
