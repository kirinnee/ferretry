/**
 * ONE ROW OF A FERRET'S AGENDA, in the drawer above the composer (and the docked panel on a wide screen): ONE
 * button, the whole row. A bold one-line title, the ask under it (two lines at most) and the status mark (whose
 * turn, what it blocks). Nothing else is on it — no answer chips, no reply — because everything to decide is on
 * the item's card, which the tap opens in place of the conversation.
 *
 * A ferret's-turn row is dimmed.
 */

import { type AgendaItem, hasOwnTitle } from '@ferretry/protocol';
import { type AgendaStatus, agendaAuthor, agendaStatus } from '../../lib/agenda-status.ts';
import { bulletPoints } from '../../lib/agenda-revisions.ts';
import { AgendaStatusPill } from './agenda-status-pill.tsx';
import { agendaHeading } from './agenda-delivery.tsx';

export interface AgendaRowProps {
  readonly item: AgendaItem;
  /** The ferret's name, for "with Johnnie" on a ferret's-turn row. */
  readonly ferret: string;
  readonly now?: number;
  /** Open the item's card (the drawer closes). */
  readonly onOpen: () => void;
}

/** The first point of a text written as bullets, else its first paragraph; `null` when there is none. */
const leadOf = (text: string | null | undefined): string | null => {
  const clean = text?.trim() ?? '';
  if (clean === '') return null;
  const lead = bulletPoints(clean)?.[0] ?? clean.split(/\n\s*\n/u)[0]?.trim();
  return lead === undefined || lead === '' ? null : lead;
};

/** What the item asks, under its title: its subject, or — when the title IS the subject — the first thing it says is going on. */
export const agendaAsk = (item: AgendaItem): string | null => {
  const subject = item.subject.trim();
  if (hasOwnTitle(item) && subject !== '') return subject;
  return leadOf(item.premise) ?? leadOf(item.context);
};

export function AgendaRow({ item, ferret, now = Date.now(), onOpen }: AgendaRowProps) {
  const status = agendaStatus(item, agendaAuthor(item, ferret), now);
  const ask = agendaAsk(item);
  return (
    <button
      className="fy-agenda-row"
      data-agenda-dimmed={status?.dimmed || undefined}
      data-agenda-row={item.id}
      data-notice={item.notice === true || undefined}
      data-overdue={status?.overdue || undefined}
      data-tone={status?.tone}
      onClick={onOpen}
      type="button"
    >
      <span className="fy-agenda-row__title" data-agenda-row-title="">
        {agendaHeading(item)}
      </span>
      {ask === null ? null : (
        <span className="fy-agenda-row__ask" data-agenda-row-ask="">
          {ask}
        </span>
      )}
      <StatusLine status={status} />
    </button>
  );
}

function StatusLine({ status }: { readonly status: AgendaStatus | null }) {
  if (status === null || status.tone === 'needs-you') return null;
  return (
    <span className="fy-agenda-row__status">
      <AgendaStatusPill status={status} />
    </span>
  );
}
