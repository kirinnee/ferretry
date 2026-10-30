/**
 * THE HISTORY AT THE FOOT OF AN ITEM VIEW: what changed on the item, what the owner said about it and what the
 * ferret answered, oldest first so it reads like the conversation it replaces. Nothing here is a second source:
 * `itemHistory` reads the item's revisions and the chat.
 *
 * It is folded: the owner's own latest message stays in view beside the fold (it is the thing they come back
 * for), and opening the fold shows the whole run, so nothing is drawn twice.
 */

import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { AGENDA_KIND_LABEL } from '../../components/agenda-message.tsx';
import type { HistoryEvent } from '../../lib/agenda-history.ts';
import { revisionAuthor, revisionStamp } from '../../lib/agenda-revisions.ts';
import { PointForm } from './agenda-brief.tsx';

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

const latestOwner = (events: readonly HistoryEvent[]): HistoryEvent | undefined =>
  events.findLast(event => event.kind === 'owner' || event.kind === 'owner-text');

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
  const [open, setOpen] = useState(false);
  if (events.length === 0) return null;
  const preview = open ? undefined : latestOwner(events);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section aria-label="History" className="fy-item-history" data-agenda-history="" data-open={open || undefined}>
      <h3 className="fy-item-history__title m-0">
        <button
          aria-expanded={open}
          className="fy-item-history__toggle"
          data-agenda-history-toggle=""
          onClick={() => setOpen(current => !current)}
          type="button"
        >
          <Chevron aria-hidden="true" size={14} />
          History
          <span className="fy-item-history__count">{events.length}</span>
        </button>
      </h3>
      {preview === undefined ? null : (
        <ol className="fy-item-history__list" data-agenda-history-latest="">
          <HistoryRow event={preview} ferret={ferret} now={now} prose={prose} />
        </ol>
      )}
      {open ? (
        <ol className="fy-item-history__list">
          {events.map(event => (
            <HistoryRow event={event} ferret={ferret} key={event.key} now={now} prose={prose} />
          ))}
        </ol>
      ) : null}
    </section>
  );
}
