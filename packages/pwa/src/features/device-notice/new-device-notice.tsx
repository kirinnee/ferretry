/**
 * "A NEW DEVICE WAS PAIRED WITH THIS MACHINE" — told to every other device, in the app itself.
 *
 * Pairing is the one act that changes who can reach a machine, and the person most likely to notice a
 * pairing they did not make is the owner of a device that was already there. So each paired machine's
 * device list is read in the background, and any device added since THIS browser last looked is named,
 * with "That was me" and a one-tap "Remove it" beside it.
 *
 * ## WHAT "NOT YET SEEN" MEANS
 *
 * A SET OF DEVICE IDS per machine, kept by `devices-looked.ts` — never an instant, because comparing a
 * browser instant with the daemon's `createdAt` lets a skewed clock hide exactly the device that matters.
 * The FIRST read on a browser that has never looked seeds the set with every device paired more than a
 * day before the newest one on the list, measured on the DAEMON's clock: a wall of long-standing devices
 * would teach people to dismiss the notice unread, but a pairing from this morning is still news. The
 * browser's own device is never news.
 *
 * ## A READ THAT FAILS SAYS NOTHING
 *
 * This is a notice, not a panel: a machine that is unreachable, or that does not let this device read
 * its device list, simply has nothing to announce here. Settings › Devices is where those reasons
 * are explained, and repeating every outage above every page would bury the one notice that matters.
 *
 * ## ON A PHONE IT IS ONE LINE
 *
 * The full notice is a sentence and two 44px buttons: about 170px, a fifth of a phone, pinned above every
 * page and above the composer while the keyboard is up. At drawer widths each device is one row naming it
 * with a Review button, and the same sentence and actions open in a bottom sheet. While the keyboard is up
 * the row is hidden (`data-kb-hide`) and its sheet closed, so it never sits over what is being typed.
 */

import { type PairedDevice, type PairedDevicesView, PairedDevicesViewSchema } from '@ferretry/protocol';
import { Check, CircleAlert, ShieldAlert, Trash2, X } from 'lucide-react';
import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react';

import { useKeyboardOpen } from '../../hooks/use-keyboard-open.ts';
import { useLayoutMode } from '../../hooks/use-layout-mode.ts';

import type { DaemonConnectionRecord } from '../../lib/connections.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { whileVisible } from '../../lib/feed-aware-poll.ts';
import {
  allSeen,
  deviceLabel,
  devicesNotSeen,
  firstLookSeen,
  newDeviceNoticeText,
  removedDeviceText,
} from '../../lib/security-log.ts';
import {
  type PairingClient,
  pairingFailure,
  readPairedDevices,
  revokePairedDevice,
} from '../settings/add-device-api.ts';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import { daemonDisplayName } from '../settings/daemon-settings.tsx';
import {
  browserDevicesLookedStorage,
  DEVICES_LOOKED_EVENT,
  type DevicesLookedDetail,
  type DevicesLookedStorage,
  readDevicesSeen,
  rememberDevicesSeen,
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

/** A hidden app skips its turn: nobody is there to be told, and the next visible turn reads. */
const everyRefresh: NewDeviceSchedule = read => {
  const timer = setInterval(whileVisible(read), NEW_DEVICE_REFRESH_MS);
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
  compact,
}: {
  readonly connection: DaemonConnectionRecord;
  readonly clients: NewDeviceNoticeClients;
  readonly storage: DevicesLookedStorage | undefined;
  readonly now: () => number;
  readonly schedule: NewDeviceSchedule;
  readonly compact: boolean;
}) {
  const daemonId = connection.daemonId;
  const machine = daemonDisplayName(connection);
  const [view, setView] = useState<PairedDevicesView | null>(null);
  const [client, setClient] = useState<PairingClient | null>(null);
  /** This page's own copy of the set, so the notice works with no storage at all. */
  const [seen, setSeen] = useState<ReadonlySet<string> | null>(() => readDevicesSeen(storage, daemonId));
  const [removed, setRemoved] = useState<Removed | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  /** The device whose notice is open in the phone's sheet. */
  const [reviewing, setReviewing] = useState<string | null>(null);
  const sheetId = useId();
  const keyboardOpen = useKeyboardOpen();
  useEffect(() => {
    if (keyboardOpen) setReviewing(null);
  }, [keyboardOpen]);
  /** The latest list, for a look announced by a panel that never read it. */
  const latest = useRef<PairedDevicesView | null>(null);
  /** The set as last remembered, so a look can add to it without waiting for a render. */
  const seenNow = useRef(seen);
  seenNow.current = seen;

  const remember = useCallback(
    (next: ReadonlySet<string>) => {
      setSeen(next);
      rememberDevicesSeen(storage, daemonId, next);
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
          latest.current = answer;
          setClient(next);
          setView(answer);
          // First look on this browser: everything but the recently paired is already seen. Held here
          // as well as stored, so this machine's own notice never depends on storage working.
          setSeen(previous => {
            if (previous !== null) return previous;
            const seeded = firstLookSeen(answer);
            rememberDevicesSeen(storage, daemonId, seeded);
            return seeded;
          });
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
  }, [clients, connection, daemonId, schedule, storage]);

  useEffect(() => {
    const onLooked = (event: Event): void => {
      const detail = (event as CustomEvent<DevicesLookedDetail>).detail;
      if (detail.daemonId !== daemonId) return;
      // Only what the panel actually SHOWED is marked, and only devices this notice has read: a device
      // whose pairing was not on screen, or paired after the last read, is still unseen.
      if (latest.current === null) return;
      const listed = allSeen(latest.current);
      const shown = detail.deviceIds.filter(id => listed.has(id));
      if (shown.length > 0) remember(new Set([...(seenNow.current ?? []), ...shown]));
    };
    window.addEventListener(DEVICES_LOOKED_EVENT, onLooked);
    return () => window.removeEventListener(DEVICES_LOOKED_EVENT, onLooked);
  }, [daemonId, remember]);

  const fresh = view === null || seen === null ? [] : devicesNotSeen(view, seen);

  const thatWasMe = (device: PairedDevice): void => {
    setFailure(null);
    remember(new Set([...(seen ?? []), device.id]));
  };

  const removeIt = async (device: PairedDevice): Promise<void> => {
    if (client === null) return;
    setBusy(true);
    setFailure(null);
    try {
      const remaining = PairedDevicesViewSchema.parse(await revokePairedDevice(client, device.id));
      latest.current = remaining;
      setView(remaining);
      setRemoved({ device });
      // A removed id is gone from the list, so it needs no entry: dropping ids the list no longer has
      // keeps the stored set bounded by the devices that exist.
      remember(new Set([...(seen ?? [])].filter(id => remaining.devices.some(entry => entry.id === id))));
    } catch (cause) {
      setFailure({ deviceId: device.id, message: pairingFailure(cause).message });
    } finally {
      setBusy(false);
    }
  };

  /** The sentence, the two actions and a failed removal: the inline card's body and the phone sheet's. */
  const details = (device: PairedDevice) => (
    <>
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
            {deviceLabel(device)} could not be removed: {failure.message}
          </span>
        </p>
      ) : null}
    </>
  );

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
      {fresh.map(device =>
        compact ? (
          <Fragment key={device.id}>
            <div
              role="status"
              data-new-device={device.id}
              data-new-device-compact=""
              data-kb-hide=""
              className="flex min-w-0 items-center gap-2 rounded-control border border-warn-border bg-warn-bg py-0.5 pl-3 pr-0.5 text-meta leading-base text-warn"
            >
              <ShieldAlert size={14} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">New device paired: “{device.name}”</span>
              <button
                type="button"
                className="kt-btn min-h-[44px] shrink-0"
                data-new-device-review=""
                aria-haspopup="dialog"
                aria-controls={`${sheetId}-${device.id}`}
                onClick={() => setReviewing(device.id)}
              >
                Review
              </button>
            </div>
            <BottomSheet
              id={`${sheetId}-${device.id}`}
              open={reviewing === device.id}
              onClose={() => setReviewing(null)}
              labelledBy={`${sheetId}-${device.id}-title`}
              closeLabel="Dismiss the new device notice"
              panelClassName="px-panel pb-panel"
            >
              <div className="flex min-w-0 flex-col gap-2 pb-md text-ui leading-base text-fg">
                <h2 id={`${sheetId}-${device.id}-title`} className="m-0 text-title font-semibold text-warn">
                  New device paired
                </h2>
                {details(device)}
              </div>
            </BottomSheet>
          </Fragment>
        ) : (
          <div
            key={device.id}
            role="status"
            data-new-device={device.id}
            className="flex min-w-0 flex-col gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui leading-base text-warn"
          >
            {details(device)}
          </div>
        ),
      )}
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
  const compact = useLayoutMode() === 'drawer';
  if (connections.length === 0) return null;
  return (
    <section
      aria-label="New devices"
      data-new-device-notices=""
      className="flex min-w-0 flex-col gap-2 px-4 empty:hidden sm:px-3 [&:not(:empty)]:pt-2"
    >
      {connections.map(connection => (
        <MachineNewDevices
          key={String(connection.daemonId)}
          connection={connection}
          clients={clients}
          storage={storage}
          now={now}
          schedule={schedule}
          compact={compact}
        />
      ))}
    </section>
  );
}
