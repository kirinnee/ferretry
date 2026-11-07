/**
 * A message this ferret SENT another, shown as what it is instead of the shell command that sent it.
 *
 * The ferret runs the CLI's `send` in its shell, so the transcript holds a tool call reading
 * `Bash · fy send tanna "…"` — a command the reader has to parse to learn that a message went out, to
 * whom, and whether it arrived. This card says those three things: "Sent to" and the recipient as a
 * proved `:name` reference, the message, and where it got to, drawn with the same receipt marks the
 * reader's own messages wear. A failure names its reason in the CLI's own words.
 *
 * The call it came from is still one tap away, under "Show command", because a card that hid the
 * command entirely would leave the reader nothing to check it against (`peer-delivery.ts` reads it).
 */

import { useState } from 'react';
import { displayCallsign } from '../transcript/callsign.ts';
import { clockOfInstant } from '@ferretry/app';
import type { SentMessage, SentState } from './peer-delivery.ts';
import type { SendReceiptKind } from './send-receipt-model.ts';
import type { TranscriptEntry } from './transcript-entries.ts';
import { PeerName } from '../transcript/agent-message-rows.tsx';
import { Markdown } from '@ferretry/app';
import { ReceiptMark } from '@ferretry/app';
import { useReferenceSurface } from '@ferretry/app';
import { MessageFooter } from './send-receipt.tsx';
import { ToolGroup } from './tool-group.tsx';

/**
 * How each state reads: one short word on the card's one-line foot (&F949), the whole meaning on hover and to a screen
 * reader, and the receipt mark it wears.
 */
const STATES: Readonly<
  Record<SentState, { readonly word: string; readonly detail?: string; readonly mark: SendReceiptKind }>
> = {
  sending: { word: 'Sending…', mark: 'sending' },
  queued: { word: 'Queued', detail: 'it reads this when its current turn ends', mark: 'queued' },
  held: { word: 'Held', mark: 'queued' },
  delivered: { word: 'Delivered', mark: 'delivered' },
  replied: { word: 'Replied', mark: 'answered' },
  failed: { word: 'Not delivered', mark: 'failed' },
};

/**
 * Why a held send waits: an FYI for the receiver's turn to end, an action for the batch's time (&B157). The foot's
 * visible word stays "Held" so the line stays one line on a phone (&F949); this is the tooltip and the screen reader's.
 */
const heldDetail = (sent: SentMessage): string | undefined => {
  if (sent.hold?.kind === 'fyi') return `delivered when ${displayCallsign(sent.to)}'s turn ends`;
  if (sent.hold?.kind === 'batch') return `delivered at ${sent.hold.until}, batched with its other messages`;
  return undefined;
};

/** What a send's body says when this reader could not see the words. */
const unseenBody = (sent: SentMessage): string =>
  sent.messageFile === undefined
    ? 'The message was composed by a shell command.'
    : `The message was read from ${sent.messageFile}.`;

export function SentMessageRow({
  entry,
  sent,
  rhythm,
  live = false,
  isLast = false,
}: {
  readonly entry: TranscriptEntry;
  readonly sent: SentMessage;
  readonly rhythm: Record<string, string | undefined>;
  readonly live?: boolean;
  readonly isLast?: boolean;
}) {
  const surface = useReferenceSurface();
  const [showCommand, setShowCommand] = useState(false);
  // A held send says when it goes, in the CLI's terms: true when it was sent, and all the sender knows (&B157 — GAP:
  // the card does not follow it to Delivered; that is the receiver's send ledger, read from the sender's chat).
  const known = STATES[sent.state];
  const heldWhy = sent.state === 'held' ? heldDetail(sent) : undefined;
  const state = heldWhy === undefined ? known : { ...known, detail: heldWhy };
  const reason = sent.state === 'failed' && sent.reason !== undefined && sent.reason !== '' ? sent.reason : undefined;
  return (
    <article
      className="fy-message fy-message-sent"
      data-sent-state={sent.state}
      data-transcript-kind="sent"
      {...rhythm}
    >
      <header className="fy-sent-head">
        <span className="fy-sent-label">Sent to</span>
        <PeerName peer={{ name: sent.to }} surface={surface} />
        {sent.ask ? <span className="fy-peer-kind">waiting for a reply</span> : null}
      </header>
      {sent.body === null ? (
        <p className="fy-sent-unseen">{unseenBody(sent)}</p>
      ) : (
        <Markdown className="fy-sent-body" text={sent.body} {...surface} />
      )}
      {/* ONE LINE (&F949): where it got to · Show command, the time at the right. A failure's reason, in the CLI's own
          words, is the one thing that takes a line of its own. */}
      <div className="fy-sent-foot">
        <span
          className="fy-sent-state"
          data-sent-state={sent.state}
          role={sent.state === 'failed' ? 'alert' : undefined}
          title={state.detail === undefined ? state.word : `${state.word} — ${state.detail}`}
        >
          <ReceiptMark className="fy-sent-mark" kind={state.mark} />
          <span className="fy-sent-word">
            {state.word}
            {state.detail === undefined ? null : <span className="sr-only"> — {state.detail}</span>}
            {/* The alert says why, too: the visible reason below is drawn for the eye only. */}
            {reason === undefined ? null : <span className="sr-only">: {reason}</span>}
          </span>
        </span>
        {/* The separator belongs to the item AFTER it, so a foot that must wrap never strands it at a line's end. */}
        <span className="fy-sent-command">
          <span aria-hidden="true" className="fy-sent-dot">
            ·
          </span>
          <button
            aria-expanded={showCommand}
            className="fy-sent-command-toggle"
            onClick={() => setShowCommand(current => !current)}
            type="button"
          >
            {showCommand ? 'Hide command' : 'Show command'}
          </button>
        </span>
        <MessageFooter clock={clockOfInstant(entry.at)} side="other" />
      </div>
      {reason === undefined ? null : (
        <p aria-hidden="true" className="fy-sent-reason" data-sent-reason="">
          {reason}
        </p>
      )}
      {showCommand && entry.tools !== undefined ? <ToolGroup calls={entry.tools} isLast={isLast} live={live} /> : null}
    </article>
  );
}
