/**
 * THE PER-MACHINE NOTIFICATIONS CONTROLS — one read per paired machine, one enrol/unenrol per machine.
 *
 * `useNotificationControls` is bound to ONE selected daemon. Settings › Notifications and the Attention
 * banner need every paired machine at once, so this hook reads each machine's own device list through the
 * same `DaemonPushService` port and enrols through the same `enablePushDelivery` / `disablePushDelivery`
 * flow — it adds no second enrolment path.
 *
 * Permission is asked only from `enable` / `turnOnAll`, which a reader reaches by a tap. Each machine is
 * read on its own deadline, so one that never answers is "Machine offline" and holds nobody else up.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { MACHINE_READ_DEADLINE_MS, withDeadline } from '../lib/machine-deadline.ts';
import {
  type MachineNotificationFact,
  type MachineNotificationRow,
  type MachinePushReading,
  machineNotificationRows,
  readingFromFailure,
  turnOnAllTargets,
} from '../lib/machine-notifications.ts';
import type { NotificationPermissionState } from '../lib/notify.ts';
import { disablePushDelivery, enablePushDelivery, type PushEnrolmentContext } from '../lib/push-enrolment.ts';
import type { NotificationControlsHost } from './use-notifications.ts';

export interface MachineNotificationSource {
  readonly connection: DaemonConnection;
  readonly label: string;
  /** This browser's local mute for the machine. */
  readonly muted: boolean;
}

export interface MachineNotifications {
  readonly permission: NotificationPermissionState;
  readonly rows: readonly MachineNotificationRow[];
  /** Machines with a switch flip in flight. */
  readonly busy: ReadonlySet<string>;
  /** The reason a machine's last enrolment did not land, by daemon id. */
  readonly failures: Readonly<Record<string, string>>;
  readonly enable: (daemonId: string) => void;
  readonly disable: (daemonId: string) => void;
  /** Enrols every machine that is answering and off. */
  readonly turnOnAll: () => void;
}

const sourcesKey = (sources: readonly MachineNotificationSource[]): string =>
  sources
    .map(({ connection }) => `${connection.daemonId}\u0000${connection.baseUrl}\u0000${connection.deviceId}`)
    .join('\u0001');

export const useMachineNotifications = (
  host: NotificationControlsHost,
  sources: readonly MachineNotificationSource[],
  options: { readonly deadlineMs?: number; readonly onChanged?: () => void } = {},
): MachineNotifications => {
  const { deadlineMs = MACHINE_READ_DEADLINE_MS, onChanged } = options;
  const [permission, setPermission] = useState<NotificationPermissionState>(() => host.surface.permission());
  const [readings, setReadings] = useState<ReadonlyMap<string, MachinePushReading>>(new Map());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});

  // The newest sources, so a late answer for a machine that has since been re-paired is dropped.
  const key = sourcesKey(sources);
  const live = useRef({ key, sources });
  live.current = { key, sources };

  const contextOf = useCallback(
    (connection: DaemonConnection): PushEnrolmentContext => ({
      connection,
      service: host.service,
      devices: host.devices,
      preferences: host.preferences,
      enrolment: host.enrolment,
    }),
    [host],
  );

  const readOne = useCallback(
    async (connection: DaemonConnection, atKey: string): Promise<void> => {
      const reading = await withDeadline(host.service.list(connection), deadlineMs).then(
        (devices): MachinePushReading => ({ kind: 'devices', devices }),
        readingFromFailure,
      );
      if (live.current.key !== atKey) return;
      setReadings(current => new Map(current).set(connection.daemonId, reading));
    },
    [deadlineMs, host.service],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the deliberate re-pair trigger; sources are read through `live`
  useEffect(() => {
    setReadings(new Map());
    for (const source of live.current.sources) void readOne(source.connection, key);
  }, [key, readOne]);

  const setBusyFor = (daemonIds: readonly string[], on: boolean): void =>
    setBusy(current => {
      const next = new Set(current);
      for (const id of daemonIds) on ? next.add(id) : next.delete(id);
      return next;
    });

  const sourceOf = (daemonId: string): MachineNotificationSource | undefined =>
    live.current.sources.find(candidate => candidate.connection.daemonId === daemonId);

  const settle = async (daemonId: string, run: (context: PushEnrolmentContext) => Promise<unknown>): Promise<void> => {
    const source = sourceOf(daemonId);
    if (source === undefined) return;
    const atKey = live.current.key;
    setBusyFor([daemonId], true);
    try {
      await run(contextOf(source.connection));
      await readOne(source.connection, atKey);
    } finally {
      setBusyFor([daemonId], false);
    }
    onChanged?.();
  };

  /** The browser's own permission, asked from a tap and never again once answered. */
  const ensurePermission = async (): Promise<boolean> => {
    const current = host.surface.permission();
    const granted = current === 'default' ? await host.surface.requestPermission() : current;
    setPermission(granted);
    return granted === 'granted';
  };

  const enrol = async (daemonId: string): Promise<void> => {
    await settle(daemonId, async context => {
      const report = await enablePushDelivery(context);
      setFailures(current => {
        const { [daemonId]: _dropped, ...rest } = current;
        return report.status === 'active' || report.message === null ? rest : { ...rest, [daemonId]: report.message };
      });
    });
  };

  const enable = (daemonId: string): void => {
    void (async () => {
      if (!(await ensurePermission())) return;
      await enrol(daemonId);
    })();
  };

  const disable = (daemonId: string): void => {
    void settle(daemonId, disablePushDelivery);
  };

  const facts = useMemo<readonly MachineNotificationFact[]>(
    () =>
      sources.map(({ connection, label, muted }) => ({
        daemonId: connection.daemonId,
        label,
        reading: readings.get(connection.daemonId) ?? null,
        thisDeviceId: host.devices.get(connection.daemonId),
        muted,
      })),
    // The device memory changes without a render of its own; every change is followed by a re-read, which
    // replaces `readings` and so re-derives `thisDeviceId`.
    [sources, readings, host.devices],
  );
  const rows = useMemo(() => machineNotificationRows(facts), [facts]);

  const turnOnAll = (): void => {
    const targets = turnOnAllTargets(rows).map(row => row.daemonId);
    if (targets.length === 0) return;
    void (async () => {
      if (!(await ensurePermission())) return;
      await Promise.allSettled(targets.map(enrol));
    })();
  };

  return { permission, rows, busy, failures, enable, disable, turnOnAll };
};
