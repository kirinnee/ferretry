/**
 * "LAST MESSAGES FROM <FERRET>": a fold at the end of a card's detail that shows the last few things the
 * ferret said — words only — so the reader can see what led up to an item without leaving the page.
 *
 * Nothing is read until the fold is opened, and it is read again each time it opens (the reader
 * remembers its walk, so a re-read is one page). The conversation itself is a link away, on the card.
 */

import { ChevronRight } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { ChatProse } from '../../components/chat-prose.tsx';
import { Spinner } from '../../components/spinner.tsx';
import type { RecentMessage } from '../../lib/recent-messages.ts';
import { attentionAge } from './attention-board.tsx';

/** How much of one message the fold shows; the rest is in the conversation. */
const RECENT_MESSAGE_CHARS = 1_200;

const clipMessage = (text: string): string =>
  text.length <= RECENT_MESSAGE_CHARS ? text : `${text.slice(0, RECENT_MESSAGE_CHARS).trimEnd()}…`;

/** "7h ago", "now": how long ago a message was written, or nothing when the row has no time. */
const ago = (timestamp: string | undefined, now: number | undefined): string | null => {
  if (timestamp === undefined) return null;
  const age = attentionAge(timestamp, now).replace(/^waiting /u, '');
  return age === 'now' ? 'just now' : `${age} ago`;
};

type Reading =
  | { readonly state: 'reading' }
  | { readonly state: 'ready'; readonly messages: readonly RecentMessage[] }
  | { readonly state: 'failed'; readonly message: string };

export interface AttentionRecentMessagesProps {
  readonly ferret: string;
  readonly read: () => Promise<readonly RecentMessage[]>;
  readonly now?: number;
  /** Starts open (a harness); closed otherwise. */
  readonly initiallyOpen?: boolean;
}

export function AttentionRecentMessages({ ferret, read, now, initiallyOpen = false }: AttentionRecentMessagesProps) {
  const bodyId = useId();
  const [open, setOpen] = useState(initiallyOpen);
  const [reading, setReading] = useState<Reading>({ state: 'reading' });

  const load = (): void => {
    setReading(current => (current.state === 'ready' ? current : { state: 'reading' }));
    read().then(
      messages => setReading({ state: 'ready', messages }),
      (error: unknown) =>
        setReading({ state: 'failed', message: error instanceof Error ? error.message : String(error) }),
    );
  };
  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next) load();
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a fold that starts open reads on mount
  useEffect(() => {
    if (initiallyOpen) load();
  }, []);

  return (
    <section className="fy-attn-recent" data-attention-recent="">
      <button
        aria-controls={bodyId}
        aria-expanded={open}
        className="fy-attn-recent__toggle"
        data-attention-recent-toggle=""
        onClick={toggle}
        type="button"
      >
        <ChevronRight aria-hidden="true" className="fy-attn-recent__chevron" data-open={open || undefined} size={14} />
        Last messages from {ferret}
      </button>
      {open ? (
        <div className="fy-attn-recent__body" id={bodyId}>
          {reading.state === 'reading' ? (
            <p className="fy-attn-recent__note" role="status">
              <Spinner size={14} />
              Reading {ferret}’s conversation…
            </p>
          ) : reading.state === 'failed' ? (
            <p className="fy-attn-recent__note" role="alert">
              Couldn’t read the conversation: {reading.message}
            </p>
          ) : reading.messages.length === 0 ? (
            <p className="fy-attn-recent__note">{ferret} hasn’t written anything yet.</p>
          ) : (
            <ol className="fy-attn-recent__list" data-attention-recent-list="">
              {reading.messages.map((message, index) => {
                const when = ago(message.timestamp, now);
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the last few messages, in order; none moves
                  <li className="fy-attn-recent__message" data-attention-recent-message="" key={index}>
                    {when === null ? null : <span className="fy-attn-recent__when">{when}</span>}
                    <ChatProse text={clipMessage(message.text)} />
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      ) : null}
    </section>
  );
}
