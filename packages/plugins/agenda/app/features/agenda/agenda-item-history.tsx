/**
 * THE CONVERSATION OF AN OPEN AGENDA ITEM — the owner's and the ferret's words about it, in the chat's two shapes: the
 * owner's words are a bubble with its time at the foot; the ferret's are text with its name above and its time below.
 * Oldest first, with no tool calls and no thinking — the relevance rule that decides what is here is `itemHistory`'s.
 * The chat's own rows and receipt ticks are Conversation's and are not drawn here: the ticks belonged to the chat's
 * send ledger, which this half does not read. Every reply is drawn WHOLE: nothing is cut, however long. FOLDED until
 * the owner opens it (and remembered per item, like the other folded parts), so the item does not scroll for ever.
 *
 * The edits ("Updated to v2") are not words anyone said: they are the activity log's (`agenda-activity-log.tsx`).
 */

import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import type { HistoryEvent } from '../../lib/agenda-history.ts';
import { AgendaFold } from './agenda-fold.tsx';

/** What Ferretry itself is called where its own words (a closing note, a notice) are drawn. */
const DAEMON_NAME = 'Ferretry';

type SpokenEvent = Exclude<HistoryEvent, { readonly kind: 'revision' }>;

/** What was SAID, of the item's history: the owner's and the ferret's words, never an edit. */
const spokenEvents = (events: readonly HistoryEvent[]): readonly SpokenEvent[] =>
  events.filter((event): event is SpokenEvent => event.kind !== 'revision');

/** A time of 0 is "not known": the row then shows none, as the chat's does. */
function RowTime({ at }: { readonly at: number }) {
  if (at === 0) return null;
  const when = new Date(at);
  return (
    <time className="fy-hist__time" dateTime={when.toISOString()}>
      {when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </time>
  );
}

/** "from chat": words the ferret copied from the owner's chat onto the item (`fy agenda log`), not typed on it. */
function FromChat() {
  return (
    <span className="fy-hist__tag" data-history-from-chat="">
      from chat
    </span>
  );
}

const GAP_WORDS = (earlier: number, state: 'loading' | 'failed' | 'capped'): string => {
  const entries = `${String(earlier)} earlier ${earlier === 1 ? 'entry' : 'entries'}`;
  if (state === 'loading') return `Loading ${entries}…`;
  if (state === 'failed')
    return `${entries} could not be read. ${earlier === 1 ? 'It' : 'They'} will be tried again when the conversation changes.`;
  return `${entries} ${earlier === 1 ? 'is' : 'are'} not shown: this conversation is longer than one read takes.`;
};

function HistoryRow({ event, ferret, renderProse }: HistoryRowProps) {
  if (event.kind === 'gap') {
    return (
      <li
        className="fy-hist__gap"
        data-history="gap"
        data-history-gap={event.state}
        role={event.state === 'loading' ? 'status' : 'note'}
      >
        {GAP_WORDS(event.earlier, event.state)}
      </li>
    );
  }
  if (event.kind === 'owner') {
    const chosen = event.form === 'answer' || event.form === 'done';
    return (
      <li className="fy-hist__me" data-history="owner" data-history-kind={event.form}>
        <div className="fy-hist__bubble">
          <p className="fy-hist__said">
            {chosen ? <Check aria-hidden="true" className="fy-hist__check" size={14} strokeWidth={2.5} /> : null}
            {event.text}
          </p>
          {event.note === undefined ? null : <p className="fy-hist__note">{event.note}</p>}
          {event.fromChat === true ? <FromChat /> : null}
          <RowTime at={event.at} />
        </div>
      </li>
    );
  }
  return (
    <li className="fy-hist__ag" data-history={event.daemon === true ? 'daemon' : 'ferret'}>
      <span className="fy-hist__who">{event.daemon === true ? DAEMON_NAME : ferret}</span>
      {event.fromChat === true ? <FromChat /> : null}
      <div className="fy-hist__text">{renderProse(event.text)}</div>
      <RowTime at={event.at} />
    </li>
  );
}

interface HistoryRowProps {
  readonly event: SpokenEvent;
  readonly ferret: string;
  readonly renderProse: (text: string) => ReactNode;
}

export function AgendaItemHistory({
  events,
  ferret,
  renderProse,
  itemKey,
  title = 'Conversation',
}: {
  readonly events: readonly HistoryEvent[];
  readonly ferret: string;
  readonly renderProse: (text: string) => ReactNode;
  /** Names the item on this device, so whether its conversation is open is remembered per item. */
  readonly itemKey: string;
  /** The part's heading. */
  readonly title?: string;
}) {
  const spoken = spokenEvents(events);
  if (spoken.length === 0) return null;
  const said = spoken.filter(event => event.kind !== 'gap').length;
  return (
    <AgendaFold
      itemKey={itemKey}
      meta={`${String(said)} ${said === 1 ? 'message' : 'messages'}`}
      part="conversation"
      title={title}
    >
      <ol aria-label={title} className="fy-hist fy-hist__list" data-agenda-history="">
        {spoken.map(event => (
          <HistoryRow event={event} ferret={ferret} key={event.key} renderProse={renderProse} />
        ))}
      </ol>
    </AgendaFold>
  );
}
