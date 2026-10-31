/**
 * THE HISTORY UNDER AN OPEN AGENDA CARD — the conversation about the item, read like the chat: oldest first, the
 * latest at the bottom, just above the composer. ONLY THE OWNER'S messages are bubbles (right-aligned, like the
 * chat's own); the ferret's text is plain, under its name and the time, with no tool calls and no thinking — the
 * relevance rule that decides what is here is `itemHistory`'s. An edit is one quiet centred line, "Card updated to
 * v2", with what it changed in plain words under it. Never folded.
 */

import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import type { HistoryEvent } from '../../lib/agenda-history.ts';
import { revisionStamp } from '../../lib/agenda-revisions.ts';

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
  if (event.kind === 'revision') {
    return (
      <li className="fy-hist__sys" data-history="revision">
        <span>Card updated to v{event.version}</span>
        {event.summary.length === 0 ? null : (
          <ul className="fy-hist__changes">
            {event.summary.map(line => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </li>
    );
  }
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
  readonly event: HistoryEvent;
  readonly now: number;
  readonly ferret: string;
  readonly renderProse: (text: string) => ReactNode;
}

export function AgendaItemHistory({
  events,
  now,
  ferret,
  renderProse,
}: {
  readonly events: readonly HistoryEvent[];
  readonly now: number;
  readonly ferret: string;
  readonly renderProse: (text: string) => ReactNode;
}) {
  if (events.length === 0) return null;
  return (
    <section aria-label="History" className="fy-hist" data-agenda-history="">
      <ol className="fy-hist__list">
        {events.map(event => (
          <HistoryRow event={event} ferret={ferret} key={event.key} now={now} renderProse={renderProse} />
        ))}
      </ol>
    </section>
  );
}
