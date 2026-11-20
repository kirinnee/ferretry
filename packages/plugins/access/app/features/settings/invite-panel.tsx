/**
 * THE PAIRING CODE ON SCREEN (the part of Settings › Devices that holds a live credential).
 *
 * A minted code is component state of `add-device-settings.tsx`: this file only draws it. The QR is computed in this tab
 * from the link, so the credential reaches no third party; it is never written to a store, a URL or a log, and every
 * screenshot of it uses a fixed fake code (docs/pairing.md).
 *
 * Laid out by the SETTINGS PANEL's width (`.fy-acc` is the container): the QR beside the facts from 560px, stacked below.
 * A refusal or a local-only link is a `Notice`, never a box.
 */

import { type ReactNode, useState } from 'react';
import { CircleAlert, Check, Trash2 } from 'lucide-react';
import { localQr, QrEncodeError, type QrMatrix } from '@ferretry/app';
import {
  invitationRedeemableByAnotherDevice,
  type PairingCodeMintResponse,
  type PairingMintOutcome,
  pairingMintOutcome,
} from '../../../contract/index.ts';
import { QrSymbol } from '../../components/qr-symbol.tsx';
import { localOnlyNotice, refusalNotice } from '../../shell-pairing.ts';
import {
  PAIRING_EXPIRED_NOTE,
  PAIRING_SCAN_HINT,
  PAIRING_TYPE_HINT,
  type PairingOfferKind,
  pairingCodeDisclosure,
  type pairingCountdown,
} from '../../lib/pairing-invite.ts';
import { ActionRow, ConfirmStrip, Notice } from './access-kit.tsx';

/** The QR, or a stated reason there is none (a link too long to encode is a daemon problem, said out loud). */
function InviteSymbol({ pairUrl }: { readonly pairUrl: string }) {
  let matrix: QrMatrix;
  try {
    matrix = localQr(pairUrl);
  } catch (cause) {
    return (
      <Notice tone="warn" role="alert" marks={{ 'data-pair-qr-failure': '' }}>
        This link is too long for a QR code, so there is none to show. Use the link below instead.
        {cause instanceof QrEncodeError ? ` ${cause.message}` : ''}
      </Notice>
    );
  }
  return (
    // theme-literal-ok: the QR plate must stay white behind the dark modules to scan, in every theme
    <div className="w-full max-w-[200px] rounded-control border border-border bg-white p-3" data-pair-qr="">
      <QrSymbol matrix={matrix} label="Pairing code for this machine" className="h-auto w-full" />
    </div>
  );
}

/** Which of the three offers this outcome is, for the copy that must vary with it. The protocol owns the narrowing. */
function offerKindOf(outcome: PairingMintOutcome): PairingOfferKind {
  if (outcome.kind === 'refusal') return 'refusal';
  return invitationRedeemableByAnotherDevice(outcome) ? 'qr' : 'local-only';
}

/** The headline, decided by what THIS offer can actually do (the same words `fy pair` prints). */
function inviteHeadline(outcome: PairingMintOutcome): string {
  if (outcome.kind === 'refusal') return 'No link to hand out';
  return invitationRedeemableByAnotherDevice(outcome)
    ? 'Show this to the device you are adding'
    : 'Open this on this machine';
}

/** The headline over a code that has run out: about the code, never about an offer. */
const EXPIRED_HEADLINE = 'This code has run out';

/**
 * WHAT THERE IS TO OFFER THE DEVICE BEING ADDED, AND WHO CAN TAKE IT. The QR is drawn whenever another device could redeem
 * the link by any carrier; the local-only notice whenever the ADDRESS is local, so a relayed loopback mint gets both
 * (docs/relay-protocol.md §14). Nothing here judges reachability: both halves of the answer arrive on the wire.
 */
function InviteOffer({ outcome, code }: { readonly outcome: PairingMintOutcome; readonly code: string }) {
  if (outcome.kind === 'refusal') {
    const notice = refusalNotice(outcome.refusal);
    return (
      <div className="fy-acc-invite__main" data-pair-offer="refusal">
        <div className="fy-acc-invite__facts">
          <Notice tone="warn" role="status" marks={{ 'data-pair-no-link': '' }}>
            {notice.audience}
          </Notice>
          <p className="fy-acc-fine">{notice.remedy}</p>
          <CodeLine code={code} />
        </div>
      </div>
    );
  }
  const redeemable = invitationRedeemableByAnotherDevice(outcome);
  const local = outcome.reach === 'local-only' ? localOnlyNotice(outcome.daemonUrl, outcome.discoveredRelayUrl) : null;
  return (
    <div className="fy-acc-invite__main" data-pair-offer={outcome.reach} data-has-qr={redeemable ? 'yes' : 'no'}>
      {redeemable ? <InviteSymbol pairUrl={outcome.pairUrl} /> : null}
      <div className="fy-acc-invite__facts">
        {redeemable ? (
          <>
            <p className="fy-acc-fine">{PAIRING_SCAN_HINT}</p>
            <p className="fy-acc-fine">{PAIRING_TYPE_HINT}</p>
          </>
        ) : null}
        {local === null ? null : (
          <>
            <Notice tone="warn" role="status" marks={{ 'data-pair-local-only': '' }}>
              {local.audience}
            </Notice>
            <p className="fy-acc-fine">{local.remedy}</p>
          </>
        )}
        {/* `select-all` and `break-all`: this is meant to be selected and retyped, on a phone. */}
        <code data-pair-url="" className="fy-acc-invite__url">
          {outcome.pairUrl}
        </code>
        <CodeLine code={code} />
      </div>
    </div>
  );
}

/** The code in words as well as in the link: a person reading a QR out loud reads this. */
function CodeLine({ code }: { readonly code: string }) {
  return (
    <p className="m-0 flex flex-wrap items-baseline gap-2 text-ui text-fg">
      <span className="text-meta text-faint">Code</span>
      <code data-pair-code="" className="select-all font-mono text-title font-semibold tracking-widest">
        {code}
      </code>
    </p>
  );
}

export interface InvitePanelProps {
  readonly invite: PairingCodeMintResponse;
  readonly countdown: ReturnType<typeof pairingCountdown>;
  readonly busy: boolean;
  readonly onRevokeCode: () => void;
  readonly onDiscardInvite: () => void;
}

/** The live code under the "Add a device" row: headline and countdown, the offer, then what each button does. */
export function InvitePanel({ invite, countdown, busy, onRevokeCode, onDiscardInvite }: InvitePanelProps): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const outcome = pairingMintOutcome(invite);
  return (
    <section className="fy-acc-body fy-acc-invite" aria-label="Pairing code" data-pair-invite="">
      <div className="fy-acc-invite__head">
        <p className="fy-acc-invite__title text-ui">{countdown.expired ? EXPIRED_HEADLINE : inviteHeadline(outcome)}</p>
        <span
          role="timer"
          aria-live="off"
          data-pair-countdown={countdown.expired ? 'expired' : 'live'}
          className="fy-acc-chip font-mono"
          data-tone={countdown.expired ? 'err' : 'ok'}
        >
          {countdown.expired ? 'expired' : countdown.label}
        </span>
      </div>
      {countdown.expired ? (
        <Notice tone="err" role="status">
          {PAIRING_EXPIRED_NOTE}
        </Notice>
      ) : (
        <>
          <InviteOffer outcome={outcome} code={invite.code} />
          <Notice tone="info">{pairingCodeDisclosure(offerKindOf(outcome))}</Notice>
        </>
      )}
      <ActionRow>
        <button
          type="button"
          disabled={busy}
          data-pair-revoke-code=""
          aria-expanded={confirming}
          onClick={() => setConfirming(true)}
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
      </ActionRow>
      {confirming ? (
        <ConfirmStrip
          question="Revoke this code now?"
          consequence="The code stops working on the machine straight away, so nothing can redeem it. A new one can be made any time."
          confirmLabel="Yes, revoke the code"
          busy={busy}
          onConfirm={() => {
            setConfirming(false);
            onRevokeCode();
          }}
          onCancel={() => setConfirming(false)}
          marks={{ 'data-pair-revoke-code-confirming': '' }}
          confirmMarks={{ 'data-pair-revoke-code-confirm': '' }}
          cancelMarks={{ 'data-pair-revoke-code-cancel': '' }}
        />
      ) : null}
      <p className="fy-acc-fine fy-acc-faint">
        Revoke now ends the code on the machine, so nothing can redeem it. Done only clears it from this screen — the
        code keeps working until it runs out.
      </p>
    </section>
  );
}

export function FailureNotice({
  message,
  marks,
}: {
  readonly message: string;
  readonly marks: Readonly<Record<`data-${string}`, string>>;
}) {
  return (
    <Notice tone="err" role="alert" icon={<CircleAlert size={14} />} marks={marks}>
      {/* The daemon's own sentence, whole. It already names the command a human runs. */}
      {message}
    </Notice>
  );
}
