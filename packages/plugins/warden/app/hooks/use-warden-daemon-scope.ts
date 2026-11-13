/**
 * The daemon the Warden page is narrowed to on this device, and the one way to change it.
 *
 * Reading is the controls record's `wardenDaemon` (null = All); a write that changes nothing stores
 * nothing and wakes nobody. What the id means against who is paired now is `resolveWardenScope`'s job.
 */

import { useCallback, useSyncExternalStore } from 'react';
/** This device's remembered choices, as far as this hook reads them: a record with a subscription and one setter. */
export interface WardenDaemonControls {
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => { readonly device: { readonly wardenDaemon: string | null } };
  readonly setDeviceControls: (patch: { readonly wardenDaemon: string | null }) => unknown;
}

export interface WardenDaemonScope {
  readonly remembered: string | null;
  readonly remember: (daemonId: string | null) => void;
}

export function useWardenDaemonScope(controls: WardenDaemonControls): WardenDaemonScope {
  const remembered = useSyncExternalStore(
    controls.subscribe,
    () => controls.snapshot().device.wardenDaemon,
    () => controls.snapshot().device.wardenDaemon,
  );
  const remember = useCallback(
    (daemonId: string | null) => {
      if (controls.snapshot().device.wardenDaemon === daemonId) return;
      controls.setDeviceControls({ wardenDaemon: daemonId });
    },
    [controls],
  );
  return { remembered, remember };
}
