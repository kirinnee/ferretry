/**
 * A durable send attempt whose delivery is not represented by a loaded proof
 * row — the send ledger's own transcript row.
 *
 * Resend is deliberately a two-step disclosure. Unconfirmed means the original
 * MAY have landed, so a one-click duplicate is too dangerous: the reader has to
 * open the disclosure and read what a second send costs before the button
 * exists. The action is also latched synchronously through a ref, so a double
 * activation is one request rather than two.
 */

import { useRef, useState } from 'react';
import { displayCallsign } from '../lib/callsign.ts';
import { cn } from '../lib/class-names.ts';
import { type LedgerBlockPlacement, ledgerPlacementCopy } from '../lib/ledger-placement.ts';
import { peerFrom } from '../lib/peer-message.ts';
import { sendBadge } from '../lib/send-badge.ts';
import { isLedgerUnconfirmed, type LedgerSendRecord } from '../lib/send-ledger.ts';
import { absoluteTime } from '../lib/session-screens.ts';

export const RESEND_RISK_COPY =
  'The original may still arrive. This creates a separate send with a new ID, so continue only if a duplicate is acceptable.';

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

export interface LedgerMessageProps {
  readonly record: LedgerSendRecord;
  readonly placement?: LedgerBlockPlacement;
  readonly asOf?: number;
  /** Answers true only when the daemon accepted the fresh-ID attempt. */
  readonly onResend?: (record: LedgerSendRecord) => Promise<boolean>;
}

export function LedgerMessage({
  record,
  placement = 'chronological',
  asOf = Date.now(),
  onResend,
}: LedgerMessageProps) {
  const { label, tone, detail } = sendBadge(record, asOf);
  const { from, body } = peerFrom(record.message);
  const boundary = ledgerPlacementCopy(placement);
  const actionHeld = useRef(false);
  const [resending, setResending] = useState(false);
  const [result, setResult] = useState<'accepted' | 'error' | null>(null);

  const resend = async (): Promise<void> => {
    if (!onResend || actionHeld.current) return;
    setResending(true);
    setResult(null);
    try {
      const accepted = await runResendOnce(actionHeld, () => onResend(record));
      if (accepted !== undefined) setResult(accepted ? 'accepted' : 'error');
    } catch {
      setResult('error');
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="kt-bubble-row" data-ledger-placement={placement}>
      <span className="sr-only">{from ? `${displayCallsign(from.name)} sent:` : 'You said:'}</span>
      <div className="kt-bubble">
        <div className="flex min-w-0 items-center gap-2 px-panel pt-1">
          {from ? (
            <span className="shrink-0 text-[10.5px] font-medium text-muted">{displayCallsign(from.name)}</span>
          ) : null}
          <span className="mono min-w-0 truncate text-[10.5px] tabular-nums text-faint">
            accepted {absoluteTime(record.acceptedAt)}
          </span>
          <span
            className={cn(
              'ml-auto inline-flex shrink-0 select-none items-center gap-1 rounded-sm border px-1.5 py-px text-[10.5px] font-medium leading-[1.5]',
              tone,
            )}
            title={detail}
          >
            {label}
          </span>
        </div>
        {boundary === undefined ? null : (
          <div className="px-panel pt-0.5 text-[10.5px] leading-snug text-muted" data-ledger-boundary>
            {boundary}
          </div>
        )}
        {body ? (
          <div className="kt-user-copy min-w-0 max-w-full whitespace-pre-wrap break-words px-panel pb-1.5 pt-0.5 text-[13px] leading-snug text-[color:var(--bubble-fg)]">
            {body}
          </div>
        ) : null}
        {/* The state is in the badge's colour AND here, because colour alone is
            not a reading. */}
        <span className="sr-only">{detail}</span>

        {isLedgerUnconfirmed(record, asOf) && onResend !== undefined && result !== 'accepted' ? (
          <details className="mx-panel mb-2 border-t border-border-soft pt-1.5 text-[11px] text-muted">
            <summary className="w-fit cursor-pointer select-none rounded-sm px-1.5 py-1 font-medium hover:bg-surface-2 hover:text-fg">
              resend…
            </summary>
            <div className="mt-1.5 rounded-control border border-warn-border bg-warn-bg px-2 py-1.5 text-warn">
              <p>{RESEND_RISK_COPY}</p>
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  className="rounded-sm border border-warn-border px-2 py-1 font-semibold hover:bg-surface disabled:cursor-wait disabled:opacity-60"
                  disabled={resending}
                  onClick={() => void resend()}
                  type="button"
                >
                  {resending ? 'resending…' : 'resend as a new message'}
                </button>
                <span>new send ID; the original stays unconfirmed</span>
              </div>
            </div>
          </details>
        ) : null}
        {result === 'accepted' ? (
          <div className="mx-panel mb-2 text-[11px] text-muted" role="status">
            New send accepted — awaiting its own confirmation. The original remains unconfirmed.
          </div>
        ) : null}
        {result === 'error' ? (
          <div className="mx-panel mb-2 text-[11px] text-err" role="alert">
            The resend was not accepted. The original remains unconfirmed.
          </div>
        ) : null}
      </div>
    </div>
  );
}
