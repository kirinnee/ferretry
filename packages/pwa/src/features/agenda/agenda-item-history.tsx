/**
 * THE CONVERSATION OF AN OPEN AGENDA ITEM — the owner's and the ferret's words about it, read like the chat: oldest
 * first. ONLY THE OWNER'S messages are bubbles (right-aligned, like the chat's own); the ferret's text is plain, under
 * its name and the time, with no tool calls and no thinking — the relevance rule that decides what is here is
 * `itemHistory`'s. Every reply is drawn WHOLE: nothing is cut, however long. FOLDED until the owner opens it (and
 * remembered per item, like the other folded parts), so the item does not scroll for ever.
 *
 * The edits ("Updated to v2") are not words anyone said: they are the activity log's (`agenda-activity-log.tsx`).
 */

import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import type { HistoryEvent } from '../../lib/agenda-history.ts';
import { revisionStamp } from '../../lib/agenda-revisions.ts';
import { AgendaFold } from './agenda-fold.tsx';

/** What Ferretry itself is called where its own words (a closing note, a notice) are drawn. */
const DAEMON_NAME = 'Ferretry';

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

function HistoryRow({ event, now, ferret, renderProse }: HistoryRowProps) {
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
        <p className="fy-hist__said m-0">
          {chosen ? <Check aria-hidden="true" className="fy-hist__check" size={14} strokeWidth={2.5} /> : null}
          {event.text}
        </p>
        {event.note === undefined ? null : <p className="fy-hist__note m-0">{event.note}</p>}
        {event.fromChat === true ? <FromChat /> : null}
        <When at={event.at} now={now} />
      </li>
    );
  }
  return (
    <li className="fy-hist__ag" data-history={event.daemon === true ? 'daemon' : 'ferret'}>
      <p className="fy-hist__who m-0">
        <span>{event.daemon === true ? DAEMON_NAME : ferret}</span>
        {event.fromChat === true ? <FromChat /> : null}
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
  itemKey,
  title = 'Conversation',
}: {
  readonly events: readonly HistoryEvent[];
  readonly now: number;
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
          <HistoryRow event={event} ferret={ferret} key={event.key} now={now} renderProse={renderProse} />
        ))}
      </ol>
    </AgendaFold>
  );
}
