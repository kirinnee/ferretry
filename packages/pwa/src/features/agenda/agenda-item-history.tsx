/**
 * THE CONVERSATION OF AN OPEN AGENDA ITEM — the owner's and the ferret's words about it, read like the chat: oldest
 * first. ONLY THE OWNER'S messages are bubbles (right-aligned, like the chat's own); the ferret's text is plain, under
 * its name and the time, with no tool calls and no thinking — the relevance rule that decides what is here is
 * `itemHistory`'s. Every reply is drawn WHOLE: nothing is cut, however long. Never folded.
 *
 * The edits ("Card updated to v2") are not words anyone said: they are the activity log's (`agenda-activity-log.tsx`).
 */

import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import type { HistoryEvent } from '../../lib/agenda-history.ts';
import { revisionStamp } from '../../lib/agenda-revisions.ts';

type SpokenEvent = Exclude<HistoryEvent, { readonly kind: 'revision' }>;

/** What was SAID, of the item's history: the owner's and the ferret's words, never an edit. */
const spokenEvents = (events: readonly HistoryEvent[]): readonly SpokenEvent[] =>
  events.filter((event): event is SpokenEvent => event.kind !== 'revision');

const stampOf = (at: number, now: number): string => (at === 0 ? '' : revisionStamp(new Date(at).toISOString(), now));

function When({ at, now }: { readonly at: number; readonly now: number }) {
  const stamp = stampOf(at, now);
  return stamp === '' ? null : (
    <time className="fy-hist__time" dateTime={new Date(at).toISOString()}>
      {stamp}
    </time>
  );
}

function HistoryRow({ event, now, ferret, renderProse }: HistoryRowProps) {
  if (event.kind === 'owner') {
    const chosen = event.form === 'answer' || event.form === 'done';
    return (
      <li className="fy-hist__me" data-history="owner" data-history-kind={event.form}>
        <p className="fy-hist__said m-0">
          {chosen ? <Check aria-hidden="true" className="fy-hist__check" size={14} strokeWidth={2.5} /> : null}
          {event.text}
        </p>
        {event.note === undefined ? null : <p className="fy-hist__note m-0">{event.note}</p>}
        <When at={event.at} now={now} />
      </li>
    );
  }
  return (
    <li className="fy-hist__ag" data-history="ferret">
      <p className="fy-hist__who m-0">
        <span>{ferret}</span>
        <When at={event.at} now={now} />
      </p>
      <div className="fy-hist__text">{renderProse(event.text)}</div>
    </li>
  );
}

interface HistoryRowProps {
  readonly event: SpokenEvent;
  readonly now: number;
  readonly ferret: string;
  readonly renderProse: (text: string) => ReactNode;
}

export function AgendaItemHistory({
  events,
  now,
  ferret,
  renderProse,
  title = 'Conversation',
}: {
  readonly events: readonly HistoryEvent[];
  readonly now: number;
  readonly ferret: string;
  readonly renderProse: (text: string) => ReactNode;
  /** The part's heading. */
  readonly title?: string;
}) {
  const spoken = spokenEvents(events);
  if (spoken.length === 0) return null;
  return (
    <section
      aria-label={title}
      className="fy-card__part fy-hist"
      data-agenda-history=""
      data-agenda-part="conversation"
    >
      <h4 className="fy-card__label fy-card__part-title">{title}</h4>
      <ol className="fy-hist__list">
        {spoken.map(event => (
          <HistoryRow event={event} ferret={ferret} key={event.key} now={now} renderProse={renderProse} />
        ))}
      </ol>
    </section>
  );
}
