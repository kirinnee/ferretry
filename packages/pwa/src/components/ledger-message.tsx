/**
 * A send that is not (yet) in the conversation — still sending, held in the agent's queue, typed into its
 * composer but never submitted, settled without arriving, or taken back — shown as the reader's own
 * bubble with ONE receipt mark saying where it is (`send-receipt.tsx`), plus a small word when the state
 * needs the reader.
 *
 * The mark is a button: tapping it reads out WHY, which is the part a reader needs when a send is
 * anything but plainly fine. Every undelivered, un-cancelled message also carries its own way out, so
 * a message that never lands is never something the reader has to live with:
 *
 *   * CANCEL — takes it back, one tap. The daemon says what that did on the agent's screen (erased from
 *     the composer, or left in the agent's own queue, which Ferretry cannot edit); the row then says so.
 *   * PRESS ENTER — only for a message sitting typed in the composer: the harness never submits that by
 *     itself, so this presses Enter once. One tap, because the daemon refuses unless the composer holds
 *     exactly this message.
 *   * COPY TEXT — always, so cancelling never costs the words.
 *   * RETRY, and every retry re-sends under the ORIGINAL id, so the daemon's ledger can never turn it
 *     into a second copy the agent reads without the reader being told:
 *       - NOT DELIVERED — the daemon proved it never arrived. Retry is one tap, because it cannot duplicate.
 *       - UNCONFIRMED — it could be proven neither way and may well have landed. "Send again anyway" is a
 *         two-step disclosure that says what a second copy costs before the button exists.
 *       - SENDING / QUEUED — it may already be on its way. "Retry…" opens the same warning first.
 *       - UNCONFIRMABLE — the daemon can prove no transcript is this session's, so NOTHING it sends can be
 *         confirmed. Offering "send again" there only types another copy into an agent that most likely
 *         has the first; the row says so instead, and the workspace's notice carries the remedies.
 *
 * Every action is latched synchronously through one ref, so a double activation is one request. When
 * the daemon refuses, its own sentence is shown — it knows why (the pane still shows the message typed,
 * the agent is holding it) and a generic "failed" would hide it.
 */

import { Check, Copy, CornerDownLeft, RotateCw, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { browserClipboardWriter, type ClipboardWriter } from '../features/onboarding/copy-button.tsx';
import { displayCallsign } from '../lib/callsign.ts';
import { type LedgerBlockPlacement, ledgerPlacementCopy } from '../lib/ledger-placement.ts';
import { clockOfInstant } from '../lib/message-clock.ts';
import { peerFrom } from '../lib/peer-message.ts';
import type { LedgerSendRecord } from '../lib/send-ledger.ts';
import { MessageFooter } from './send-receipt.tsx';

export const UNBOUND_SEND_COPY =
  'Ferretry can’t confirm this, because it can’t find this session’s transcript. Check the Console tab before sending it again.';

export const RESEND_RISK_COPY =
  'The original may still have reached the agent. Sending again could make it read this twice — continue only if that is acceptable.';

export const OPEN_RESEND_RISK_COPY =
  'It may already be on its way. Sending again can make the agent read it twice — continue only if that is acceptable.';

export const QUEUED_CANCEL_COPY =
  'Cancelling removes it here only: the agent is holding it in its own queue and may still read it.';

/** Runs `action` at most once at a time. The latch is a ref and is set
 *  SYNCHRONOUSLY, so two activations in the same tick cannot both start. */
export const runResendOnce = async (
  latch: { current: boolean },
  action: () => Promise<boolean>,
): Promise<boolean | undefined> => {
  if (latch.current) return undefined;
  latch.current = true;
  try {
    return await action();
  } finally {
    latch.current = false;
  }
};

/** Re-sends a send under its original id. `force` is "send again anyway" for an unconfirmed or still-open one.
 *  Answers true only when the daemon accepted the new attempt. */
export type SendRetry = (record: LedgerSendRecord, force: boolean) => Promise<boolean>;

/** Takes a send back. Answers true only when the daemon accepted the cancel. */
export type SendCancel = (record: LedgerSendRecord) => Promise<boolean>;

/** Presses Enter once for a send typed in the agent's composer. Answers true only when the daemon did. */
export type SendSubmit = (record: LedgerSendRecord) => Promise<boolean>;

export interface LedgerMessageProps {
  readonly record: LedgerSendRecord;
  readonly placement?: LedgerBlockPlacement;
  readonly onRetry?: SendRetry;
  readonly onCancel?: SendCancel;
  readonly onSubmit?: SendSubmit;
  readonly write?: ClipboardWriter;
}

type ActionKind = 'retry' | 'cancel' | 'enter';

/** What an action settled to. `message` is the daemon's own refusal sentence, when it gave one. */
interface Note {
  readonly kind: 'cancel' | 'enter';
  readonly result: 'done' | 'error';
  readonly message?: string | undefined;
}

const refusal = (error: unknown): string | undefined =>
  error instanceof Error && error.message.trim().length > 0 ? error.message.trim() : undefined;

const ACTION_BUTTON = 'kt-btn kt-btn--sm shrink-0 gap-1';

export function LedgerMessage({
  record,
  placement = 'chronological',
  onRetry,
  onCancel,
  onSubmit,
  write = browserClipboardWriter(),
}: LedgerMessageProps) {
  const { from, body } = peerFrom(record.message);
  const boundary = ledgerPlacementCopy(placement);
  const actionHeld = useRef(false);
  const [busy, setBusy] = useState<ActionKind | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [note, setNote] = useState<Note | null>(null);
  const [outcome, setOutcome] = useState<{
    readonly result: 'accepted' | 'error';
    readonly attempt: number;
    readonly message?: string | undefined;
  } | null>(null);
  const attempt = record.attempt ?? 1;
  // A retry's word is about THAT attempt. Once a newer one has settled, the row says its own state, so
  // "Sending again" can never outlive the send it described.
  const settledSince =
    outcome !== null && attempt > outcome.attempt && record.fate !== 'accepted' && record.fate !== 'queued';
  const result = settledSince ? null : (outcome?.result ?? null);
  const retryable = record.fate === 'timed_out' && record.retryable === true;
  const unbound = record.fate === 'unaccounted' && record.unaccountedReason === 'transcript_unbound';
  const unconfirmed = record.fate === 'unaccounted' && !unbound;
  const delivered = record.fate === 'delivered';
  const open = (record.fate === 'accepted' || record.fate === 'queued') && record.held !== true;
  const typed = record.typedNotSent === true && open;
  // Held for a revive is kept deliberately; delivered and cancelled are done. Everything else can be taken back.
  const actionable = open || ((record.fate === 'timed_out' || record.fate === 'unaccounted') && record.held !== true);
  const showCopy = !delivered && body.length > 0;
  const openRetry = open && !typed && onRetry !== undefined && result !== 'accepted';
  const canEnter = typed && onSubmit !== undefined;
  const canCancel = actionable && onCancel !== undefined;
  const retryOnce = retryable && onRetry !== undefined && result !== 'accepted';
  const toolbar = canEnter || canCancel || retryOnce || openRetry || showCopy;

  const retry = async (force: boolean): Promise<void> => {
    if (!onRetry || actionHeld.current) return;
    setBusy('retry');
    setOutcome(null);
    setNote(null);
    try {
      const accepted = await runResendOnce(actionHeld, () => onRetry(record, force));
      if (accepted !== undefined) setOutcome({ result: accepted ? 'accepted' : 'error', attempt });
      if (accepted === true) setConfirming(false);
    } catch (error) {
      setOutcome({ result: 'error', attempt, message: refusal(error) });
    } finally {
      setBusy(null);
    }
  };

  const act = async (kind: 'cancel' | 'enter', action: () => Promise<boolean>): Promise<void> => {
    if (actionHeld.current) return;
    setBusy(kind);
    setNote(null);
    setOutcome(null);
    try {
      const done = await runResendOnce(actionHeld, action);
      if (done !== undefined) setNote({ kind, result: done ? 'done' : 'error' });
    } catch (error) {
      setNote({ kind, result: 'error', message: refusal(error) });
    } finally {
      setBusy(null);
    }
  };

  const copy = (): void => {
    void write(body).then(
      () => setCopied('copied'),
      () => setCopied('failed'),
    );
  };

  return (
    <div className="kt-bubble-row" data-ledger-placement={placement}>
      <span className="sr-only">{from ? `${displayCallsign(from.name)} sent:` : 'You said:'}</span>
      <div className="kt-bubble">
        {/* No "You" header: the bubble's alignment already says who sent it. A teammate's message
            keeps its sender's name, because alignment cannot. */}
        {from ? (
          <div className="px-panel pt-1 text-[10.5px] font-medium text-muted">{displayCallsign(from.name)}</div>
        ) : null}
        {boundary === undefined ? null : (
          <span className="sr-only" data-ledger-boundary>
            {boundary}
          </span>
        )}
        {body ? (
          <div className="kt-user-copy min-w-0 max-w-full whitespace-pre-wrap break-words px-panel pb-0 pt-1 text-[13px] leading-snug text-[color:var(--bubble-fg)]">
            {body}
          </div>
        ) : null}
        <div className="px-panel pb-1">
          <MessageFooter clock={clockOfInstant(record.acceptedAt)} record={record} />
        </div>

        {toolbar ? (
          <div
            className="mx-panel mb-2 flex flex-wrap items-center gap-1.5 border-t border-border-soft pt-1.5 text-[11px] text-muted"
            data-ledger-actions=""
          >
            {typed && onSubmit !== undefined ? (
              <button
                className={ACTION_BUTTON}
                data-ledger-action="enter"
                data-variant="primary"
                disabled={busy !== null}
                onClick={() => void act('enter', () => onSubmit(record))}
                type="button"
              >
                <CornerDownLeft aria-hidden="true" size={14} />
                {busy === 'enter' ? 'pressing…' : 'Press Enter'}
              </button>
            ) : null}
            {retryOnce ? (
              <button
                className={ACTION_BUTTON}
                data-ledger-action="retry"
                disabled={busy !== null}
                onClick={() => void retry(false)}
                type="button"
              >
                <RotateCw aria-hidden="true" size={14} />
                {busy === 'retry' ? 'retrying…' : 'Retry'}
              </button>
            ) : null}
            {openRetry ? (
              <button
                aria-expanded={confirming}
                className={ACTION_BUTTON}
                data-ledger-action="retry-open"
                disabled={busy !== null}
                onClick={() => setConfirming(current => !current)}
                type="button"
              >
                <RotateCw aria-hidden="true" size={14} />
                Retry…
              </button>
            ) : null}
            {actionable && onCancel !== undefined ? (
              <button
                className={ACTION_BUTTON}
                data-ledger-action="cancel"
                disabled={busy !== null}
                onClick={() => void act('cancel', () => onCancel(record))}
                type="button"
              >
                <X aria-hidden="true" size={14} />
                {busy === 'cancel' ? 'cancelling…' : 'Cancel'}
              </button>
            ) : null}
            {showCopy ? (
              <button
                className={ACTION_BUTTON}
                data-copy-state={copied}
                data-ledger-action="copy"
                onClick={copy}
                type="button"
              >
                {copied === 'copied' ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
                {copied === 'copied' ? 'Copied' : 'Copy text'}
              </button>
            ) : null}
            {retryOnce ? <span className="basis-full">it never arrived, so this cannot send it twice</span> : null}
            {record.fate === 'queued' && !typed && canCancel ? (
              <span className="basis-full" data-ledger-queued-cancel="">
                {QUEUED_CANCEL_COPY}
              </span>
            ) : null}
            {copied === 'failed' ? (
              <span className="basis-full text-warn" role="status">
                Copy was blocked — select the text instead
              </span>
            ) : null}
          </div>
        ) : null}
        {openRetry && confirming ? (
          <div
            className="mx-panel mb-2 rounded-control border border-warn-border bg-warn-bg px-2 py-1.5 text-[11px] text-warn"
            data-ledger-retry-confirm=""
          >
            <p>{OPEN_RESEND_RISK_COPY}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <button
                className="kt-btn kt-btn--sm shrink-0"
                data-variant="danger"
                disabled={busy !== null}
                onClick={() => void retry(true)}
                type="button"
              >
                {busy === 'retry' ? 'sending…' : 'Send again anyway'}
              </button>
              <button className="kt-btn kt-btn--sm shrink-0" onClick={() => setConfirming(false)} type="button">
                Keep waiting
              </button>
            </div>
          </div>
        ) : null}
        {unconfirmed && onRetry !== undefined && result !== 'accepted' ? (
          <details className="mx-panel mb-2 border-t border-border-soft pt-1.5 text-[11px] text-muted">
            <summary className="w-fit cursor-pointer select-none rounded-sm px-1.5 py-1 font-medium hover:bg-surface-2 hover:text-fg">
              send again…
            </summary>
            <div className="mt-1.5 rounded-control border border-warn-border bg-warn-bg px-2 py-1.5 text-warn">
              <p>{RESEND_RISK_COPY}</p>
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  className="rounded-sm border border-warn-border px-2 py-1 font-semibold hover:bg-surface disabled:cursor-wait disabled:opacity-60"
                  disabled={busy !== null}
                  onClick={() => void retry(true)}
                  type="button"
                >
                  {busy === 'retry' ? 'sending…' : 'Send again anyway'}
                </button>
              </div>
            </div>
          </details>
        ) : null}
        {unbound ? (
          <p
            className="mx-panel mb-2 mt-0 border-t border-border-soft pt-1.5 text-[11px] text-muted"
            data-send-unbound=""
          >
            {UNBOUND_SEND_COPY}
          </p>
        ) : null}
        {result === 'accepted' ? (
          <div className="mx-panel mb-2 text-[11px] text-muted" role="status">
            Sending again — this row updates when the agent has it.
          </div>
        ) : null}
        {result === 'error' ? (
          <div className="mx-panel mb-2 text-[11px] text-err" role="alert">
            The retry did not go through — {outcome?.message ?? 'check this row before trying again.'}
          </div>
        ) : null}
        {note?.result === 'done' ? (
          <div className="mx-panel mb-2 text-[11px] text-muted" role="status">
            {note.kind === 'cancel'
              ? 'Cancel sent — this row updates once the agent’s screen has been checked.'
              : 'Enter pressed — this row updates when the agent has it.'}
          </div>
        ) : null}
        {note?.result === 'error' ? (
          <div className="mx-panel mb-2 text-[11px] text-err" role="alert">
            {note.kind === 'cancel' ? 'Cancel did not go through' : 'Enter was not pressed'} —{' '}
            {note.message ?? 'check this row before trying again.'}
          </div>
        ) : null}
      </div>
    </div>
  );
}
