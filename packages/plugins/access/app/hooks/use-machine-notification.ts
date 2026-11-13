/**
 * THIS MACHINE'S NOTIFICATIONS: one read of its own push device list, one enrol / un-enrol, through the one enrolment
 * flow in `push-enrolment.ts` (this adds no second path).
 *
 * The half is built per machine against that machine's client, so the hook is about exactly one machine. Permission is
 * asked only from `enable`, which a reader reaches by a tap and never from an effect; a machine that never answers is
 * "Machine offline" after a deadline and holds nothing else up. Nothing here reads, logs or renders a push endpoint or
 * a subscription key: the screens see device names and ids only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PushDeviceView } from '../../contract/index.ts';
import {
  type MachineNotificationRow,
  type MachinePushReading,
  machineNotificationRows,
  readingFromFailure,
} from '../lib/machine-notifications.ts';
import type { NotificationPermissionState, PushHost } from '../lib/push-host.ts';
import {
  disablePushDelivery,
  type DaemonPushService,
  enablePushDelivery,
  type PushEnrolmentContext,
  revokePushDevice,
} from '../lib/push-enrolment.ts';
import { daemonId, MACHINE_READ_DEADLINE_MS } from '../shell-pairing.ts';

export interface MachineNotification {
  readonly permission: NotificationPermissionState;
  /** Always one row: this machine. */
  readonly rows: readonly MachineNotificationRow[];
  /** The machines' registered devices, for the revoke list; empty until the machine answers. */
  readonly devices: readonly PushDeviceView[];
  readonly currentDeviceId: string | null;
  readonly busy: ReadonlySet<string>;
  /** The reason the last enrolment did not land, by machine id. */
  readonly failures: Readonly<Record<string, string>>;
  readonly canEnrol: boolean;
  readonly enable: () => void;
  readonly disable: () => void;
  readonly revokeDevice: (deviceId: string) => void;
}

export const withDeadline = <T>(read: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the machine did not answer in time')), ms);
    read.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

export interface UseMachineNotificationInput {
  /** The machine's id, from the client the half was built with. */
  readonly daemon: string;
  readonly label: string;
  readonly service: DaemonPushService;
  readonly host: PushHost;
  readonly deadlineMs?: number;
}

export const useMachineNotification = ({
  daemon,
  label,
  service,
  host,
  deadlineMs = MACHINE_READ_DEADLINE_MS,
}: UseMachineNotificationInput): MachineNotification => {
  const id = useMemo(() => daemonId(daemon), [daemon]);
  const [permission, setPermission] = useState<NotificationPermissionState>(() => host.permission());
  const [reading, setReading] = useState<MachinePushReading | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [, remember] = useState(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const context = useCallback(
    (): PushEnrolmentContext => ({
      connection: { daemonId: id },
      service,
      devices: host.devices,
      preferences: host.preferences,
      enrolment: host.enrolment(label),
    }),
    [id, service, host, label],
  );

  const read = useCallback(async (): Promise<void> => {
    const next = await withDeadline(service.list({ daemonId: id }), deadlineMs).then(
      (devices): MachinePushReading => ({ kind: 'devices', devices }),
      readingFromFailure,
    );
    if (live.current) setReading(next);
  }, [service, id, deadlineMs]);

  useEffect(() => {
    setReading(null);
    void read();
  }, [read]);

  const settle = async (run: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await run();
      await read();
    } finally {
      if (live.current) {
        setBusy(false);
        remember(count => count + 1);
      }
    }
  };

  const enable = (): void => {
    void (async () => {
      const current = host.permission();
      const granted = current === 'default' ? await host.requestPermission() : current;
      setPermission(granted);
      if (granted !== 'granted') return;
      await settle(async () => {
        const report = await enablePushDelivery(context());
        if (live.current) setFailure(report.status === 'active' ? undefined : (report.message ?? undefined));
      });
    })();
  };

  const disable = (): void => {
    void settle(() => disablePushDelivery(context()));
  };

  const revokeDevice = (deviceId: string): void => {
    void settle(() => revokePushDevice(context(), deviceId));
  };

  const thisDeviceId = host.devices.get(id);
  const rows = useMemo(
    () => machineNotificationRows([{ daemonId: daemon, label, reading, thisDeviceId, muted: false }]),
    [daemon, label, reading, thisDeviceId],
  );
  return {
    permission,
    rows,
    devices: reading?.kind === 'devices' ? reading.devices : [],
    currentDeviceId: thisDeviceId,
    busy: busy ? new Set([daemon]) : new Set(),
    failures: failure === undefined ? {} : { [daemon]: failure },
    canEnrol: permission === 'granted' || permission === 'default',
    enable,
    disable,
    revokeDevice,
  };
};
