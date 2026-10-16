/**
 * A send that is not (yet) in the conversation — still sending, held in the agent's queue, or
 * settled without arriving — shown as the reader's own bubble with ONE chip saying where it is.
 *
 * The chip is a button: tapping it reads out WHY, which is the part a reader needs when a send is
 * anything but plainly fine. Two recoveries, and both re-send under the ORIGINAL id, so the daemon's
 * ledger can never turn a retry into a second copy the agent reads:
 *
 *   * NOT DELIVERED — the daemon proved it never arrived. Retry is one tap, because it cannot duplicate.
 *   * UNCONFIRMED — it could be proven neither way and may well have landed. "Send again anyway" is a
 *     two-step disclosure that says what a second copy costs before the button exists.
 *
 * Both are latched synchronously through a ref, so a double activation is one request.
 */

import { useRef, useState } from 'react';
import { displayCallsign } from '../lib/callsign.ts';
import { cn } from '../lib/class-names.ts';
import { type LedgerBlockPlacement, ledgerPlacementCopy } from '../lib/ledger-placement.ts';
import { peerFrom } from '../lib/peer-message.ts';
import { sendBadge } from '../lib/send-badge.ts';
import type { LedgerSendRecord } from '../lib/send-ledger.ts';
import { absoluteTime } from '../lib/session-screens.ts';

export const RESEND_RISK_COPY =
  'The original may still have reached the agent. Sending again could make it read this twice — continue only if that is acceptable.';

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

/** Re-sends a send under its original id. `force` is "send again anyway" for an unconfirmed one.
 *  Answers true only when the daemon accepted the new attempt. */
export type SendRetry = (record: LedgerSendRecord, force: boolean) => Promise<boolean>;

export interface LedgerMessageProps {
  readonly record: LedgerSendRecord;
  readonly placement?: LedgerBlockPlacement;
  readonly onRetry?: SendRetry;
}

/** The chip alone, tappable for its reason — also worn by a delivered message in the transcript. */
export function SendChip({ record }: { readonly record: LedgerSendRecord }) {
  const { label, tone, detail } = sendBadge(record);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        aria-expanded={open}
        className={cn(
          'ml-auto inline-flex shrink-0 select-none items-center gap-1 rounded-sm border px-1.5 py-px text-[10.5px] font-medium leading-[1.5]',
          tone,
        )}
        data-send-fate={record.fate}
        onClick={() => setOpen(current => !current)}
        title={[detail, `sent ${absoluteTime(record.acceptedAt)}`].join('\n')}
        type="button"
      >
        {label}
      </button>
      {open ? (
        <span className="basis-full text-[11px] text-muted" data-send-reason="">
          {detail}
        </span>
      ) : (
        <span className="sr-only">{detail}</span>
      )}
    </>
  );
}

export function LedgerMessage({ record, placement = 'chronological', onRetry }: LedgerMessageProps) {
  const { from, body } = peerFrom(record.message);
  const boundary = ledgerPlacementCopy(placement);
  const actionHeld = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const [result, setResult] = useState<'accepted' | 'error' | null>(null);
  const retryable = record.fate === 'timed_out' && record.retryable === true;
  const unconfirmed = record.fate === 'unaccounted';

  const retry = async (force: boolean): Promise<void> => {
    if (!onRetry || actionHeld.current) return;
    setRetrying(true);
    setResult(null);
    try {
      const accepted = await runResendOnce(actionHeld, () => onRetry(record, force));
      if (accepted !== undefined) setResult(accepted ? 'accepted' : 'error');
    } catch {
      setResult('error');
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="kt-bubble-row" data-ledger-placement={placement}>
      <span className="sr-only">{from ? `${displayCallsign(from.name)} sent:` : 'You said:'}</span>
      <div className="kt-bubble">
        <div className="flex min-w-0 flex-wrap items-center gap-2 px-panel pt-1">
          {from ? (
            <span className="shrink-0 text-[10.5px] font-medium text-muted">{displayCallsign(from.name)}</span>
          ) : null}
          <SendChip record={record} />
        </div>
        {boundary === undefined ? null : (
          <span className="sr-only" data-ledger-boundary>
            {boundary}
          </span>
        )}
        {body ? (
          <div className="kt-user-copy min-w-0 max-w-full whitespace-pre-wrap break-words px-panel pb-1.5 pt-0.5 text-[13px] leading-snug text-[color:var(--bubble-fg)]">
            {body}
          </div>
        ) : null}

        {retryable && onRetry !== undefined && result !== 'accepted' ? (
          <div className="mx-panel mb-2 flex items-center gap-2 border-t border-border-soft pt-1.5 text-[11px] text-muted">
            <button
              className="rounded-sm border border-border px-2 py-1 font-semibold text-fg hover:bg-surface-2 disabled:cursor-wait disabled:opacity-60"
              disabled={retrying}
              onClick={() => void retry(false)}
              type="button"
            >
              {retrying ? 'retrying…' : 'Retry'}
            </button>
            <span>it never arrived, so this cannot send it twice</span>
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
                  disabled={retrying}
                  onClick={() => void retry(true)}
                  type="button"
                >
                  {retrying ? 'sending…' : 'Send again anyway'}
                </button>
              </div>
            </div>
          </details>
        ) : null}
        {result === 'accepted' ? (
          <div className="mx-panel mb-2 text-[11px] text-muted" role="status">
            Sending again — this row updates when the agent has it.
          </div>
        ) : null}
        {result === 'error' ? (
          <div className="mx-panel mb-2 text-[11px] text-err" role="alert">
            The retry did not go through — check this row before trying again.
          </div>
        ) : null}
      </div>
    </div>
  );
}
