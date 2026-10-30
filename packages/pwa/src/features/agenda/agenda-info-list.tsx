/**
 * THIS FERRET'S AGENDA IN INFO — the one list of its items there. A list is only a list: every row is one button that
 * opens the item's view (`agenda-item-view.tsx`), the same view a `!A5` click, the agenda line and the Inbox open.
 * Nothing is answered from a row.
 *
 * Three filters: Open (what is on someone's turn, the drawer's order), Parked (snoozed, or replied to and not picked up
 * yet) and Resolved (newest first, read-only once opened). A filter with nothing in it is not drawn, and with only Open
 * to show there are no filters at all.
 */

import type { AgendaItem, ResolvedAgendaItem } from '@ferretry/protocol';
import { useState } from 'react';
import { ContextFilterChips } from '../context-rail/context-rail-parts.tsx';
import { AgendaRow } from './agenda-row.tsx';

export type AgendaInfoFilter = 'open' | 'parked' | 'resolved';

const FILTER_LABEL: Readonly<Record<AgendaInfoFilter, string>> = {
  open: 'Open',
  parked: 'Parked',
  resolved: 'Resolved',
};

const EMPTY: Readonly<Record<AgendaInfoFilter, string>> = {
  open: 'Nothing on the agenda.',
  parked: 'Nothing is parked.',
  resolved: 'Nothing has been resolved.',
};

export interface AgendaInfoListProps {
  readonly open: readonly AgendaItem[];
  readonly parked: readonly AgendaItem[];
  readonly resolved: readonly ResolvedAgendaItem[];
  readonly ferret: string;
  readonly now?: number;
  /** Open the item's view. */
  readonly onOpen: (item: AgendaItem | ResolvedAgendaItem) => void;
}

export function AgendaInfoList({ open, parked, resolved, ferret, now, onOpen }: AgendaInfoListProps) {
  const [chosen, setChosen] = useState<AgendaInfoFilter>('open');
  const lists: Readonly<Record<AgendaInfoFilter, readonly AgendaItem[]>> = { open, parked, resolved };
  const chips = (['open', 'parked', 'resolved'] as const)
    .filter(key => key === 'open' || lists[key].length > 0)
    .map(key => ({ key, label: FILTER_LABEL[key], count: lists[key].length }));
  // A filter that emptied (the last parked item came back) falls back to Open rather than showing nothing.
  const filter = chips.some(chip => chip.key === chosen) ? chosen : 'open';
  const items = lists[filter];
  return (
    <div className="fy-agenda-info" data-agenda-info-list={filter}>
      {chips.length > 1 ? <ContextFilterChips chips={chips} label="Show" onChange={setChosen} value={filter} /> : null}
      {items.length === 0 ? (
        <p className="fy-agenda-panel__empty">{EMPTY[filter]}</p>
      ) : (
        <ul className="fy-agenda-rows">
          {items.map(item => (
            <li className="fy-agenda-rows__item" key={item.id}>
              <AgendaRow
                ferret={ferret}
                item={item}
                onOpen={() => onOpen(item)}
                {...(now === undefined ? {} : { now })}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
