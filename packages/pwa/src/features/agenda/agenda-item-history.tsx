/**
 * THE HISTORY AT THE FOOT OF AN ITEM VIEW — THE CONVERSATION about it: what the owner said and what the ferret said,
 * as the chat's own bubbles (no tool calls, no thinking), oldest first, with the item's own events (raised, edited) as
 * small dividers between them. What an edit changed is in the Revisions view below. Nothing here is a second source:
 * `itemHistory` reads the item's revisions and the chat.
 *
 * It is never folded: every event is drawn, in order, as the conversation it replaces.
 */

import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { AGENDA_KIND_LABEL } from '../../components/agenda-message.tsx';
import { TranscriptRow } from '../../components/transcript-row.tsx';
import type { HistoryEvent } from '../../lib/agenda-history.ts';
import { revisionAuthor, revisionStamp } from '../../lib/agenda-revisions.ts';

const stampOf = (at: number, now: number): string => (at === 0 ? '' : revisionStamp(new Date(at).toISOString(), now));

function When({ at, now }: { readonly at: number; readonly now: number }) {
  const stamp = stampOf(at, now);
  return stamp === '' ? null : <time dateTime={new Date(at).toISOString()}>{stamp}</time>;
}

/** Who an event is credited to: the ferret by its name, the owner as "You". */
const doer = (by: 'human' | 'agent' | 'daemon', ferret: string): string =>
  by === 'agent' ? ferret : revisionAuthor(by);

/** An event of the item itself — raised, edited — as a small divider between the bubbles. */
function Divider({ kind, at, now, children }: DividerProps) {
  return (
    <li className="fy-item-history__divider" data-history={kind}>
      <span className="fy-item-history__divider-text">
        {children}
        <When at={at} now={now} />
      </span>
    </li>
  );
}

interface DividerProps {
  readonly kind: 'raised' | 'revision';
  readonly at: number;
  readonly now: number;
  readonly children: ReactNode;
}

function HistoryRow({ event, now, ferret }: HistoryRowProps) {
  if (event.kind === 'raised') {
    return (
      <Divider at={event.at} kind="raised" now={now}>
        <span>Raised by {event.by === 'human' ? 'you' : doer(event.by, ferret)}</span>
      </Divider>
    );
  }
  if (event.kind === 'revision') {
    const { entry } = event;
    return (
      <Divider at={event.at} kind="revision" now={now}>
        <span>
          {doer(entry.by, ferret)} edited {entry.changed.map(change => change.label.toLowerCase()).join(', ')}
        </span>
      </Divider>
    );
  }
  // What was said in the conversation is drawn by the chat's own row: the same bubble, clock, pictures and
  // references as in the chat, so the item reads like the conversation it replaces.
  if (event.kind === 'ferret') {
    return (
      <li className="fy-item-history__event fy-item-history__chat" data-history="ferret">
        <TranscriptRow entry={{ ...event.entry, label: ferret }} />
      </li>
    );
  }
  if (event.kind === 'owner-text') {
    return (
      <li className="fy-item-history__event fy-item-history__chat" data-history="owner">
        <TranscriptRow entry={event.entry} />
      </li>
    );
  }
  const { part } = event;
  const chosen = part.kind === 'answer' || part.kind === 'done';
  return (
    <li className="fy-item-history__event" data-history="owner" data-history-kind={part.kind}>
      <p className="fy-item-history__head m-0">
        <When at={event.at} now={now} />
        <span>You · {AGENDA_KIND_LABEL[part.kind]}</span>
      </p>
      {part.text === '' ? null : chosen ? (
        <p className="fy-item-history__bubble m-0">
          <span className="fy-item-history__choice">
            <Check aria-hidden="true" size={14} strokeWidth={2.5} />
            {part.text}
          </span>
        </p>
      ) : (
        <p className="fy-item-history__bubble m-0">{part.text}</p>
      )}
      {part.note === undefined ? null : <p className="fy-item-history__note m-0">Note: {part.note}</p>}
    </li>
  );
}

interface HistoryRowProps {
  readonly event: HistoryEvent;
  readonly now: number;
  readonly ferret: string;
}

export function AgendaItemHistory({
  events,
  now,
  ferret,
}: {
  readonly events: readonly HistoryEvent[];
  readonly now: number;
  readonly ferret: string;
}) {
  if (events.length === 0) return null;
  return (
    <section aria-label="History" className="fy-item-history" data-agenda-history="">
      <h3 className="fy-item-history__title m-0">History</h3>
      <ol className="fy-item-history__list">
        {events.map(event => (
          <HistoryRow event={event} ferret={ferret} key={event.key} now={now} />
        ))}
      </ol>
    </section>
  );
}
