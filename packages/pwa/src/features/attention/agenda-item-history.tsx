/**
 * THE HISTORY AT THE FOOT OF AN ITEM VIEW: what changed on the item, what the owner said about it and what the
 * ferret answered, oldest first so it reads like the conversation it replaces. Nothing here is a second source:
 * `itemHistory` reads the item's revisions and the chat.
 */

import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { AGENDA_KIND_LABEL } from '../../components/agenda-message.tsx';
import type { HistoryEvent } from '../../lib/agenda-history.ts';
import { revisionAuthor, revisionStamp } from '../../lib/attention-revisions.ts';
import { PointForm } from './attention-brief.tsx';

const stampOf = (at: number, now: number): string => (at === 0 ? '' : revisionStamp(new Date(at).toISOString(), now));

function When({ at, now }: { readonly at: number; readonly now: number }) {
  const stamp = stampOf(at, now);
  return stamp === '' ? null : <time dateTime={new Date(at).toISOString()}>{stamp}</time>;
}

function HistoryRow({ event, now, ferret, prose }: HistoryRowProps) {
  if (event.kind === 'revision') {
    const { entry } = event;
    return (
      <li className="fy-item-history__event" data-history="revision">
        <p className="fy-item-history__head m-0">
          <When at={event.at} now={now} />
          <span>
            {revisionAuthor(entry.by)} changed {entry.changed.map(change => change.label).join(', ')}
          </span>
        </p>
        <dl className="fy-item-history__was m-0">
          {entry.changed.map(change => (
            <div key={change.field}>
              {change.before === null ? (
                <dt>{change.label} was empty</dt>
              ) : (
                <>
                  <dt>{change.label} was</dt>
                  <dd className="m-0">
                    <PointForm text={change.before} />
                  </dd>
                </>
              )}
            </div>
          ))}
        </dl>
      </li>
    );
  }
  if (event.kind === 'ferret') {
    return (
      <li className="fy-item-history__event" data-history="ferret">
        <p className="fy-item-history__head m-0">
          <When at={event.at} now={now} />
          <span>{ferret}</span>
        </p>
        <div className="fy-item-history__bubble">{prose(event.text)}</div>
      </li>
    );
  }
  if (event.kind === 'owner-text') {
    return (
      <li className="fy-item-history__event" data-history="owner">
        <p className="fy-item-history__head m-0">
          <When at={event.at} now={now} />
          <span>You</span>
        </p>
        <p className="fy-item-history__bubble m-0">{event.text}</p>
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
  readonly prose: (text: string) => ReactNode;
}

export function AgendaItemHistory({
  events,
  now,
  ferret,
  prose,
}: {
  readonly events: readonly HistoryEvent[];
  readonly now: number;
  readonly ferret: string;
  readonly prose: (text: string) => ReactNode;
}) {
  if (events.length === 0) return null;
  return (
    <section aria-label="History" className="fy-item-history" data-agenda-history="">
      <h3 className="fy-item-history__title">History</h3>
      <ol className="fy-item-history__list">
        {events.map(event => (
          <HistoryRow event={event} ferret={ferret} key={event.key} now={now} prose={prose} />
        ))}
      </ol>
    </section>
  );
}
