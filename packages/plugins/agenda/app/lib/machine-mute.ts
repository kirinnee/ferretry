/**
 * ONE MACHINE'S MUTE, as this browser keeps it: the `access.machine-mute` hook Agenda provides to Access's
 * Settings › This device › Notifications row. The state is the device-wide notification filter's `machines` map
 * (`lib/notification-filter.ts`): a machine marked `false` is silenced, anything else shows. Setting it writes the
 * same document the worker reads, so a mute in Settings is the one the closed app honours.
 */

import { deviceFilterStore } from './device-filter-store.ts';
import type { DeviceNotificationFilterStore } from './notification-filter.ts';

/** The shape Access narrows (`AccessMachineMute` in Access's contract; named only by the hook's agreement). */
export interface MachineMute {
  readonly subscribe: (listener: () => void) => () => void;
  readonly muted: () => boolean;
  readonly setMuted: (muted: boolean) => void;
}

/** `daemon`'s mute over the filter store; the store is reached on use, so building the value touches no storage. */
export const machineMute = (
  daemon: string,
  storeOf: () => DeviceNotificationFilterStore = deviceFilterStore,
): MachineMute => ({
  subscribe: listener => storeOf().subscribe(listener),
  muted: () => storeOf().get().machines[daemon] === false,
  setMuted: muted => void storeOf().set({ machines: { [daemon]: !muted } }),
});
