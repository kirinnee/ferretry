/**
 * THE TWO ROW SHAPES OF AN ITEM'S CONVERSATION, in the chat's own markup (today's `OwnMessageRow` and
 * `TranscriptTextRow`, `MessageFooter` and `itemWordsReceipt`): the owner's words are a bubble with its time and its
 * receipt mark at the foot; the ferret's are text with its name above and its time below. The chat's rows are
 * Conversation's, so this half keeps its own small copy of their shape — the same classes and the same foot — rather
 * than importing them; the receipt claims only what the item knows (`historyReceipt`).
 */

import { Check, CheckCheck, Clock } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { clockOfInstant } from '../../shell.ts';
import type { LedgerSendRecord } from '../../lib/transcript.ts';

/** How far the owner's words got, as far as the item knows. */
export interface OwnerWordsReach {
  readonly via: 'transcript' | 'item';
  readonly answered: boolean;
  readonly send?: LedgerSendRecord | undefined;
}

export interface HistoryReceipt {
  readonly kind: 'read' | 'queued' | 'delivered' | 'answered' | 'sending' | 'failed';
  readonly name: string;
  readonly detail: string;
}

/** The mark the owner's words carry: the chat's ledger when it recorded the send, else what the item itself says. */
const historyReceipt = (reached: OwnerWordsReach | undefined): HistoryReceipt => {
  const send = reached?.send;
  if (send !== undefined) {
    if (send.fate === 'delivered')
      return reached?.answered === true
        ? { kind: 'answered', name: 'Answered', detail: 'typed into the agent; the agent has replied since' }
        : { kind: 'delivered', name: 'Delivered', detail: 'typed into the agent and submitted' };
    if (send.fate === 'queued') return { kind: 'queued', name: 'Queued', detail: 'on the machine’s queue' };
    if (send.fate === 'timed_out' || send.fate === 'cancelled')
      return { kind: 'failed', name: 'Not delivered', detail: 'the machine did not deliver it' };
    return { kind: 'sending', name: 'Sending', detail: 'on its way' };
  }
  if (reached?.via === 'transcript')
    return { kind: 'read', name: 'Read', detail: 'the ferret’s transcript shows it as a message from you' };
  if (reached?.answered === true)
    return { kind: 'answered', name: 'Answered', detail: 'kept on this item; the ferret has replied since' };
  return { kind: 'queued', name: 'On the machine', detail: 'kept on this item; the ferret has not replied to it yet' };
};

function ReceiptMark({ kind }: { readonly kind: HistoryReceipt['kind'] }) {
  if (kind === 'sending') return <Clock aria-hidden="true" className="fy-receipt-mark" size={12} />;
  if (kind === 'queued') return <Check aria-hidden="true" className="fy-receipt-mark" size={12} />;
  return <CheckCheck aria-hidden="true" className="fy-receipt-mark" data-receipt-mark={kind} size={12} />;
}

/** The foot of a row: its time, and — on the owner's words — the receipt mark that opens what it means. */
function MessageFoot({
  at,
  receipt,
  record,
  side,
}: {
  readonly at: number;
  readonly receipt?: HistoryReceipt;
  readonly record?: LedgerSendRecord | undefined;
  readonly side: 'own' | 'other';
}) {
  const [open, setOpen] = useState(false);
  const clock = at === 0 ? undefined : clockOfInstant(at);
  if (receipt === undefined) {
    if (clock === undefined) return null;
    return (
      <div className="fy-receipt-line" data-message-footer="" data-side={side}>
        <time dateTime={new Date(at).toISOString()} title={clock.full}>
          {clock.short}
        </time>
      </div>
    );
  }
  const sent = clock === undefined ? undefined : `sent ${clock.full}`;
  return (
    <>
      <div className="fy-receipt-line" data-message-footer="" data-side={side}>
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
          <ReceiptMark kind={receipt.kind} />
        </button>
      </div>
      {open ? (
        <p className="fy-receipt-detail" data-send-reason="" data-side={side}>
          {sent === undefined ? receipt.detail : `${receipt.name} · ${sent} — ${receipt.detail}`}
        </p>
      ) : (
        <span className="sr-only">{receipt.detail}</span>
      )}
    </>
  );
}

/** The owner's words: the chat's bubble, its time and its receipt at the foot. */
export function OwnWordsRow({
  at,
  reached,
  children,
}: {
  readonly at: number;
  readonly reached: OwnerWordsReach | undefined;
  readonly children: ReactNode;
}) {
  return (
    <article className="fy-message fy-message-user" data-transcript-kind="user">
      <span className="sr-only">You said:</span>
      {children}
      <MessageFoot at={at} receipt={historyReceipt(reached)} record={reached?.send} side="own" />
    </article>
  );
}

/** The ferret's (or Ferretry's) words: the chat's agent text, the name small above and the time at the foot. */
export function AgentWordsRow({
  at,
  label,
  aside,
  children,
}: {
  readonly at: number;
  readonly label: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <article className="fy-message fy-message-assistant" data-transcript-kind="assistant">
      <header className="fy-message__label">{label}</header>
      {aside}
      {children}
      <MessageFoot at={at} side="other" />
    </article>
  );
}
