/**
 * THE AGENDA TAB OF INFO — one ferret's lineage agenda in four filters (Needs you · Resting · Snoozed · Resolved), each
 * chip's count the length of its list (`lib/agenda-tab.ts`). A row is one button: the title, the ask under it, and one
 * line of marks — where it stands, what it is right now, and how long it has stood there. It opens the item's view, the
 * same one the Inbox and the chat open; nothing is answered from a row.
 */

import type { AgendaItem, AgendaListRecord } from '@ferretry/protocol';
import { useState } from 'react';
import {
  AGENDA_TAB_EMPTY,
  type AgendaTabFilter,
  type AgendaTabModel,
  type AgendaTabRow,
} from '../../lib/agenda-tab.ts';
import { ContextFilterChips } from '../context-rail/context-rail-parts.tsx';
import { agendaHeading } from './agenda-delivery.tsx';
import { agendaAsk } from './agenda-row.tsx';

export interface AgendaTabProps {
  readonly model: AgendaTabModel;
  /** Open the item's view. */
  readonly onOpen: (item: AgendaItem | AgendaListRecord) => void;
  /** This ferret is a sub-ferret: its items are raised on its lead's agenda, which is where to look. */
  readonly lead?: { readonly name: string; readonly open: () => void };
  /** The first filter to show; the first with anything in it when absent. */
  readonly initial?: AgendaTabFilter;
}

const firstFilled = (model: AgendaTabModel): AgendaTabFilter =>
  model.chips.find(chip => chip.count > 0)?.key ?? 'needs-you';

const toneOf = (row: AgendaTabRow): string => {
  if (row.filter === 'needs-you') return row.blocking ? 'blocking' : 'needs-you';
  return 'parked';
};

function TabRow({ row, onOpen }: { readonly row: AgendaTabRow; readonly onOpen: AgendaTabProps['onOpen'] }) {
  const ask = 'resolvedAt' in row.item ? null : agendaAsk(row.item);
  return (
    <button
      className="fy-agenda-row"
      data-agenda-dimmed={row.filter === 'needs-you' ? undefined : true}
      data-agenda-row={row.id}
      data-agenda-tab-row={row.filter}
      onClick={() => onOpen(row.item)}
      type="button"
    >
      <span className="fy-agenda-row__title" data-agenda-row-title="">
        {agendaHeading(row.item)}
      </span>
      {ask === null ? null : (
        <span className="fy-agenda-row__ask" data-agenda-row-ask="">
          {ask}
        </span>
      )}
      <span className="fy-agenda-tab__meta">
        <span className="fy-agenda-pill" data-agenda-tab-state="" data-tone={toneOf(row)}>
          {row.state}
          {row.blocking ? <span className="fy-agenda-pill__when"> · blocking</span> : null}
        </span>
        <span className="fy-agenda-tab__stage" data-agenda-tab-stage="">
          {row.stage}
        </span>
        {row.since === null ? null : (
          <span className="fy-agenda-tab__since" data-agenda-tab-since="">
            {row.since}
          </span>
        )}
      </span>
    </button>
  );
}

export function AgendaTab({ model, onOpen, lead, initial }: AgendaTabProps) {
  const [chosen, setChosen] = useState<AgendaTabFilter>(initial ?? firstFilled(model));
  const rows = model.rows[chosen];
  return (
    <div className="fy-agenda-info" data-agenda-tab={chosen}>
      <ContextFilterChips chips={model.chips} label="Show" onChange={setChosen} value={chosen} />
      {lead === undefined ? null : (
        <p className="fy-agenda-panel__empty" data-agenda-tab-lead="">
          A sub-ferret’s items are raised on its lead’s agenda.{' '}
          <button className="fy-info-inline-action" onClick={lead.open} type="button">
            Open {lead.name}’s agenda
          </button>
        </p>
      )}
      {rows.length === 0 ? (
        <p className="fy-agenda-panel__empty" data-agenda-tab-empty="">
          {AGENDA_TAB_EMPTY[chosen]}
        </p>
      ) : (
        <ul className="fy-agenda-rows">
          {rows.map(row => (
            <li className="fy-agenda-rows__item" key={row.id}>
              <TabRow onOpen={onOpen} row={row} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
