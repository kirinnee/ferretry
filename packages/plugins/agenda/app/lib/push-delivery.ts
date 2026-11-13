/**
 * THIS BROWSER'S PUSH DELIVERY WITH ONE MACHINE, as the Agenda's notification controls read it: a PORT, because the
 * enrolment itself is Access's. Which subscription this browser holds, the device id a machine minted for it, the
 * device list (`GET /v1/push/subscriptions`) and a revoke are Access's routes and Access's state (`push.json`,
 * §9.2), so this half never calls them; whoever binds the controls hands an implementation of this port in (Access,
 * through the shell). With none bound, delivery reads as unavailable and the page still notifies while it is open.
 *
 * Every operation names the machine it is about, and every answer is the readout the controls draw.
 */

import type { DaemonConnection } from './machine.ts';

/** One device enrolled with a machine, as its push device list names it (Access's `PushDeviceView`). */
export interface PushDeviceView {
  readonly id: string;
  readonly deviceName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expirationTime: number | null;
}

export type PushDeliveryStatus = 'idle' | 'checking' | 'active' | 'unavailable';

/** What closed-app delivery is doing for one machine, and the devices it named. */
export interface PushDeliveryReport {
  readonly status: PushDeliveryStatus;
  readonly message: string | null;
  readonly devices: readonly PushDeviceView[];
  /** The device id THIS browser answers to for that machine, when it has enrolled. */
  readonly currentDeviceId: string | null;
}

/** The four acts the controls ask of push delivery. Each settles with a readout and never rejects. */
export interface PushDeliveryPort {
  /** What delivery is doing now; `enabled` is this browser's stored switch for the machine. */
  readonly read: (connection: DaemonConnection, enabled: boolean) => Promise<PushDeliveryReport>;
  /** Enrol this browser with the machine (the caller already holds granted permission). */
  readonly enable: (connection: DaemonConnection) => Promise<PushDeliveryReport>;
  /** Revoke this browser's device with the machine and drop the local endpoint. */
  readonly disable: (connection: DaemonConnection) => Promise<PushDeliveryReport>;
  /** Revoke one named device from the machine that issued it. */
  readonly revoke: (connection: DaemonConnection, deviceId: string) => Promise<PushDeliveryReport>;
}

/** Shown when no push delivery is bound here, or the browser cannot do Web Push at all. */
export const PUSH_UNSUPPORTED_MESSAGE =
  'Web Push is unavailable in this browser; notifications still appear while the app is open.';

/** Shown when a device could not be revoked with its machine. */
export const PUSH_REVOKE_FAILED_MESSAGE = 'Could not revoke that device with this daemon.';
