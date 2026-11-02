/**
 * PAIRING A PHONE FROM THE MACHINE MENU — a second door into the one Add-a-device surface.
 *
 * Minting a code for another device used to live only at Settings › ‹machine› › Devices. The act
 * belongs to one machine, and the machine switcher at the top of the sessions bar is already "the
 * machine" menu, so it carries the entry too (and the finder offers the same act). Both open THIS
 * wrapper, which renders the existing `AddDeviceSurface` unchanged: the QR, the passkey prompt the
 * carrier raises for a mint, and the device list behave exactly as they do in Settings, because they
 * are the same component handed the same connection.
 *
 * ## WHAT THIS FILE ADDS, AND NOTHING MORE
 *
 *   - A frame: a bottom sheet on a phone, a centred dialog everywhere else, each modal with Escape,
 *     focus-in, focus-back and a Tab trap from the app's one dialog hook.
 *   - The question of whether to offer the entry at all, read from the daemon's own grants view. A
 *     caller whose `pairing.use` is closed is not offered a door that opens onto a refusal; a caller who
 *     only needs a passkey confirmation IS offered it, because that confirmation is asked on the spot.
 *
 * ## THE CODE NEVER PASSES THROUGH HERE
 *
 * The minted code is `AddDeviceSurface`'s component state and dies with it (`docs/pairing.md`). This
 * frame holds no copy, logs nothing, writes nothing to a URL or store, and announces nothing: closing the
 * sheet unmounts the surface, which is the same "closing the panel ends it" rule Settings keeps.
 */

import type { GrantsView } from '@ferretry/protocol';
import { QrCode, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useDialogFocus } from '../../hooks/use-dialog-focus.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useDaemonClient } from '../../lib/store.tsx';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import { AddDeviceSurface, type PairingClientFactory, type PairingClock } from './add-device-settings.tsx';
import { type GrantClient, readGrants } from './grants-api.ts';

/** The act, worded so it cannot be mistaken for "Add a machine" sitting beside it. */
export const pairPhoneLabel = (machineName: string): string => `Pair a phone with ${machineName}`;

/** What the act does, for the finder row and the frame's own subtitle. */
export const PAIR_PHONE_DESCRIPTION =
  'Show a QR code another phone or browser scans to reach this machine. Revoke devices in Settings › Devices.';

/**
 * Whether this caller may be offered the act at all.
 *
 * Open when `pairing.use` is open, or when the only thing standing between the caller and it is a
 * passkey confirmation — that is asked for at the mint, so hiding the entry would hide a door that does
 * open. Every other refusal (switched off, not granted to this device, a document the daemon cannot
 * read) closes it, and so does a view that does not mention pairing.
 */
export function mayPairPhone(view: GrantsView): boolean {
  const entry = view.capabilities.find(candidate => candidate.capability === 'pairing');
  if (entry === undefined) return false;
  return entry.use || entry.useRefusal === 'step-up-required';
}

export type PairingGrantsClientFactory = (connection: DaemonConnection) => Promise<GrantClient>;

/**
 * Asks this machine, once per machine, whether the reader may pair a phone with it.
 *
 * KEYED BY THE MACHINE. An answer read for one daemon is never returned for another: switching machines
 * reads false until the new one has answered. A read that fails reads false too — the entry is a
 * shortcut, Settings › Devices is still there and explains whatever went wrong in full.
 */
export function usePairPhoneAllowed(
  connection: DaemonConnection | undefined,
  createClient?: PairingGrantsClientFactory,
): boolean {
  const routedClient = useDaemonClient();
  const factory = createClient ?? routedClient;
  const daemonId = connection?.daemonId;
  // The connection object can be re-created for the same machine (a refreshed snapshot); the read is
  // keyed by the machine's id, so the latest object is read through a ref rather than re-triggering it.
  const latest = useRef(connection);
  latest.current = connection;
  const [answer, setAnswer] = useState<{ readonly daemonId: string; readonly allowed: boolean } | null>(null);
  useEffect(() => {
    const target = latest.current;
    if (daemonId === undefined || target === undefined) return;
    let live = true;
    void factory(target)
      .then(async client => mayPairPhone(await readGrants(client)))
      .catch(() => false)
      .then(allowed => {
        if (live) setAnswer({ daemonId, allowed });
      });
    return () => {
      live = false;
    };
  }, [daemonId, factory]);
  return answer !== null && answer.daemonId === daemonId && answer.allowed;
}

export type PairPhonePresentation = 'sheet' | 'dialog';

export interface PairPhoneSheetProps {
  readonly connection: DaemonConnection;
  readonly machineName: string;
  readonly open: boolean;
  readonly presentation: PairPhonePresentation;
  readonly onClose: () => void;
  /** The harness and tests hand in a pairing client; the app uses the carrier-routed one. */
  readonly createClient?: PairingClientFactory;
  readonly now?: PairingClock;
}

function Heading({ id, machineName }: { readonly id: string; readonly machineName: string }) {
  return (
    <div className="flex min-w-0 items-center gap-sm">
      <QrCode aria-hidden="true" className="shrink-0 text-accent" size={16} />
      <h2 id={id} className="m-0 min-w-0 truncate font-display text-title font-semibold tracking-display text-fg">
        {pairPhoneLabel(machineName)}
      </h2>
    </div>
  );
}

function Body({ connection, createClient, now }: Pick<PairPhoneSheetProps, 'connection' | 'createClient' | 'now'>) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-4 pt-3" data-pair-phone-body="">
      <AddDeviceSurface connection={connection} {...(createClient ? { createClient } : {})} {...(now ? { now } : {})} />
    </div>
  );
}

/** The centred frame, for every layout but a phone. */
function PairPhoneDialog(props: PairPhoneSheetProps) {
  const { open, onClose, machineName } = props;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const { onKeyDown } = useDialogFocus(open, dialogRef, onClose);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim p-2"
      data-pair-phone="dialog"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Close pairing"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="kt-panel relative flex max-h-[min(86dvh,820px)] w-full max-w-2xl flex-col overflow-hidden p-0 shadow-popover focus:outline-none"
      >
        <header className="flex min-w-0 items-start gap-sm border-b border-border-soft px-panel py-3">
          <div className="min-w-0 flex-1">
            <Heading id={titleId} machineName={machineName} />
            <p className="mb-0 mt-1 text-ui leading-base text-muted">{PAIR_PHONE_DESCRIPTION}</p>
          </div>
          <button
            type="button"
            aria-label="Close pairing"
            className="kt-btn h-9 w-9 shrink-0 p-0"
            data-pair-phone-close=""
            onClick={onClose}
          >
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <Body connection={props.connection} createClient={props.createClient} now={props.now} />
      </div>
    </div>
  );
}

/**
 * The phone's frame: the app's one bottom sheet, which owns the swipe, the handle and the dialog hook.
 * The surface mounts only while the sheet is open, so its code dies the moment the sheet is dismissed.
 */
function PairPhoneBottomSheet(props: PairPhoneSheetProps) {
  const { open, onClose, machineName } = props;
  const titleId = useId();
  return (
    <BottomSheet
      id="pair-phone"
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      closeLabel="Close pairing"
      panelClassName="kt-details bg-surface"
      maxHeight="min(90dvh, calc(var(--app-h, 100dvh) - var(--gap-xs)))"
      zIndexClass="z-50"
    >
      <div className="shrink-0 border-b border-border-soft px-panel pb-row-y" data-pair-phone="sheet">
        <Heading id={titleId} machineName={machineName} />
        <p className="mb-0 mt-1 text-ui leading-base text-muted">{PAIR_PHONE_DESCRIPTION}</p>
      </div>
      {open ? <Body connection={props.connection} createClient={props.createClient} now={props.now} /> : null}
    </BottomSheet>
  );
}

/** "Pair a phone with ‹machine›": the Add-a-device surface, in a sheet on a phone and a dialog elsewhere. */
export function PairPhoneSheet(props: PairPhoneSheetProps) {
  return props.presentation === 'sheet' ? <PairPhoneBottomSheet {...props} /> : <PairPhoneDialog {...props} />;
}
