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
import { clockOfInstant } from '../lib/message-clock.ts';
import type { SentMessage, SentState } from '../lib/peer-delivery.ts';
import type { TranscriptEntry } from '../lib/session-screens.ts';
import type { SendReceiptKind } from '../lib/send-receipt.ts';
import { PeerName } from './agent-message-rows.tsx';
import { Markdown } from './markdown.tsx';
import { ReceiptMark } from './receipt-mark.tsx';
import { useReferenceSurface } from './reference-surface.tsx';
import { MessageFooter } from './send-receipt.tsx';
import { ToolGroup } from './tool-group.tsx';

/** How each state reads, and the receipt mark it wears. */
const STATES: Readonly<Record<SentState, { readonly word: string; readonly mark: SendReceiptKind }>> = {
  sending: { word: 'Sending…', mark: 'sending' },
  queued: { word: 'Queued — it reads this when its current turn ends', mark: 'queued' },
  delivered: { word: 'Delivered', mark: 'delivered' },
  replied: { word: 'Replied', mark: 'answered' },
  failed: { word: 'Not delivered', mark: 'failed' },
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
  const state = STATES[sent.state];
  return (
    <article
      className="fy-message fy-message-sent"
      data-sent-state={sent.state}
      data-transcript-kind="sent"
      {...rhythm}
    >
      <header>
        <span className="fy-sent-label">Sent to</span>
        <PeerName peer={{ name: sent.to }} surface={surface} />
        {sent.ask ? <span className="fy-peer-kind">waiting for a reply</span> : null}
      </header>
      {sent.body === null ? (
        <p className="fy-sent-unseen">{unseenBody(sent)}</p>
      ) : (
        <Markdown className="fy-sent-body" text={sent.body} {...surface} />
      )}
      <p className="fy-sent-state" data-sent-state={sent.state} role={sent.state === 'failed' ? 'alert' : undefined}>
        <ReceiptMark className="fy-sent-mark" kind={state.mark} />
        <span>
          {state.word}
          {sent.reason === undefined || sent.reason === '' ? null : (
            <span className="fy-sent-reason"> — {sent.reason}</span>
          )}
        </span>
      </p>
      <div className="fy-sent-foot">
        <button
          aria-expanded={showCommand}
          className="fy-sent-command-toggle"
          onClick={() => setShowCommand(current => !current)}
          type="button"
        >
          {showCommand ? 'Hide command' : 'Show command'}
        </button>
        <MessageFooter clock={clockOfInstant(entry.at)} side="other" />
      </div>
      {showCommand && entry.tools !== undefined ? <ToolGroup calls={entry.tools} isLast={isLast} live={live} /> : null}
    </article>
  );
}
