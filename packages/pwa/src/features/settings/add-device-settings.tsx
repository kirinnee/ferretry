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
 * ## THE FIRST DEVICE REQUIRES AN OPERATOR PASSWORD — AND THE DAEMON IS WHAT REQUIRES IT
 *
 * `POST /v1/pair/code` refuses while no operator password exists, whoever asks: this panel, a phone, or
 * `fy pair` on the host. `fleet.configure` is on by default for a governed caller, so a device paired to
 * a machine with no password can provision the host — writing runnable wrappers into the operator's
 * accounts — with nothing to prove. Requiring the password at the one moment remote access is being
 * created DELETES that state rather than warning about it.
 *
 * WHAT THIS PANEL DOES IS EXPLAIN IT FIRST, NOT ENFORCE IT. The requirement used to live here, which made
 * the guarantee "the browser will not create a passwordless remote device" — silent about the command
 * line, which mints through the same route. So this is a pre-check: where the grant view says there is no
 * password, the reason and the control that fixes it take the button's place; where this browser cannot
 * tell, the button is offered and the daemon's own refusal is what a person reads. One rule, one sentence.
 *
 * IT IS PAIRING'S REQUIREMENT, NEVER STARTUP'S AND NEVER LOCAL USE'S. A person setting up on their own
 * machine with nothing paired is asked for nothing, because there is no remote caller for a gate to stand
 * in front of. An install that already has devices and no password meets the requirement at its NEXT
 * pairing, which needs no separate nag and cannot lock anybody out.
 *
 * ## A REFUSAL IS EXPLAINED, NEVER GREYED
 *
 * A caller who is not on the host and whose operator has switched `pairing` off cannot read this panel at
 * all — the routes are governed. That refusal is rendered as the daemon's own sentence, which names the
 * command that changes it, plus the one thing the daemon cannot know: pairing from the machine itself is
 * never restricted. A greyed button with no explanation is the dead end this product keeps removing.
 */

import {
  type GrantsView,
  invitationRedeemableByAnotherDevice,
  localOnlyNotice,
  type PairedDevice,
  type PairedDevicesView,
  type PairingCodeMintResponse,
  type PairingMintOutcome,
  pairingMintOutcome,
  refusalNotice,
} from '@ferretry/protocol';
import { Check, CircleAlert, MonitorSmartphone, Plus, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';

import { QrSymbol } from '../../components/qr-symbol.tsx';
import { daemonApiClient } from '../../lib/api-client.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import {
  PAIRING_PASSWORD_REQUIREMENT,
  PAIRING_PASSWORD_REQUIREMENT_REMOTE,
  type PairingGate,
  pairingGate,
} from '../../lib/grants.ts';
import {
  isThisDevice,
  orderedPairedDevices,
  PAIRING_EXPIRED_NOTE,
  PAIRING_EXPIRY_NOTE,
  PAIRING_SCAN_HINT,
  PAIRING_TICK_MS,
  PAIRING_TYPE_HINT,
  pairedDeviceSummary,
  pairingCodeDisclosure,
  pairingCountdown,
  type PairingOfferKind,
  pairingRefusal,
  revokeConsequence,
} from '../../lib/pairing-invite.ts';
import { encodeQr, QrEncodeError, type QrMatrix } from '../../lib/qr-code.ts';
import {
  mintPairingCode,
  type PairingClient,
  type PairingFailure,
  pairingFailure,
  readPairedDevices,
  revokePairedDevice,
  revokePairingCode,
} from './add-device-api.ts';
import { readGrants, setOperatorPassword } from './grants-api.ts';
import { OperatorPasswordCard } from './operator-password.tsx';

/** The invite, as this screen holds it: the daemon it belongs to, and what the daemon answered. */
interface HeldInvite {
  readonly daemonId: DaemonConnection['daemonId'];
  readonly minted: PairingCodeMintResponse;
}

/**
 * The QR, or a stated reason there is none.
 *
 * A pairing URL that will not encode is a daemon problem — an address far longer than any this protocol
 * produces — and it is said out loud rather than rendered as an empty square. The selectable link below
 * still works, so the panel degrades to something usable instead of to a blank.
 */
function InviteSymbol({ pairUrl }: { readonly pairUrl: string }) {
  let matrix: QrMatrix;
  try {
    matrix = encodeQr(pairUrl);
  } catch (cause) {
    return (
      <p
        role="alert"
        className="m-0 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-meta leading-base text-warn"
        data-pair-qr-failure=""
      >
        This link is too long for a QR code, so there is none to show. Use the link below instead.
        {cause instanceof QrEncodeError ? ` ${cause.message}` : ''}
      </p>
    );
  }
  return (
    <div className="rounded-control border border-border bg-white p-3" data-pair-qr="">
      <QrSymbol matrix={matrix} label="Pairing code for this machine" className="h-auto w-full max-w-[240px]" />
    </div>
  );
}

/**
 * Which of the three offers this outcome is, for the copy that must vary with it.
 *
 * `local-only` NO LONGER MEANS UNREDEEMABLE, and that is the entire user-visible point of relayed
 * pairing. A daemon that binds loopback but dials a rendezvous a fresh device can DISCOVER hands out a
 * link another device CAN redeem — the phone reads the same hosted advertisement and dials the relay
 * itself — so drawing no QR for it would tell an owner to go and fix a bind that has stopped being the
 * obstacle, which is the "dead end with extra steps" `docs/pairing.md` legislates against.
 *
 * THE NARROWING IS THE PROTOCOL'S, not this panel's: `invitationRedeemableByAnotherDevice` is the one
 * place that decides it, so `fy pair`'s terminal QR and this panel cannot come to different
 * conclusions about the same mint.
 */
function offerKindOf(outcome: PairingMintOutcome): PairingOfferKind {
  if (outcome.kind === 'refusal') return 'refusal';
  return invitationRedeemableByAnotherDevice(outcome) ? 'qr' : 'local-only';
}

/**
 * The panel's headline, decided by what THIS offer can actually do.
 *
 * `fy pair` fixed the same defect at its own headline (`render.ts:175-178`): a fixed "show this to the
 * device you are adding" printed over a `local-only` or `refusal` offer sends the reader looking for a
 * phone that link was never for. CONCISE AND BRANCH-SPECIFIC RATHER THAN THE FULL NOTICE: `InviteOffer`
 * already renders the protocol-owned `audience`/`remedy` sentence in full immediately below, so
 * repeating it here would print the same sentence twice back-to-back.
 */
function inviteHeadline(outcome: PairingMintOutcome): string {
  if (outcome.kind === 'refusal') return 'No link to hand out';
  return invitationRedeemableByAnotherDevice(outcome)
    ? 'Show this to the device you are adding'
    : 'Open this on this machine';
}

/**
 * The headline over a code that has run out, which is about the code and never about an offer.
 *
 * AN EXPIRED CODE HAS NOTHING TO SHOW ANYBODY. The panel below it withholds the QR, the link and the
 * code itself, so "show this to the device you are adding" printed above that names a hand-off that
 * no longer exists — and named it even for a `local-only` or `refusal` offer, where no link a device
 * could take ever existed at all. It says the one thing that is still true instead.
 */
const EXPIRED_HEADLINE = 'This code has run out';

/**
 * WHAT THERE IS TO OFFER THE DEVICE BEING ADDED, AND WHO CAN TAKE IT.
 *
 * THE QR IS DRAWN WHENEVER ANOTHER DEVICE COULD REDEEM THE LINK, BY ANY CARRIER. A daemon that
 * advertises a routed address qualifies as it always did; so, now, does one that advertises only
 * loopback but dials a DISCOVERABLE rendezvous, because a phone finds that rendezvous in its own
 * build's advertisement and reaches the daemon through it (`docs/relay-protocol.md` §14). What is left
 * in the `local-only` branch is the case that really is local: a link perfectly good for the browser
 * reading this panel and dead on a phone, because the address means THAT PHONE once it is scanned and
 * no rendezvous a fresh device could find carries it — a self-hosted-only daemon included, which is
 * §13's declared gap. A daemon with no address at all has no link, and the code below it is still live
 * for a browser somebody points at the machine themselves.
 *
 * NOTHING HERE JUDGES REACHABILITY. Both halves of the answer — `reach` and `discoveredRelayUrl` —
 * arrive on the wire, decided by the daemon's own configuration, because the device that will redeem
 * the code is not the one rendering this panel. The narrowing and the sentences come from the
 * protocol too, so this panel and `fy pair` say the same thing about the same mint. Neither half
 * reaches the QR itself: the link it encodes is the daemon's ordinary `v1` fragment.
 */
function InviteOffer({ outcome }: { readonly outcome: PairingMintOutcome }) {
  if (outcome.kind === 'refusal') {
    const notice = refusalNotice(outcome.refusal);
    return (
      <div className="flex min-w-0 flex-col gap-2" data-pair-offer="refusal">
        <p
          role="status"
          className="m-0 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui leading-base text-warn"
          data-pair-no-link=""
        >
          {notice.audience}
        </p>
        <p className="m-0 text-meta leading-base text-muted">{notice.remedy}</p>
      </div>
    );
  }
  /*
   * THE QR AND THE NOTICE ARE INDEPENDENT ANSWERS, and collapsing them was a real defect for the
   * exact case this feature adds. They used to move together because they only ever had one cause: a
   * `local-only` link could not be redeemed elsewhere, so it earned a warning INSTEAD of a QR.
   *
   * A loopback-bound daemon on a rendezvous breaks that pairing of facts in half. Another device CAN
   * redeem the link — so it earns a QR — and the address in it is still local, so the reader is still
   * owed the sentence saying what that means and what the rendezvous observes about the exchange.
   * Suppressing the notice because a QR appeared would delete the disclosure precisely when there is
   * something new to disclose, which is the opposite of what §14 asks for.
   *
   * So: the QR is drawn whenever another device can redeem (`redeemable`), the notice is rendered
   * whenever the ADDRESS is local-only (`reach`), and a relayed loopback mint gets both.
   */
  const redeemable = invitationRedeemableByAnotherDevice(outcome);
  const local = outcome.reach === 'local-only' ? localOnlyNotice(outcome.daemonUrl, outcome.discoveredRelayUrl) : null;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-pair-offer={outcome.reach}>
      {redeemable && (
        <>
          <InviteSymbol pairUrl={outcome.pairUrl} />
          <p className="m-0 text-meta leading-base text-muted">{PAIRING_SCAN_HINT}</p>
          <p className="m-0 text-meta leading-base text-muted">{PAIRING_TYPE_HINT}</p>
        </>
      )}
      {local !== null && (
        <>
          <p
            role="status"
            className="m-0 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui leading-base text-warn"
            data-pair-local-only=""
          >
            {local.audience}
          </p>
          <p className="m-0 text-meta leading-base text-muted">{local.remedy}</p>
        </>
      )}
      {/* `select-all` and `break-all`: this is meant to be selected and retyped, on a phone. */}
      <code
        data-pair-url=""
        className="block select-all break-all rounded-control border border-border bg-surface-2 px-2 py-1 font-mono text-meta text-fg"
      >
        {outcome.pairUrl}
      </code>
    </div>
  );
}

/** One paired device: what it is, when it arrived, and the control that ends its access. */
function PairedDeviceRow({
  device,
  view,
  busy,
  onRevoke,
}: {
  readonly device: PairedDevice;
  readonly view: PairedDevicesView;
  readonly busy: boolean;
  readonly onRevoke: () => void;
}) {
  const mine = isThisDevice(device, view);
  const describedBy = useId();

  return (
    <li
      className="flex min-w-0 flex-col gap-1 border-t border-border-soft py-2 first:border-t-0"
      data-paired-device={device.id}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <MonitorSmartphone size={15} className="shrink-0 text-muted" aria-hidden="true" />
        {/* Attacker-influenced text: the redeeming device chose this name, so it is rendered as text.
            It WRAPS rather than truncating, and the row wraps with it: a phone squeezing three items
            onto one line turned "Ernest's Pixel 8" into "Ernest's Pi…", and a device somebody is about
            to revoke is the last place to hide which device it is. */}
        <span className="min-w-[9rem] flex-1 break-words text-ui font-semibold text-fg">{device.name}</span>
        {mine ? (
          <span
            className="rounded-control border border-accent bg-accent-soft px-2 py-0.5 text-meta font-medium text-accent"
            data-paired-device-self=""
          >
            this device
          </span>
        ) : null}
        <button
          type="button"
          disabled={busy}
          aria-describedby={describedBy}
          data-pair-revoke-device={device.id}
          onClick={onRevoke}
          className="kt-btn min-h-[40px] shrink-0 disabled:cursor-not-allowed disabled:opacity-60"
          data-variant="danger"
        >
          <Trash2 size={14} aria-hidden="true" />
          Revoke
        </button>
      </div>
      <p className="m-0 text-meta leading-base text-faint">{pairedDeviceSummary(device)}</p>
      {/* What the button will do, in the same breath as the button. Never after the press. */}
      <p id={describedBy} className="m-0 text-meta leading-base text-muted">
        {revokeConsequence(device, view)}
      </p>
    </li>
  );
}

export interface AddDeviceCardProps {
  readonly connection: DaemonConnection;
  readonly view: PairedDevicesView;
  /**
   * Whether a code may be offered at all, and what to say when it may not.
   *
   * IT IS A PROP RATHER THAN A READ. This panel renders what it is given, so a test drives every branch
   * of the requirement without a network, and the harness screenshots the same component.
   */
  readonly gate: PairingGate;
  /** The live invite, when one has been minted in this panel. */
  readonly invite: PairingCodeMintResponse | null;
  /** Now, supplied rather than read, so the countdown is deterministic in a test and a screenshot. */
  readonly nowMs: number;
  readonly busy?: boolean;
  readonly failure?: PairingFailure | null;
  /** A refusal the daemon answered the password call with, rendered whole and kept apart from `failure`. */
  readonly passwordFailure?: string | null;
  /**
   * Setting the FIRST password, which is the only password act this panel offers.
   *
   * There is deliberately no clear: this card exists here to satisfy a requirement, and putting the undo
   * for the requirement beside the requirement would be a control that argues with the panel around it.
   */
  readonly onSetPassword: (password: string) => void;
  readonly onMint: () => void;
  readonly onDiscardInvite: () => void;
  readonly onRevokeCode: () => void;
  readonly onRevokeDevice: (deviceId: string) => void;
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
  gate,
  invite,
  nowMs,
  busy = false,
  failure = null,
  passwordFailure = null,
  onSetPassword,
  onMint,
  onDiscardInvite,
  onRevokeCode,
  onRevokeDevice,
}: AddDeviceCardProps) {
  const headingId = useId();
  const devices = orderedPairedDevices(view);
  const countdown = invite === null ? null : pairingCountdown(invite.expiresAt, nowMs);

  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      aria-labelledby={headingId}
      data-add-device-surface={String(connection.daemonId)}
    >
      <section className="kt-panel flex min-w-0 flex-col gap-2 p-panel">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={headingId} className="m-0 flex items-center gap-1.5 text-title font-semibold text-fg">
            <ShieldCheck size={16} className="text-accent" aria-hidden="true" />
            Devices on this machine
          </h3>
          <span
            className="rounded-control border border-border-soft bg-surface-2 px-2 py-0.5 text-meta text-faint"
            data-pair-host-local={view.hostLocal ? 'yes' : 'no'}
          >
            {view.hostLocal ? 'you are at this machine' : 'you are away from this machine'}
          </span>
        </div>
        <p className="m-0 text-ui leading-base text-muted">
          A device is added by reading a code this machine mints. The code lasts two minutes and works once, so a phone
          that reads it becomes a device you can see and revoke below.
        </p>
        {/* THE PASSWORD IS REQUIRED BEFORE THE FIRST DEVICE, AND THE DAEMON IS WHAT REQUIRES IT.
            `POST /v1/pair/code` refuses while no operator password exists, for every caller — this panel,
            a phone, and `fy pair` on the host. What happens here is a PRE-CHECK: when this browser has
            read the grant view and can see there is no password, it says so and offers the control that
            fixes it, rather than presenting a button that would be refused. When it cannot tell, it offers
            the button and renders whatever the machine answers.

            The requirement lands at pairing and nowhere else: `fleet.configure` is on by default for a
            governed caller, so a device paired to a passwordless machine can provision the host. Nothing
            about using this machine locally is gated, and startup is never blocked. */}
        {gate.kind === 'open' && invite === null ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              data-pair-mint=""
              onClick={onMint}
              className="kt-btn disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Plus size={15} aria-hidden="true" />
              Add a device
            </button>
            <span className="text-meta leading-base text-faint">{PAIRING_EXPIRY_NOTE}</span>
          </div>
        ) : null}
        {gate.kind === 'needs-password' ? (
          <p
            role="status"
            className="m-0 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui leading-base text-warn"
            data-pair-needs-password={gate.local ? 'local' : 'remote'}
          >
            <ShieldAlert size={14} className="mr-1 inline" aria-hidden="true" />
            {gate.local ? PAIRING_PASSWORD_REQUIREMENT : PAIRING_PASSWORD_REQUIREMENT_REMOTE}
          </p>
        ) : null}
      </section>

      {/* The control that satisfies the requirement, in the flow that requires it, so nobody is sent to
          another screen and back. It is the SAME component the grant settings render — one control, one
          set of rules about where it can succeed. */}
      {gate.kind === 'needs-password' && gate.local ? (
        <OperatorPasswordCard
          state={{ kind: 'ready', first: true }}
          busy={busy}
          failure={passwordFailure}
          heading="Set the operator password"
          intro="This is the gate every device you add will have to pass to change anything here. It is not your computer’s login, and nothing in Ferretry uses it to run anything as another user."
          onSet={onSetPassword}
        />
      ) : null}

      {invite !== null && countdown !== null ? (
        <section className="kt-panel flex min-w-0 flex-col gap-2 p-panel" aria-label="Pairing code" data-pair-invite="">
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="m-0 text-ui font-semibold text-fg">
              {countdown.expired ? EXPIRED_HEADLINE : inviteHeadline(pairingMintOutcome(invite))}
            </p>
            <span
              role="timer"
              aria-live="off"
              data-pair-countdown={countdown.expired ? 'expired' : 'live'}
              className={cn(
                'rounded-control border px-2 py-0.5 font-mono text-meta font-medium',
                countdown.expired ? 'border-err-border bg-err-bg text-err' : 'border-ok-border bg-ok-bg text-ok',
              )}
            >
              {countdown.expired ? 'expired' : countdown.label}
            </span>
          </div>
          {countdown.expired ? (
            <p
              role="status"
              className="m-0 rounded-control border border-err-border bg-err-bg px-3 py-2 text-ui leading-base text-err"
            >
              {PAIRING_EXPIRED_NOTE}
            </p>
          ) : (
            <>
              <InviteOffer outcome={pairingMintOutcome(invite)} />
              {/* The code in words as well as in the link: a person reading a QR out loud reads this,
                  and it is the ONLY thing left to read when there is no link to hand out. */}
              <p className="m-0 flex flex-wrap items-baseline gap-2 text-ui text-fg">
                <span className="text-meta uppercase tracking-label text-faint">Code</span>
                <code data-pair-code="" className="select-all font-mono text-title font-semibold tracking-widest">
                  {invite.code}
                </code>
              </p>
              <p className="m-0 rounded-control border border-border-soft bg-surface-2 px-3 py-2 text-meta leading-base text-muted">
                {pairingCodeDisclosure(offerKindOf(pairingMintOutcome(invite)))}
              </p>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              data-pair-revoke-code=""
              onClick={onRevokeCode}
              className="kt-btn min-h-[44px] disabled:cursor-not-allowed disabled:opacity-60"
              data-variant="danger"
            >
              <Trash2 size={14} aria-hidden="true" />
              Revoke now
            </button>
            <button type="button" data-pair-discard="" onClick={onDiscardInvite} className="kt-btn min-h-[44px]">
              <Check size={14} aria-hidden="true" />
              Done
            </button>
          </div>
          <p className="m-0 text-meta leading-base text-faint">
            Revoke now ends the code on the machine, so nothing can redeem it. Done only clears it from this screen —
            the code keeps working until it runs out.
          </p>
        </section>
      ) : null}

      <section className="kt-panel flex min-w-0 flex-col gap-1 p-panel" aria-label="Paired devices">
        <p className="m-0 text-ui font-semibold text-fg">
          {devices.length === 0
            ? 'No devices are paired to this machine'
            : `${String(devices.length)} device${devices.length === 1 ? '' : 's'} may reach this machine`}
        </p>
        {devices.length === 0 ? (
          <p className="m-0 text-meta leading-base text-muted">
            Nothing but this machine itself can reach this daemon yet. Adding a device is how that changes, and every
            device you add appears here with its own revoke.
          </p>
        ) : (
          <ul className="m-0 list-none p-0">
            {devices.map(device => (
              <PairedDeviceRow
                key={device.id}
                device={device}
                view={view}
                busy={busy}
                onRevoke={() => onRevokeDevice(device.id)}
              />
            ))}
          </ul>
        )}
      </section>

      {failure === null ? null : (
        <p
          role="alert"
          className="m-0 rounded-control border border-err-border bg-err-bg px-3 py-2 text-ui leading-base text-err"
          data-pair-failure=""
        >
          <CircleAlert size={14} className="mr-1 inline" aria-hidden="true" />
          {/* The daemon's own sentence, whole. It already names the command a human runs. */}
          {failure.message}
        </p>
      )}
    </section>
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
  createClient = daemonApiClient,
  now = Date.now,
}: {
  readonly connection: DaemonConnection;
  readonly createClient?: PairingClientFactory;
  readonly now?: PairingClock;
}) {
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
  const [passwordFailure, setPasswordFailure] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => now());
  /**
   * Whether this machine has an operator password — `null` when this browser could not find out.
   *
   * READ ALONGSIDE THE DEVICE LIST, not lazily when somebody presses the button, because the point of
   * reading it is to explain BEFORE the press. It carries no failure reason any more: the requirement is
   * the daemon's, so an unreadable view means this panel has nothing to say in advance rather than a
   * refusal of its own to compose. Whatever the machine answers is rendered whole when somebody taps.
   */
  const [grants, setGrants] = useState<{
    readonly daemonId: DaemonConnection['daemonId'];
    readonly view: GrantsView | null;
  } | null>(null);

  useEffect(() => {
    let current = true;
    setClient(null);
    setLoaded(null);
    setLoadFailure(null);
    setFailure(null);
    setPasswordFailure(null);
    setGrants(null);
    // The code belongs to the daemon that minted it, so switching machines drops it rather than carrying a
    // live credential across the boundary everything else here is keyed by.
    setInvite(null);
    void createClient(connection)
      .then(async next => {
        const view = await readPairedDevices(next);
        // Settled rather than awaited together: a grant view this browser could not read must not turn a
        // working device list into a load failure. It becomes a null view, and the pre-check then says
        // nothing in advance rather than pretending the panel is broken — the daemon still answers the tap.
        const grant = await readGrants(next).then(
          answer => answer,
          () => null,
        );
        if (!current) return;
        setClient(next);
        setLoaded({ daemonId: connection.daemonId, view });
        setGrants({ daemonId: connection.daemonId, view: grant });
      })
      .catch((cause: unknown) => {
        if (current) setLoadFailure({ daemonId: connection.daemonId, failure: pairingFailure(cause) });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient]);

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

  /**
   * Sets the FIRST operator password, from the flow that requires one.
   *
   * The value is an ARGUMENT and nothing else — never state here, never logged, never echoed. No unlock is
   * sent because this can only run where none exists to prove: the panel offers this control exclusively
   * for `needs-password`, and a machine with no password has nothing to unlock with. It takes a `string`
   * rather than `string | undefined` for the same reason — there is no clearing here, and a parameter that
   * could express one would be an undo for the requirement this panel exists to state.
   */
  const setFirstPassword = useCallback(
    async (password: string) => {
      if (client === null || loaded?.daemonId !== connection.daemonId) return;
      setBusy(true);
      setPasswordFailure(null);
      try {
        await setOperatorPassword(client, password);
        setGrants({ daemonId: connection.daemonId, view: await readGrants(client) });
      } catch (cause) {
        setPasswordFailure(pairingFailure(cause).message);
      } finally {
        setBusy(false);
      }
    },
    [client, connection.daemonId, loaded?.daemonId],
  );

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

  if (loaded?.daemonId === connection.daemonId)
    return (
      <AddDeviceCard
        connection={connection}
        view={loaded.view}
        gate={
          grants?.daemonId === connection.daemonId
            ? pairingGate(grants.view)
            : // Still reading, or an answer belonging to a daemon this panel has since switched away from.
              // Either way this browser does not know yet — so it says nothing in advance and lets the
              // daemon answer the tap. The requirement is enforced there, not here.
              pairingGate(null)
        }
        invite={invite?.daemonId === connection.daemonId ? invite.minted : null}
        nowMs={nowMs}
        busy={busy}
        failure={failure}
        passwordFailure={passwordFailure}
        onSetPassword={password => void setFirstPassword(password)}
        onMint={() => void mint()}
        onDiscardInvite={() => setInvite(null)}
        onRevokeCode={() => void revokeCode()}
        onRevokeDevice={deviceId => void revokeDevice(deviceId)}
      />
    );
  if (loadFailure?.daemonId === connection.daemonId)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Adding a device unavailable">
        <h3 className="m-0 text-title font-semibold text-fg">Adding a device is unavailable here</h3>
        <p className="mb-0 mt-1 text-ui leading-base text-muted" data-pair-refusal="">
          {pairingRefusal(loadFailure.failure.message)}
        </p>
      </section>
    );
  return (
    <section className="kt-panel p-panel" role="status" aria-label="Loading paired devices">
      <p className="m-0 text-ui leading-base text-muted">Reading which devices may reach this machine…</p>
    </section>
  );
}
