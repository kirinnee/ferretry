/**
 * The foot of one of the reader's own bubbles: its time, small and faded, then its receipt mark —
 * `14:02 ✓✓`. It replaces a header row ("You · 14:02:55") and a pill ("delivered") that between them
 * took two lines of every message the reader sent.
 *
 * The time and the mark are ONE button. A tap (a phone has no hover) reads out what a tooltip says on
 * a desktop: the time to the second and why the mark is what it is. A state that needs the reader also
 * wears a small word before the mark (`sendReceipt`'s `chip`); its actions live on the bubble itself.
 */

import { Check, CheckCheck, CircleAlert, CircleHelp, Clock3 } from 'lucide-react';
import { useState } from 'react';
import type { LedgerSendRecord } from '../lib/send-ledger.ts';
import { type MessageClock, type SendReceiptKind, sendReceipt } from '../lib/send-receipt.ts';

const MARK: Readonly<Record<SendReceiptKind, typeof Check>> = {
  sending: Clock3,
  held: Clock3,
  queued: Check,
  delivered: CheckCheck,
  read: CheckCheck,
  unconfirmed: CircleHelp,
  failed: CircleAlert,
};

export interface MessageFooterProps {
  /** When the message was sent; absent when nothing recorded a time. */
  readonly clock?: MessageClock | undefined;
  /** The send this message is, when the daemon's ledger knows it. */
  readonly record?: LedgerSendRecord | undefined;
  /** The agent has replied after this message — a delivered send reads as `read`. */
  readonly answered?: boolean;
}

export function MessageFooter({ clock, record, answered = false }: MessageFooterProps) {
  const [open, setOpen] = useState(false);
  if (record === undefined) {
    if (clock === undefined) return null;
    return (
      <div className="fy-receipt-line" data-message-footer="">
        <time className="fy-receipt" title={clock.full}>
          {clock.short}
        </time>
      </div>
    );
  }
  const receipt = sendReceipt(record, answered);
  const Mark = MARK[receipt.kind];
  const sent = clock === undefined ? undefined : `sent ${clock.full}`;
  return (
    <>
      <div className="fy-receipt-line" data-message-footer="">
        {receipt.chip === undefined ? null : (
          <span className="fy-receipt-chip" data-send-chip={receipt.kind}>
            {receipt.chip}
          </span>
        )}
        <button
          aria-expanded={open}
          aria-label={sent === undefined ? receipt.name : `${receipt.name}, ${sent}`}
          className="fy-receipt"
          data-send-fate={record.fate}
          data-send-receipt={receipt.kind}
          onClick={() => setOpen(current => !current)}
          title={[receipt.name, receipt.detail, sent].filter(line => line !== undefined).join('\n')}
          type="button"
        >
          {clock === undefined ? null : <time aria-hidden="true">{clock.short}</time>}
          <Mark aria-hidden="true" className="fy-receipt-mark" size={14} strokeWidth={2.25} />
        </button>
      </div>
      {open ? (
        <p className="fy-receipt-detail" data-send-reason="">
          {sent === undefined ? receipt.detail : `${receipt.name} · ${sent} — ${receipt.detail}`}
        </p>
      ) : (
        <span className="sr-only">{receipt.detail}</span>
      )}
    </>
  );
}
