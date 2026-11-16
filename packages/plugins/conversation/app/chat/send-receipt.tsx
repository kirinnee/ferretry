/**
 * The foot of a message: its time, small and faded, then — on the reader's own messages — the receipt
 * mark: `14:02 ✓✓`. ONE RULE FOR BOTH SIDES: the sender's name is a small muted line above a message and
 * the time sits at its foot, so the reader's bubble, the agent's reply, a peer's message and a notice
 * all read the same way and none carries a header full of seconds.
 *
 * The time (and the mark, when there is one) is ONE button. A tap (a phone has no hover) reads out what a
 * tooltip says on a desktop: the full local date and time to the second, and for a send why the mark is
 * what it is. A state that needs the reader also wears a small word before the mark (`sendReceipt`'s
 * `chip`); its actions live on the bubble itself.
 */

import { type ReactNode, useState } from 'react';
import type { MessageClock } from '@ferretry/app';
import type { LedgerSendRecord } from './send-ledger.ts';
import { type SendReceipt, sendReceipt } from './send-receipt-model.ts';
import { ReceiptMark } from '@ferretry/app';

export interface MessageFooterProps {
  /** When the message was sent; absent when nothing recorded a time. */
  readonly clock?: MessageClock | undefined;
  /** The send this message is, when the daemon's ledger knows it. */
  readonly record?: LedgerSendRecord | undefined;
  /** The agent has replied after this message — a delivered send reads as `answered`. */
  readonly answered?: boolean;
  /** Which side of the transcript the message sits on; the foot lines up with its bubble. */
  readonly side?: 'own' | 'other';
  /** A delivery note that shares this line, at its left edge ("via turn file"), so extra meta never takes a row of its own. */
  readonly lead?: ReactNode;
  /** What the lead says when it is opened, shown under the line. */
  readonly leadDetail?: ReactNode;
  /** A small control that ends the line, after the receipt mark — a send's "⋯" actions button. */
  readonly trailing?: ReactNode;
  /**
   * The mark itself, for words the ledger holds no `record` of but whose state is known another way (an agenda item's
   * conversation, `itemWordsReceipt`). A `record` always wins.
   */
  readonly receipt?: SendReceipt | undefined;
}

export function MessageFooter({
  clock,
  record,
  answered = false,
  side = 'own',
  lead,
  leadDetail,
  trailing,
  receipt: known,
}: MessageFooterProps) {
  const [open, setOpen] = useState(false);
  const receipt = record === undefined ? known : sendReceipt(record, answered);
  if (receipt === undefined) {
    if (clock === undefined && lead === undefined) return null;
    return (
      <>
        <div className="fy-receipt-line" data-message-footer="" data-side={side}>
          {lead}
          {clock === undefined ? null : (
            <button
              aria-expanded={open}
              aria-label={`Sent ${clock.full}`}
              className="fy-receipt"
              onClick={() => setOpen(current => !current)}
              title={clock.full}
              type="button"
            >
              <time aria-hidden="true">{clock.short}</time>
            </button>
          )}
        </div>
        {leadDetail}
        {open && clock !== undefined ? (
          <p className="fy-receipt-detail" data-side={side} data-time-full="">
            {clock.full}
          </p>
        ) : null}
      </>
    );
  }
  const sent = clock === undefined ? undefined : `sent ${clock.full}`;
  return (
    <>
      <div className="fy-receipt-line" data-message-footer="" data-side={side}>
        {lead}
        {receipt.chip === undefined ? null : (
          <span className="fy-receipt-chip" data-send-chip={receipt.kind}>
            {receipt.chip}
          </span>
        )}
        <button
          aria-expanded={open}
          aria-label={sent === undefined ? receipt.name : `${receipt.name}, ${sent}`}
          className="fy-receipt"
          data-send-fate={record?.fate}
          data-send-receipt={receipt.kind}
          onClick={() => setOpen(current => !current)}
          title={[receipt.name, receipt.detail, sent].filter(line => line !== undefined).join('\n')}
          type="button"
        >
          {clock === undefined ? null : <time aria-hidden="true">{clock.short}</time>}
          <ReceiptMark className="fy-receipt-mark" kind={receipt.kind} />
        </button>
        {trailing}
      </div>
      {leadDetail}
      {receipt.note === undefined ? null : (
        <p className="fy-receipt-note" data-migration-note="" data-side={side}>
          {receipt.note}
        </p>
      )}
      {open ? (
        <p className="fy-receipt-detail" data-send-reason="" data-side={side}>
          {sent === undefined ? receipt.detail : `${receipt.name} · ${sent} — ${receipt.detail}`}
        </p>
      ) : receipt.note === receipt.detail ? null : (
        <span className="sr-only">{receipt.detail}</span>
      )}
    </>
  );
}
