/**
 * "A NEW DEVICE WAS PAIRED WITH THIS MACHINE" — told to every other device, in the app itself.
 *
 * Pairing is the one act that changes who can reach a machine, and the person most likely to notice a
 * pairing they did not make is the owner of a device that was already there. So each paired machine's
 * device list is read in the background, and any device added since THIS browser last looked is named,
 * with "That was me" and a one-tap "Remove it" beside it.
 *
 * ## WHAT "SINCE LAST LOOKED" MEANS
 *
 * One instant per machine, kept by `devices-looked.ts`. The FIRST read on a browser that has never
 * looked seeds that instant without announcing anything: every device already paired on the day this
 * notice shipped is not news, and a wall of them would teach people to dismiss the notice unread. The
 * browser's own device is never news either.
 *
 * ## A READ THAT FAILS SAYS NOTHING
 *
 * This is a notice, not a panel: a machine that is unreachable, or that does not let this device read
 * its device list, simply has nothing to announce here. Settings › Add a device is where those reasons
 * are explained, and repeating every outage above every page would bury the one notice that matters.
 */

import { type PairedDevice, type PairedDevicesView, PairedDevicesViewSchema } from '@ferretry/protocol';
import { Check, CircleAlert, ShieldAlert, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DaemonConnectionRecord } from '../../lib/connections.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { devicesPairedSince, lookedInstant, newDeviceNoticeText, removedDeviceText } from '../../lib/security-log.ts';
import {
  type PairingClient,
  pairingFailure,
  readPairedDevices,
  revokePairedDevice,
} from '../settings/add-device-api.ts';
import { daemonDisplayName } from '../settings/daemon-settings.tsx';
import {
  browserDevicesLookedStorage,
  DEVICES_LOOKED_EVENT,
  type DevicesLookedDetail,
  type DevicesLookedStorage,
  markDevicesLooked,
  readDevicesLooked,
} from './devices-looked.ts';

/** The one client capability the notice needs: the app's pool, so every read rides the measured carrier. */
export interface NewDeviceNoticeClients {
  readonly client: (connection: DaemonConnection) => Promise<PairingClient>;
}

/** How often each machine's device list is read again while the app is open. */
export const NEW_DEVICE_REFRESH_MS = 5 * 60_000;

/**
 * Runs `read` again on the refresh cadence, answering how to stop. Injected so a test fires a re-read
 * by hand instead of waiting on a real timer.
 */
export type NewDeviceSchedule = (read: () => void) => () => void;

const everyRefresh: NewDeviceSchedule = read => {
  const timer = setInterval(read, NEW_DEVICE_REFRESH_MS);
  return () => clearInterval(timer);
};

interface Removed {
  readonly device: PairedDevice;
}

interface Failure {
  readonly deviceId: string;
  readonly message: string;
}

function MachineNewDevices({
  connection,
  clients,
  storage,
  now,
  schedule,
}: {
  readonly connection: DaemonConnectionRecord;
  readonly clients: NewDeviceNoticeClients;
  readonly storage: DevicesLookedStorage | undefined;
  readonly now: () => number;
  readonly schedule: NewDeviceSchedule;
}) {
  const daemonId = connection.daemonId;
  const machine = daemonDisplayName(connection);
  const [view, setView] = useState<PairedDevicesView | null>(null);
  const [client, setClient] = useState<PairingClient | null>(null);
  /** This page's own copy of the instant, so the notice works with no storage at all. */
  const [looked, setLooked] = useState<number | null>(() => readDevicesLooked(storage, daemonId));
  /** Devices somebody said "That was me" to, while others on the same machine are still unanswered. */
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(() => new Set());
  const [removed, setRemoved] = useState<Removed | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  /** Whether this page already has an instant for this machine, so the first read seeds rather than announces. */
  const seeded = useRef(looked !== null);

  const mark = useCallback(
    (at: number) => {
      setLooked(at);
      setAcknowledged(new Set());
      markDevicesLooked(storage, daemonId, at);
    },
    [daemonId, storage],
  );

  useEffect(() => {
    let current = true;
    const read = (): void => {
      void clients
        .client(connection)
        .then(async next => {
          // Parsed again HERE because this notice sits above every page: a malformed answer from any
          // one machine must leave the notice silent, never throw during render and take the app down.
          const answer = PairedDevicesViewSchema.parse(await readPairedDevices(next));
          if (!current) return;
          setClient(next);
          setView(answer);
          // First look on this browser: remember now, announce nothing.
          if (!seeded.current) {
            seeded.current = true;
            markDevicesLooked(storage, daemonId, lookedInstant(answer, now()));
          }
        })
        .catch(() => {
          // Nothing to announce; see the module comment.
        });
    };
    read();
    const stop = schedule(read);
    return () => {
      current = false;
      stop();
    };
  }, [clients, connection, daemonId, now, schedule, storage]);

  useEffect(() => {
    const onLooked = (event: Event): void => {
      const detail = (event as CustomEvent<DevicesLookedDetail>).detail;
      if (detail.daemonId !== daemonId) return;
      setLooked(detail.at);
      setAcknowledged(new Set());
    };
    window.addEventListener(DEVICES_LOOKED_EVENT, onLooked);
    return () => window.removeEventListener(DEVICES_LOOKED_EVENT, onLooked);
  }, [daemonId]);

  const fresh =
    view === null || looked === null
      ? []
      : devicesPairedSince(view, looked).filter(device => !acknowledged.has(device.id));

  const thatWasMe = (device: PairedDevice): void => {
    setFailure(null);
    if (fresh.length === 1) {
      mark(lookedInstant(view, now()));
      return;
    }
    setAcknowledged(previous => new Set([...previous, device.id]));
  };

  const removeIt = async (device: PairedDevice): Promise<void> => {
    if (client === null) return;
    setBusy(true);
    setFailure(null);
    try {
      const remaining = PairedDevicesViewSchema.parse(await revokePairedDevice(client, device.id));
      setView(remaining);
      setRemoved({ device });
      if (fresh.length === 1) mark(lookedInstant(remaining, now()));
    } catch (cause) {
      setFailure({ deviceId: device.id, message: pairingFailure(cause).message });
    } finally {
      setBusy(false);
    }
  };

  if (fresh.length === 0 && removed === null) return null;
  return (
    <>
      {removed === null ? null : (
        <div
          role="status"
          data-new-device-removed={removed.device.id}
          className="flex min-w-0 flex-wrap items-center gap-2 rounded-control border border-ok-border bg-ok-bg px-3 py-2 text-ui leading-base text-ok"
        >
          <Check size={14} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 flex-1">{removedDeviceText(removed.device, machine)}</span>
          <button
            type="button"
            className="kt-btn min-h-[44px]"
            data-new-device-dismiss=""
            onClick={() => setRemoved(null)}
          >
            <X size={14} aria-hidden="true" />
            Dismiss
          </button>
        </div>
      )}
      {fresh.map(device => (
        <div
          key={device.id}
          role="status"
          data-new-device={device.id}
          className="flex min-w-0 flex-col gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui leading-base text-warn"
        >
          <p className="m-0 flex min-w-0 items-start gap-2">
            <ShieldAlert size={14} aria-hidden="true" className="mt-1 shrink-0" />
            <span className="min-w-0">{newDeviceNoticeText(device, machine, now())}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="kt-btn min-h-[44px]"
              data-new-device-mine=""
              disabled={busy}
              onClick={() => thatWasMe(device)}
            >
              <Check size={14} aria-hidden="true" />
              That was me
            </button>
            <button
              type="button"
              className="kt-btn min-h-[44px] disabled:cursor-not-allowed disabled:opacity-60"
              data-variant="danger"
              data-new-device-remove=""
              disabled={busy || client === null}
              onClick={() => void removeIt(device)}
            >
              <Trash2 size={14} aria-hidden="true" />
              Remove it
            </button>
          </div>
          {failure?.deviceId === device.id ? (
            <p
              role="alert"
              className="m-0 flex items-start gap-2 text-meta leading-base text-err"
              data-new-device-failure=""
            >
              <CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
              <span className="min-w-0">
                {device.name} could not be removed: {failure.message}
              </span>
            </p>
          ) : null}
        </div>
      ))}
    </>
  );
}

/**
 * Every paired machine's new-device notice, stacked under the app bar.
 *
 * Each machine is its own child keyed by daemon id, so a removal on one machine can never be sent to
 * another and unpairing a machine drops its notice with it.
 */
export function NewDeviceNotices({
  connections,
  clients,
  storage = browserDevicesLookedStorage(),
  now = Date.now,
  schedule = everyRefresh,
}: {
  readonly connections: readonly DaemonConnectionRecord[];
  readonly clients: NewDeviceNoticeClients;
  readonly storage?: DevicesLookedStorage | undefined;
  readonly now?: () => number;
  readonly schedule?: NewDeviceSchedule;
}) {
  if (connections.length === 0) return null;
  return (
    <section
      aria-label="New devices"
      data-new-device-notices=""
      className="flex min-w-0 flex-col gap-2 px-1 empty:hidden sm:px-3 [&:not(:empty)]:pt-2"
    >
      {connections.map(connection => (
        <MachineNewDevices
          key={String(connection.daemonId)}
          connection={connection}
          clients={clients}
          storage={storage}
          now={now}
          schedule={schedule}
        />
      ))}
    </section>
  );
}
