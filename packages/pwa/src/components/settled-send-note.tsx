/**
 * A terminal send — cancelled, or given up on — folded to ONE line in the timeline where it was sent:
 * "Cancelled · hi · 23:57 · ×". It is not part of the live conversation, so it takes a line and nothing
 * more; opening it (tap the line) draws the whole bubble again with its Retry and Copy, and the × puts it
 * away for good on this device. No confirmation: it is a message the reader already gave up on.
 */

import { ChevronDown, X } from 'lucide-react';
import { clockOfInstant } from '../lib/message-clock.ts';
import { peerFrom } from '../lib/peer-message.ts';
import type { LedgerSendRecord } from '../lib/send-ledger.ts';
import { sendReceipt } from '../lib/send-receipt.ts';
import { ReceiptMark } from './receipt-mark.tsx';

/** Stops showing a send on this device. */
export type SendDismiss = (record: LedgerSendRecord) => void;

/** Opens (`true`) or folds (`false`) one settled send. */
export type SendExpand = (record: LedgerSendRecord, open: boolean) => void;

export interface SettledSendNoteProps {
  readonly record: LedgerSendRecord;
  readonly onDismiss?: SendDismiss | undefined;
  readonly onExpand?: SendExpand | undefined;
}

export function SettledSendNote({ record, onDismiss, onExpand }: SettledSendNoteProps) {
  const receipt = sendReceipt(record);
  const { body } = peerFrom(record.message);
  const clock = clockOfInstant(record.acceptedAt);
  const said = body.replace(/\s+/gu, ' ').trim();
  return (
    <div className="fy-settled-note" data-send-id={record.sendId} data-settled-note={receipt.kind}>
      <button
        aria-label={`${receipt.name}: ${said}. Show the message`}
        className="fy-settled-open"
        disabled={onExpand === undefined}
        onClick={() => onExpand?.(record, true)}
        title={[receipt.name, receipt.detail].join('\n')}
        type="button"
      >
        <ReceiptMark className="fy-receipt-mark" kind={receipt.kind} />
        <span className="fy-settled-name">{receipt.name}</span>
        <span aria-hidden="true">·</span>
        <span className="fy-settled-text">{said}</span>
        {clock === undefined ? null : (
          <>
            <span aria-hidden="true">·</span>
            <time className="fy-settled-time">{clock.short}</time>
          </>
        )}
        {onExpand === undefined ? null : <ChevronDown aria-hidden="true" size={12} />}
      </button>
      {onDismiss === undefined ? null : (
        <button
          aria-label="Dismiss"
          className="fy-settled-dismiss"
          data-settled-dismiss=""
          onClick={() => onDismiss(record)}
          title="Dismiss"
          type="button"
        >
          <X aria-hidden="true" size={14} />
        </button>
      )}
    </div>
  );
}
