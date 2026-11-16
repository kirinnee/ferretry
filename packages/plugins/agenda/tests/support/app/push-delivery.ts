/**
 * A scripted push delivery (`PushDeliveryPort`) for the notification-controls suites. The real one is Access's
 * enrolment; this one keeps what the controls can observe of it: a device list read from the machine, this browser's
 * device id per machine, an enrolment that registers a device, and revokes — each logged, and each device list read
 * answerable on the test's own schedule (`deferred`), so the ORDER reads resolve in is something a test chooses.
 */

import type { DaemonConnection } from '../../../app/lib/machine.ts';
import {
  PUSH_UNSUPPORTED_MESSAGE,
  type PushDeliveryPort,
  type PushDeliveryReport,
  type PushDeviceView,
} from '../../../app/lib/push-delivery.ts';

export const PUSH_INACTIVE_MESSAGE =
  'Closed-app delivery is not active on this device; the app still shows changes while it is open.';

export const DEVICE: PushDeviceView = {
  id: 'push-00000000-0000-4000-8000-000000000000',
  deviceName: 'this browser',
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
  expirationTime: null,
};

/** One device list read: the machine it asked, and how the test answers it. */
export interface ListRead {
  readonly connection: DaemonConnection;
  readonly settle: (devices: readonly PushDeviceView[]) => void;
}

export interface FakeDeliveryOptions {
  /** `false` is a browser that cannot do Web Push: every readout says so and nothing is listed. */
  readonly supported?: boolean;
  /** Device list reads wait for the test (`finish`) instead of answering `[DEVICE]` at once. */
  readonly deferred?: boolean;
  /** This browser's device ids per machine, before the suite starts. */
  readonly remembered?: Readonly<Record<string, string>>;
}

export const fakeDelivery = (options: FakeDeliveryOptions = {}) => {
  const log = { registered: 0, revoked: [] as string[], listed: 0, reads: [] as string[] };
  const ids = new Map<string, string>(Object.entries(options.remembered ?? {}));
  const reads: ListRead[] = [];

  const list = (connection: DaemonConnection): Promise<readonly PushDeviceView[]> => {
    log.listed += 1;
    if (options.deferred !== true) return Promise.resolve([DEVICE]);
    return new Promise(resolve => {
      reads.push({ connection, settle: resolve });
    });
  };

  const unsupported = (connection: DaemonConnection): PushDeliveryReport => ({
    status: 'unavailable',
    message: PUSH_UNSUPPORTED_MESSAGE,
    devices: [],
    currentDeviceId: ids.get(connection.daemonId) ?? null,
  });

  const readout = async (connection: DaemonConnection): Promise<PushDeliveryReport> => {
    const devices = await list(connection);
    const id = ids.get(connection.daemonId) ?? null;
    const active = id !== null && devices.some(device => device.id === id);
    return {
      status: active ? 'active' : 'unavailable',
      message: active ? null : PUSH_INACTIVE_MESSAGE,
      devices,
      currentDeviceId: id,
    };
  };

  const port: PushDeliveryPort = {
    read: async connection => {
      log.reads.push(connection.daemonId);
      return options.supported === false ? unsupported(connection) : await readout(connection);
    },
    enable: async connection => {
      if (options.supported === false) return unsupported(connection);
      log.registered += 1;
      ids.set(connection.daemonId, DEVICE.id);
      const devices = await list(connection);
      return { status: 'active', message: null, devices, currentDeviceId: DEVICE.id };
    },
    disable: async connection => {
      const id = ids.get(connection.daemonId);
      ids.delete(connection.daemonId);
      if (id !== undefined) log.revoked.push(id);
      return options.supported === false ? unsupported(connection) : await readout(connection);
    },
    revoke: async (connection, deviceId) => {
      log.revoked.push(deviceId);
      if (ids.get(connection.daemonId) === deviceId) ids.delete(connection.daemonId);
      return options.supported === false ? unsupported(connection) : await readout(connection);
    },
  };

  return {
    port,
    log,
    /** How many device list reads have started. */
    count: () => reads.length,
    /** The n-th started device list read, still waiting for the test. */
    read: (index: number): ListRead => {
      const read = reads[index];
      if (read === undefined) throw new Error(`no device list read #${index} has been started`);
      return read;
    },
  };
};
