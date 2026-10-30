/**
 * ONE ROW PER PAIRED MACHINE: the model behind Settings › Notifications and the "notifications are off"
 * banner.
 *
 * A Web Push subscription is enrolled WITH one daemon, so "are notifications on?" has a separate answer for
 * every machine. That answer is read from the machine itself (its own device list), never guessed from a
 * local switch: a machine whose list is empty has nobody to push to, and an Agenda push there goes
 * nowhere — which is the silent failure this model exists to name.
 *
 * Pure and total: facts in, rows out. The hook that reads the machines is `use-machine-notifications.ts`.
 */

import type { PushDeviceView } from '@ferretry/protocol';
import { DaemonResponseError } from './runtime-models.ts';

/** What one machine's push device list said, or why it said nothing. */
export type MachinePushReading =
  | { readonly kind: 'devices'; readonly devices: readonly PushDeviceView[] }
  | { readonly kind: 'offline' }
  | { readonly kind: 'needs-update' };

/** A daemon that predates push answers the push routes with one of these: "no such route". */
const MISSING_ROUTE_STATUSES: ReadonlySet<number> = new Set([404, 405, 501]);

/** A failed device-list read as a reading: a missing route is an old daemon; anything else, an absent one. */
export const readingFromFailure = (error: unknown): MachinePushReading =>
  error instanceof DaemonResponseError && MISSING_ROUTE_STATUSES.has(error.status)
    ? { kind: 'needs-update' }
    : { kind: 'offline' };

export type MachineNotificationStatus = 'checking' | 'on' | 'off' | 'offline' | 'needs-update';

export const MACHINE_STATUS_TEXT: Readonly<Record<MachineNotificationStatus, string>> = {
  checking: 'Checking…',
  on: 'On · this device',
  off: 'Off',
  offline: 'Machine offline',
  'needs-update': 'Needs an update',
};

/** Everything known about one machine, gathered by the caller. */
export interface MachineNotificationFact {
  readonly daemonId: string;
  readonly label: string;
  /** `null` while the first read is still in flight. */
  readonly reading: MachinePushReading | null;
  /** The device id THIS browser answers to for this machine, if it has enrolled. */
  readonly thisDeviceId: string | null;
  /** The reader's local mute for this machine (`notification-filter.ts`). */
  readonly muted: boolean;
}

export interface MachineNotificationRow {
  readonly daemonId: string;
  readonly label: string;
  readonly status: MachineNotificationStatus;
  readonly statusText: string;
  /** Enrolled devices across EVERY browser, or `null` when the machine could not be asked. */
  readonly enrolledDevices: number | null;
  /** The mute folded into the row: `true` means this browser shows this machine's notifications. */
  readonly shown: boolean;
}

const statusOf = (fact: MachineNotificationFact): MachineNotificationStatus => {
  const { reading } = fact;
  if (reading === null) return 'checking';
  if (reading.kind !== 'devices') return reading.kind;
  const here = fact.thisDeviceId !== null && reading.devices.some(device => device.id === fact.thisDeviceId);
  return here ? 'on' : 'off';
};

/** Every machine, in the order given, active one included. */
export const machineNotificationRows = (facts: readonly MachineNotificationFact[]): readonly MachineNotificationRow[] =>
  facts.map(fact => {
    const status = statusOf(fact);
    return {
      daemonId: fact.daemonId,
      label: fact.label,
      status,
      statusText: MACHINE_STATUS_TEXT[status],
      enrolledDevices: fact.reading?.kind === 'devices' ? fact.reading.devices.length : null,
      shown: !fact.muted,
    };
  });

/** "Turn on for all machines" reaches only a machine that is answering and is off here. */
export const turnOnAllTargets = (rows: readonly MachineNotificationRow[]): readonly MachineNotificationRow[] =>
  rows.filter(row => row.status === 'off');

/** Machines that answered and have NO enrolled device on any browser: a push there reaches nobody. */
export const machinesOffEverywhere = (rows: readonly MachineNotificationRow[]): readonly MachineNotificationRow[] =>
  rows.filter(row => row.enrolledDevices === 0);

export const offEverywhereSentence = (label: string): string =>
  `Notifications are off for ${label} on every device — turn them on`;
