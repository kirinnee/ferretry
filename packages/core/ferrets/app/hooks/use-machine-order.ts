/**
 * The order this device lists its paired machines in, and the one way to change it.
 *
 * Reading is the controls record's `machineOrder`; writing stores the WHOLE reconciled order
 * (everyone paired now), which is also what drops a machine that was unpaired. A write that changes
 * nothing stores nothing and wakes nobody.
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { DaemonControlsStore } from '../lib/controls.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';

export interface MachineOrder {
  /** The saved ids, as stored: pass to `machineDisplayOrder`. */
  readonly saved: readonly string[];
  /** Stores `order` (every machine paired now, in the order wanted). */
  readonly commit: (order: readonly DaemonId[]) => void;
}

export function useMachineOrder(controls: DaemonControlsStore): MachineOrder {
  const saved = useSyncExternalStore(
    controls.subscribe,
    () => controls.snapshot().device.machineOrder,
    () => controls.snapshot().device.machineOrder,
  );
  const commit = useCallback(
    (order: readonly DaemonId[]) => {
      const current = controls.snapshot().device.machineOrder;
      if (order.length === current.length && order.every((id, index) => id === current[index])) return;
      controls.setDeviceControls({ machineOrder: order });
    },
    [controls],
  );
  return { saved, commit };
}
