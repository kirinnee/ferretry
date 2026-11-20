/**
 * ADDING A DEVICE TO ONE DAEMON, from the browser.
 *
 * ## EVERYTHING HERE BELONGS TO ONE MACHINE
 *
 * The panel is handed a `DaemonConnection` and every read, mint and revoke goes through it. A code minted
 * for daemon A is never shown under daemon B, and the device list is scoped the same way: switching hosts
 * drops the code, the list and any failure, because the alternative is somebody revoking a device on the
 * wrong machine while looking at a list they trust.
 *
 * ## THE CODE LIVES IN MEMORY AND DIES HERE
 *
 * A minted code is component state. It is never written to any store, `localStorage`, URL or log — closing
 * the panel, switching daemons or pressing Done ends it, and nothing can read it back afterwards. The QR
 * is computed in this tab from that state, so the credential reaches no third party either. This is why
 * the harness screenshots use a fixed fake code: a committed PNG of a real one would be a real leak.
 *
 * ## MINTING A CODE ASKS FOR A PASSKEY, NEVER A PASSWORD
 *
 * Handing another device access is a dangerous act, so a governed browser confirms it with its passkey.
 * The carrier asks for that by itself when the daemon refuses and sends the mint again, so this panel
 * has nothing to pre-check: it offers the button, and whatever the machine answers is rendered whole.
 * A browser on the machine itself is asked like any other: only the CLI is the owner at the machine.
 *
 * ## A REFUSAL IS EXPLAINED, NEVER GREYED
 *
 * A browser whose operator has switched `pairing` off cannot read this panel at all — the routes are
 * governed, a browser on the machine itself included. That refusal is rendered as the daemon's own
 * sentence, which names the command that changes it. A greyed button with no explanation is the dead end
 * this product keeps removing.
 */

import { ConfirmToSee, STEP_UP_REFUSAL_CODE, Loading } from '@ferretry/app/ui';
import { Plus } from 'lucide-react';
import { PanelSlot, SettingGroup, SettingRow } from '@ferretry/app';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { DEVICE_NOTE_SLOT } from './device-note-slot.ts';
import type { DeviceGrantsPatch, PairedDevicesView, PairingCodeMintResponse } from '../../../contract/index.ts';
import { type DaemonConnection, useDaemonClient } from '../../shell-pairing.ts';
import {
  orderedPairedDevices,
  PAIRING_EXPIRY_NOTE,
  PAIRING_TICK_MS,
  pairingCountdown,
  pairingRefusal,
} from '../../lib/pairing-invite.ts';
import { usePairingScreenMarker } from '../../lib/pairing-screen-marker.ts';
import {
  changeDeviceGrants,
  mintPairingCode,
  type PairingClient,
  type PairingFailure,
  pairingFailure,
  readPairedDevices,
  revokePairedDevice,
  revokePairingCode,
} from './add-device-api.ts';
import { AccessTab, StateBlock } from './access-kit.tsx';
import { FailureNotice, InvitePanel } from './invite-panel.tsx';
import { PairedDeviceRow } from './paired-device-row.tsx';

/** The invite, as this screen holds it: the daemon it belongs to, and what the daemon answered. */
interface HeldInvite {
  readonly daemonId: DaemonConnection['daemonId'];
  readonly minted: PairingCodeMintResponse;
}

export interface AddDeviceCardProps {
  readonly connection: DaemonConnection;
  readonly view: PairedDevicesView;
  /** The live invite, when one has been minted in this panel. */
  readonly invite: PairingCodeMintResponse | null;
  /** Now, supplied rather than read, so the countdown is deterministic in a test and a screenshot. */
  readonly nowMs: number;
  readonly busy?: boolean;
  readonly failure?: PairingFailure | null;
  /** A refusal of a per-device grant change, shown on the device it was for. */
  readonly grantFailure?: { readonly deviceId: string; readonly failure: PairingFailure } | null;
  /** The host's command name in remedies; the product's binary, threaded rather than spelled here. */
  readonly clientName?: string;
  /** Which device's capabilities start open — for a screenshot or a deep link, never persisted. */
  readonly capabilitiesOpenFor?: string | undefined;
  /** Drawn under a device's revoke (the standing rules its passkey approved), when the machine offers them. */
  readonly deviceNote?: ((deviceId: string) => ReactNode) | undefined;
  readonly onMint: () => void;
  readonly onDiscardInvite: () => void;
  readonly onRevokeCode: () => void;
  readonly onRevokeDevice: (deviceId: string) => void;
  readonly onChangeDeviceGrants: (deviceId: string, patch: DeviceGrantsPatch) => void;
}

/**
 * The render-only panel.
 *
 * It takes the view and reports intent; it fetches nothing and holds no connection state, so the same
 * component is what the harness screenshots and what a test drives.
 */
export function AddDeviceCard({
  connection,
  view,
  invite,
  nowMs,
  busy = false,
  failure = null,
  grantFailure = null,
  clientName = 'fy',
  capabilitiesOpenFor,
  deviceNote,
  onMint,
  onDiscardInvite,
  onRevokeCode,
  onRevokeDevice,
  onChangeDeviceGrants,
}: AddDeviceCardProps) {
  const devices = orderedPairedDevices(view);
  const countdown = invite === null ? null : pairingCountdown(invite.expiresAt, nowMs);
  // The code, its link and its QR are on screen from the mint until it runs out or is cleared (docs/pairing.md).
  usePairingScreenMarker(invite !== null && countdown !== null && !countdown.expired);

  return (
    <AccessTab name="devices">
      <div data-add-device-surface={String(connection.daemonId)}>
        <SettingGroup label="Add a device">
          <SettingRow
            name="Add a device"
            hint={
              invite === null ? 'Works once, for two minutes.' : 'Read the code below on the device you are adding.'
            }
            explanation={`${PAIRING_EXPIRY_NOTE} A device is added by reading a code this machine mints, so a phone that reads it becomes a device you can see and revoke below.`}
            control={() =>
              invite === null ? (
                <button
                  type="button"
                  disabled={busy}
                  data-pair-mint=""
                  onClick={onMint}
                  className="kt-btn min-h-[44px] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Plus size={15} aria-hidden="true" />
                  Add a device
                </button>
              ) : null
            }
          >
            {invite !== null && countdown !== null ? (
              <InvitePanel
                invite={invite}
                countdown={countdown}
                busy={busy}
                onRevokeCode={onRevokeCode}
                onDiscardInvite={onDiscardInvite}
              />
            ) : null}
          </SettingRow>
        </SettingGroup>

        <SettingGroup
          label={
            devices.length === 0
              ? 'Paired devices'
              : `${String(devices.length)} device${devices.length === 1 ? '' : 's'} may reach this machine`
          }
        >
          {devices.length === 0 ? (
            <SettingRow
              name="No devices are paired to this machine"
              hint="No paired device can reach this daemon yet. Adding a device is how that changes, and every device you add appears here with its own revoke."
            />
          ) : (
            devices.map(device => (
              <PairedDeviceRow
                key={device.id}
                device={device}
                view={view}
                busy={busy}
                clientName={clientName}
                grantFailure={grantFailure?.deviceId === device.id ? grantFailure.failure : null}
                initiallyOpen={capabilitiesOpenFor === device.id}
                note={deviceNote?.(device.id)}
                onRevoke={() => onRevokeDevice(device.id)}
                onChangeGrants={patch => onChangeDeviceGrants(device.id, patch)}
              />
            ))
          )}
        </SettingGroup>

        {failure === null ? null : <FailureNotice message={failure.message} marks={{ 'data-pair-failure': '' }} />}
      </div>
    </AccessTab>
  );
}

export type PairingClientFactory = (connection: DaemonConnection) => Promise<PairingClient>;
/** Now, injected, so nothing in this surface reads a clock a test cannot move. */
export type PairingClock = () => number;

/**
 * The live, daemon-bound Add-a-device surface.
 *
 * A FAILED READ IS NOT AN EMPTY MACHINE. A list this browser could not fetch renders as a stated reason,
 * never as "no devices are paired" — a person shown an empty list over a daemon the browser could not
 * reach would conclude their phone had been unpaired, which is exactly wrong.
 */
export function AddDeviceSurface({
  connection,
  createClient: injectedClient,
  now = Date.now,
}: {
  readonly connection: DaemonConnection;
  readonly createClient?: PairingClientFactory;
  readonly now?: PairingClock;
}) {
  // The carrier-routed client unless a test or the harness hands one in: a plain-network client
  // reaches no daemon at all, because a paired browser is answered only inside its own session.
  const routedClient = useDaemonClient();
  const createClient = injectedClient ?? routedClient;
  const [client, setClient] = useState<PairingClient | null>(null);
  const [loaded, setLoaded] = useState<{
    readonly daemonId: DaemonConnection['daemonId'];
    readonly view: PairedDevicesView;
  } | null>(null);
  const [loadFailure, setLoadFailure] = useState<{
    readonly daemonId: DaemonConnection['daemonId'];
    readonly failure: PairingFailure;
  } | null>(null);
  const [invite, setInvite] = useState<HeldInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PairingFailure | null>(null);
  const [grantFailure, setGrantFailure] = useState<{
    readonly deviceId: string;
    readonly failure: PairingFailure;
  } | null>(null);
  const [nowMs, setNowMs] = useState(() => now());
  /** How many times the owner pressed "Confirm it's you to see this"; the read after a press is theirs. */
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let current = true;
    setClient(null);
    setLoaded(null);
    setLoadFailure(null);
    setFailure(null);
    setGrantFailure(null);
    // The code belongs to the daemon that minted it, so switching machines drops it rather than carrying a
    // live credential across the boundary everything else here is keyed by.
    setInvite(null);
    void createClient(connection)
      .then(async next => {
        const view = await readPairedDevices(next, reads > 0);
        if (!current) return;
        setClient(next);
        setLoaded({ daemonId: connection.daemonId, view });
      })
      .catch((cause: unknown) => {
        if (current) setLoadFailure({ daemonId: connection.daemonId, failure: pairingFailure(cause) });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient, reads]);

  /**
   * The countdown's clock, running ONLY while a code is on screen.
   *
   * A panel with no live code has nothing to count, and a timer left running would re-render the device
   * list once a second for the rest of the session. The interval is cleared by the same effect that owns
   * it, so closing the panel or discarding the code stops it.
   */
  useEffect(() => {
    if (invite === null) return;
    setNowMs(now());
    const timer = setInterval(() => setNowMs(now()), PAIRING_TICK_MS);
    return () => clearInterval(timer);
  }, [invite, now]);

  const mint = useCallback(async () => {
    if (client === null || loaded?.daemonId !== connection.daemonId) return;
    setBusy(true);
    setFailure(null);
    try {
      setInvite({ daemonId: connection.daemonId, minted: await mintPairingCode(client) });
    } catch (cause) {
      setFailure(pairingFailure(cause));
    } finally {
      setBusy(false);
    }
  }, [client, connection.daemonId, loaded?.daemonId]);

  const revokeCode = useCallback(async () => {
    const held = invite;
    if (client === null || held === null || held.daemonId !== connection.daemonId) return;
    setBusy(true);
    setFailure(null);
    try {
      await revokePairingCode(client, held.minted.pairingId);
      // Cleared on success only: a code this browser failed to revoke is still live on the machine, and
      // hiding it would tell somebody a door was shut when it is open.
      setInvite(null);
    } catch (cause) {
      setFailure(pairingFailure(cause));
    } finally {
      setBusy(false);
    }
  }, [client, connection.daemonId, invite]);

  const revokeDevice = useCallback(
    async (deviceId: string) => {
      if (client === null || loaded?.daemonId !== connection.daemonId) return;
      setBusy(true);
      setFailure(null);
      try {
        setLoaded({ daemonId: connection.daemonId, view: await revokePairedDevice(client, deviceId) });
      } catch (cause) {
        setFailure(pairingFailure(cause));
      } finally {
        setBusy(false);
      }
    },
    [client, connection.daemonId, loaded?.daemonId],
  );

  const changeGrants = useCallback(
    async (deviceId: string, patch: DeviceGrantsPatch) => {
      if (client === null || loaded?.daemonId !== connection.daemonId) return;
      setBusy(true);
      setFailure(null);
      setGrantFailure(null);
      try {
        // The view the daemon answers with is what gets rendered: a toggle that guessed the new state is
        // how a refused widen reads as granted.
        setLoaded({ daemonId: connection.daemonId, view: await changeDeviceGrants(client, deviceId, patch) });
      } catch (cause) {
        setGrantFailure({ deviceId, failure: pairingFailure(cause) });
      } finally {
        setBusy(false);
      }
    },
    [client, connection.daemonId, loaded?.daemonId],
  );

  if (loaded?.daemonId === connection.daemonId)
    return (
      <AddDeviceCard
        connection={connection}
        view={loaded.view}
        invite={invite?.daemonId === connection.daemonId ? invite.minted : null}
        nowMs={nowMs}
        busy={busy}
        failure={failure}
        grantFailure={grantFailure}
        // What else revoking a device does is said by whatever plugin places a panel here (Accounts: how many standing
        // sign-in rules its passkey approved); a panel with nothing to say draws nothing, and none placed shows no note.
        deviceNote={deviceId => (
          <PanelSlot daemon={String(connection.daemonId)} slot={DEVICE_NOTE_SLOT} subject={deviceId} />
        )}
        onMint={() => void mint()}
        onDiscardInvite={() => setInvite(null)}
        onRevokeCode={() => void revokeCode()}
        onRevokeDevice={deviceId => void revokeDevice(deviceId)}
        onChangeDeviceGrants={(deviceId, patch) => void changeGrants(deviceId, patch)}
      />
    );
  if (loadFailure?.daemonId === connection.daemonId && loadFailure.failure.code === STEP_UP_REFUSAL_CODE)
    return (
      <StateBlock title="Devices" label="Devices need your passkey">
        <ConfirmToSee
          line="This machine wants your passkey before it shows which devices may reach it."
          onConfirm={() => setReads(n => n + 1)}
        />
      </StateBlock>
    );
  if (loadFailure?.daemonId === connection.daemonId)
    return (
      <StateBlock title="Adding a device is unavailable here" label="Adding a device unavailable">
        <p className="fy-acc-fine" data-pair-refusal="">
          {pairingRefusal(loadFailure.failure.message)}
        </p>
      </StateBlock>
    );
  return <Loading kind="page" label="Reading which devices may reach this machine…" />;
}
