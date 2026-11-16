/**
 * THE AGENDA TAB OF INFO — one ferret's lineage agenda in four filters (Needs you · Resting · Snoozed · Resolved), each
 * chip's count the length of its list (`lib/agenda-tab.ts`). A row is one button: the title, the ask under it, and one
 * line of marks — where it stands, what it is right now, and how long it has stood there. It opens the item's view, the
 * same one the Inbox and the chat open; nothing is answered from a row.
 */

import type { AgendaItem, AgendaListRecord } from '@ferretry/core-asks/contract';
import { useEffect, useRef, useState } from 'react';
import {
  AGENDA_TAB_EMPTY,
  type AgendaTabFilter,
  type AgendaTabModel,
  type AgendaTabRow,
} from '../../lib/agenda-tab.ts';
import { ContextFilterChips } from '../../shell.ts';
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
  /**
   * The ask a link asked for (`?ask=A3`, `useAskFocus`). When it is one of this ferret's, its filter opens and its row is
   * rung; one that is not here asks for nothing. A new `seq` is a new request, so tapping the same ask's notification
   * again rings it again.
   */
  readonly focus?: { readonly target: AgendaItem['id']; readonly seq: number } | null;
}

/** The filter that holds the ask, or `undefined` when it is not among this ferret's. */
const filterOf = (model: AgendaTabModel, target: AgendaItem['id']): AgendaTabFilter | undefined =>
  model.chips.find(chip => model.rows[chip.key].some(row => row.id === target))?.key;

const firstFilled = (model: AgendaTabModel): AgendaTabFilter =>
  model.chips.find(chip => chip.count > 0)?.key ?? 'needs-you';

const toneOf = (row: AgendaTabRow): string => {
  if (row.filter === 'needs-you') return row.blocking ? 'blocking' : 'needs-you';
  return 'parked';
};

function TabRow({
  row,
  onOpen,
  rung,
}: {
  readonly row: AgendaTabRow;
  readonly onOpen: AgendaTabProps['onOpen'];
  /** The request that rang this row, or `null` for a row nobody asked for. */
  readonly rung: number | null;
}) {
  const ask = 'resolvedAt' in row.item ? null : agendaAsk(row.item);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (rung !== null) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [rung]);
  return (
    <button
      aria-current={rung === null ? undefined : 'true'}
      className="fy-agenda-row"
      data-agenda-dimmed={row.filter === 'needs-you' ? undefined : true}
      data-agenda-focused={rung === null ? undefined : ''}
      data-agenda-row={row.id}
      ref={ref}
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

export function AgendaTab({ model, onOpen, lead, initial, focus = null }: AgendaTabProps) {
  const asked = focus === null ? undefined : filterOf(model, focus.target);
  const [chosen, setChosen] = useState<AgendaTabFilter>(asked ?? initial ?? firstFilled(model));
  // Each request opens the filter its ask sits in once (the reader may move to another after); the row is rung meanwhile.
  // `seq` is the request: a new one re-opens the filter even when the ask has not moved, and a board that lands after
  // the request still opens it.
  const seq = focus?.seq ?? null;
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (seq === null || asked === undefined || handled.current === seq) return;
    handled.current = seq;
    setChosen(asked);
  }, [asked, seq]);
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
              <TabRow onOpen={onOpen} row={row} rung={focus !== null && focus.target === row.id ? focus.seq : null} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
