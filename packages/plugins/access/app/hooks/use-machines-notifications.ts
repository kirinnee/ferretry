/**
 * EVERY REACHED MACHINE'S NOTIFICATIONS, for the device-level panel (shell contract S4): one read of each machine's own
 * push device list, one enrol / un-enrol per machine, and "turn on all" over the machines that answer and are off.
 *
 * A machine is a SOURCE the panel took from `useEveryDaemon`: its id, label, its OWN client and its lock. Every read and
 * write for a machine goes through that machine's client and no other, and every write runs inside the machine's own
 * `press` (a locked machine asks for its unlock first; a dismissed ask does nothing). It adds no second enrolment path:
 * the one flow in `push-enrolment.ts`. A locked machine is not read (it would only be refused) and shows as locked.
 *
 * Permission is asked only from `enable` / `turnOnAll`, which a reader reaches by a tap, and BEFORE anything is
 * awaited (iOS). Each machine is read on its own deadline, so one that never answers is "Machine offline" and holds
 * nobody else up. Nothing here reads, logs or renders a push endpoint or a subscription key.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PushDeviceView } from '../../contract/index.ts';
import {
  type MachineNotificationFact,
  type MachineNotificationRow,
  type MachinePushReading,
  machineNotificationRows,
  readingFromFailure,
  turnOnAllTargets,
} from '../lib/machine-notifications.ts';
import { clientPushService } from '../lib/push-client-service.ts';
import type { NotificationPermissionState, PushHost } from '../lib/push-host.ts';
import {
  disablePushDelivery,
  enablePushDelivery,
  type PushEnrolmentContext,
  revokePushDevice,
} from '../lib/push-enrolment.ts';
import { daemonId, MACHINE_READ_DEADLINE_MS } from '../shell-pairing.ts';
import { withDeadline } from './use-machine-notification.ts';

/** One reached machine, as the panel got it from `useEveryDaemon`. */
export interface MachineSource {
  readonly daemon: string;
  readonly label: string;
  /** This plugin's OWN client on that machine: the only thing a read or write for it goes through. */
  readonly client: PluginClient;
  /** The machine wants its unlock first (S1). */
  readonly locked: boolean;
  /** As the row's `press`: a locked machine asks for its unlock before the act; a dismissed ask answers `undefined`. */
  readonly press: <T>(act: () => Promise<T>) => Promise<T | undefined>;
  /** The person's explicit unlock. */
  readonly unlock: () => Promise<boolean>;
}

export interface MachinesNotifications {
  readonly permission: NotificationPermissionState;
  readonly rows: readonly MachineNotificationRow[];
  readonly canEnrol: boolean;
  readonly busy: ReadonlySet<string>;
  /** The reason a machine's last enrolment did not land, by daemon id. */
  readonly failures: Readonly<Record<string, string>>;
  /** One machine's registered devices; empty until it answers. */
  readonly devicesOf: (daemon: string) => readonly PushDeviceView[];
  readonly currentDeviceId: (daemon: string) => string | null;
  readonly enable: (daemon: string) => void;
  readonly disable: (daemon: string) => void;
  readonly revokeDevice: (daemon: string, deviceId: string) => void;
  /** Enrols every machine that is answering and off. */
  readonly turnOnAll: () => void;
}

export interface UseMachinesNotificationsInput {
  readonly sources: readonly MachineSource[];
  readonly host: PushHost;
  readonly deadlineMs?: number;
}

/** A client has no identity a key can hold, so the read is repeated when the object itself is replaced. */
const clientIds = new WeakMap<object, number>();
let clientCount = 0;
const clientIdOf = (client: PluginClient): number => {
  const known = clientIds.get(client);
  if (known !== undefined) return known;
  clientCount += 1;
  clientIds.set(client, clientCount);
  return clientCount;
};

const keyOf = (sources: readonly MachineSource[]): string =>
  sources
    .map(({ daemon, locked, client }) => `${daemon}\u0000${locked ? 'locked' : 'open'}\u0000${clientIdOf(client)}`)
    .join('\u0001');

export const useMachinesNotifications = ({
  sources,
  host,
  deadlineMs = MACHINE_READ_DEADLINE_MS,
}: UseMachinesNotificationsInput): MachinesNotifications => {
  const [permission, setPermission] = useState<NotificationPermissionState>(() => host.permission());
  const [readings, setReadings] = useState<ReadonlyMap<string, MachinePushReading>>(new Map());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
  const [, remember] = useState(0);

  // The newest sources, so a late answer for a machine that has since changed its client or lock is dropped.
  const key = keyOf(sources);
  const live = useRef({ key, sources });
  live.current = { key, sources };

  const contextOf = useCallback(
    (source: MachineSource): PushEnrolmentContext => ({
      connection: { daemonId: daemonId(source.daemon) },
      service: clientPushService(source.client),
      devices: host.devices,
      preferences: host.preferences,
      enrolment: host.enrolment(source.label),
    }),
    [host],
  );

  const readOne = useCallback(
    async (source: MachineSource, atKey: string): Promise<void> => {
      const reading = await withDeadline(
        clientPushService(source.client).list({ daemonId: daemonId(source.daemon) }),
        deadlineMs,
      ).then((devices): MachinePushReading => ({ kind: 'devices', devices }), readingFromFailure);
      if (live.current.key !== atKey) return;
      setReadings(current => new Map(current).set(source.daemon, reading));
    },
    [deadlineMs],
  );

  useEffect(() => {
    setReadings(new Map());
    for (const source of live.current.sources) if (!source.locked) void readOne(source, key);
  }, [key, readOne]);

  const sourceOf = (daemon: string): MachineSource | undefined =>
    live.current.sources.find(candidate => candidate.daemon === daemon);

  const setBusyFor = (daemons: readonly string[], on: boolean): void =>
    setBusy(current => {
      const next = new Set(current);
      for (const daemon of daemons) on ? next.add(daemon) : next.delete(daemon);
      return next;
    });

  /** One write for one machine, through THAT machine's press, then a fresh read of that machine. */
  const settle = async (daemon: string, run: (context: PushEnrolmentContext) => Promise<unknown>): Promise<void> => {
    const source = sourceOf(daemon);
    if (source === undefined) return;
    const atKey = live.current.key;
    setBusyFor([daemon], true);
    try {
      const done = await source.press(async () => {
        await run(contextOf(source));
        return true;
      });
      if (done === true) await readOne(source, atKey);
    } finally {
      setBusyFor([daemon], false);
      remember(count => count + 1);
    }
  };

  /** The browser's own permission, asked from a tap and never again once answered. */
  const ensurePermission = async (): Promise<boolean> => {
    const current = host.permission();
    const granted = current === 'default' ? await host.requestPermission() : current;
    setPermission(granted);
    return granted === 'granted';
  };

  const enrol = async (daemon: string): Promise<void> => {
    await settle(daemon, async context => {
      const report = await enablePushDelivery(context);
      setFailures(current => {
        const { [daemon]: _dropped, ...rest } = current;
        return report.status === 'active' || report.message === null ? rest : { ...rest, [daemon]: report.message };
      });
    });
  };

  const enable = (daemon: string): void => {
    void (async () => {
      if (!(await ensurePermission())) return;
      await enrol(daemon);
    })();
  };

  const disable = (daemon: string): void => {
    void settle(daemon, disablePushDelivery);
  };

  const revokeDevice = (daemon: string, deviceId: string): void => {
    void settle(daemon, context => revokePushDevice(context, deviceId));
  };

  const facts = useMemo<readonly MachineNotificationFact[]>(
    () =>
      sources.map(({ daemon, label }) => ({
        daemonId: daemon,
        label,
        reading: readings.get(daemon) ?? null,
        thisDeviceId: host.devices.get(daemonId(daemon)),
        muted: false,
      })),
    // The device memory changes without a render of its own; every change is followed by a re-read, which
    // replaces `readings` and so re-derives `thisDeviceId`.
    [sources, readings, host.devices],
  );
  const rows = useMemo(() => machineNotificationRows(facts), [facts]);

  const turnOnAll = (): void => {
    const locked = new Set(live.current.sources.filter(source => source.locked).map(source => source.daemon));
    const targets = turnOnAllTargets(rows)
      .map(row => row.daemonId)
      .filter(daemon => !locked.has(daemon));
    if (targets.length === 0) return;
    void (async () => {
      if (!(await ensurePermission())) return;
      await Promise.allSettled(targets.map(enrol));
    })();
  };

  return {
    permission,
    rows,
    canEnrol: permission === 'granted' || permission === 'default',
    busy,
    failures,
    devicesOf: daemon => {
      const reading = readings.get(daemon);
      return reading?.kind === 'devices' ? reading.devices : [];
    },
    currentDeviceId: daemon => host.devices.get(daemonId(daemon)),
    enable,
    disable,
    revokeDevice,
    turnOnAll,
  };
};
