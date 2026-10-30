/**
 * THE BOARD'S TABLE VIEW (the route is still `?view=list`): one row per card, built to be read, not scanned
 * past. The title is whole and wraps; under it the card's one-line summary, muted, two lines at most and then
 * "more" (which opens the card). Never the long brief or the owner's ask.
 *
 * The RIGHT of a row holds the aligned columns: who, activity, PR, the Status pill (the lane) and last the
 * owner's "Done ✓" (or "Reopen" on a closed row in the Archive). On a phone the same row stacks: title and
 * summary, then the status pill and Done on one line. A row is a real link to the card detail.
 */

import { formatTaskRef } from '@ferretry/protocol';
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cardSegments } from '../../lib/board-present.ts';
import {
  type BoardCardOf,
  type BoardListRow,
  groupRowsByLane,
  LIST_SORT_LABEL,
  LIST_SORTS,
  type ListSort,
  listRows,
  sortRows,
} from '../../lib/board-view.ts';
import type { BoardModel } from '../../lib/board-model.ts';
import { RouteLink } from '../../shell/route-link.tsx';
import { BoardDoneAction } from './board-done-action.tsx';
import { BoardIcon } from './board-icons.tsx';
import type { BoardCardEnv } from './board-views.tsx';

/** The muted summary: two lines, and "more" only when the text really is cut. */
function Summary({
  text,
  href,
  onNavigate,
}: {
  readonly text: string;
  readonly href: string;
  readonly onNavigate: (to: string) => void;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null || text === '') return undefined;
    const measure = (): void => setCut(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);
  return (
    <div className="fy-board-table__summary">
      <p className="fy-board-table__summary-text" ref={ref}>
        {text}
      </p>
      {cut ? (
        <RouteLink className="fy-board-table__more" onNavigate={onNavigate} to={href}>
          more
        </RouteLink>
      ) : null}
    </div>
  );
}

interface RowProps {
  readonly row: BoardListRow;
  readonly env: BoardCardEnv;
}

function TableRow({ row, env }: RowProps) {
  const { card } = row;
  const { task } = card;
  const place = env.places.get(card.key);
  const done = place === undefined ? undefined : env.doneFor?.(card, place);
  const href = env.hrefFor(card);
  const segments = cardSegments(task, {
    names: env.names,
    now: env.now,
    category: row.category,
    machine: env.showMachine ? card.machine : null,
  });
  const segment = (key: 'people' | 'activity' | 'pr') => segments.find(entry => entry.key === key);
  const cell = (key: 'people' | 'activity' | 'pr'): ReactNode => {
    const found = segment(key);
    if (found === undefined) return <span className="fy-board-table__none">–</span>;
    return (
      <span className="fy-board-seg" data-seg={found.key} data-tone={found.tone} title={found.title}>
        {found.icon === null ? null : <BoardIcon name={found.icon} />}
        {found.text}
      </span>
    );
  };
  const extras = segments.filter(entry => entry.key === 'blocked' || entry.key === 'subs' || entry.key === 'shipped');
  return (
    <li
      className="fy-board-table__row"
      data-activity={task.activity}
      data-category={row.category ?? 'unplaced'}
      data-task={task.id}
      data-touch={env.touch === true ? '' : undefined}
    >
      <div className="fy-board-table__what">
        <div className="fy-board-table__line">
          <RouteLink className="fy-board-table__title" onNavigate={env.onNavigate} to={href}>
            <span className="fy-board-table__ref">{formatTaskRef({ id: task.id })}</span>{' '}
            <span className="fy-board-table__title-text">{task.title}</span>
          </RouteLink>
          {extras.length === 0 ? null : (
            <span className="fy-board-table__extras">
              {extras.map(entry => (
                <span
                  className="fy-board-seg"
                  data-seg={entry.key}
                  data-tone={entry.tone}
                  key={entry.key}
                  title={entry.title}
                >
                  {entry.icon === null ? null : <BoardIcon name={entry.icon} />}
                  {entry.text}
                </span>
              ))}
            </span>
          )}
        </div>
        {task.summary === '' ? null : <Summary href={href} onNavigate={env.onNavigate} text={task.summary} />}
      </div>
      <div className="fy-board-table__cell" data-col="people">
        {cell('people')}
      </div>
      <div className="fy-board-table__cell" data-col="activity">
        {cell('activity')}
      </div>
      <div className="fy-board-table__cell" data-col="pr">
        {cell('pr')}
      </div>
      <div className="fy-board-table__cell" data-col="status">
        <span className="fy-board-pill" data-category={row.category ?? 'unplaced'} title="Lane">
          {row.laneName}
        </span>
      </div>
      <div className="fy-board-table__cell" data-col="done">
        {done === undefined ? null : (
          <BoardDoneAction done={done.done} onPress={done.press} title={task.title} touch={env.touch === true} />
        )}
      </div>
    </li>
  );
}

function TableHead() {
  return (
    <div aria-hidden="true" className="fy-board-table__head">
      <span>Card</span>
      <span data-col="people">Who</span>
      <span data-col="activity">Activity</span>
      <span data-col="pr">PR</span>
      <span data-col="status">Status</span>
      <span data-col="done" />
    </div>
  );
}

export interface TableRowsProps {
  readonly rows: readonly BoardListRow[];
  readonly env: BoardCardEnv;
  readonly grouped?: boolean;
}

/** The rows alone, flat or under a heading per lane: the Table and the Archive both draw them. */
export function TableRows({ rows, env, grouped = false }: TableRowsProps) {
  const groups = useMemo(() => (grouped ? groupRowsByLane(rows) : null), [grouped, rows]);
  return (
    <div className="fy-board-table" data-grouped={grouped ? '' : undefined}>
      <TableHead />
      {groups === null ? (
        <ul className="fy-board-table__rows">
          {rows.map(row => (
            <TableRow env={env} key={row.card.key} row={row} />
          ))}
        </ul>
      ) : (
        groups.map(group => (
          <section aria-label={group.laneName} className="fy-board-table__group" key={group.key}>
            <h2 className="fy-board-table__group-head">
              <span className="fy-board-pill" data-category={group.category ?? 'unplaced'}>
                {group.laneName}
              </span>
              <span className="fy-board-table__group-count">{group.rows.length}</span>
            </h2>
            <ul className="fy-board-table__rows">
              {group.rows.map(row => (
                <TableRow env={env} key={row.card.key} row={row} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

export interface TableViewProps {
  readonly model: BoardModel;
  readonly env: BoardCardEnv;
  readonly sort: ListSort;
  readonly onSort: (sort: ListSort) => void;
  /** Group the rows under their lane. */
  readonly grouped: boolean;
  readonly onGroup: (grouped: boolean) => void;
}

export function TableView({ model, env, sort, onSort, grouped, onGroup }: TableViewProps) {
  const rows = useMemo(() => sortRows(listRows(model), sort), [model, sort]);
  return (
    <div className="fy-board-list">
      <div className="fy-board-table__tools">
        <div aria-label="Sort the table" className="fy-board-sort" role="toolbar">
          {LIST_SORTS.map(option => (
            <button
              aria-pressed={sort === option}
              className="fy-board-sort__option"
              data-sort={option}
              key={option}
              onClick={() => onSort(option)}
              type="button"
            >
              {LIST_SORT_LABEL[option]}
            </button>
          ))}
        </div>
        <button
          aria-pressed={grouped}
          className="fy-board-sort__option fy-board-table__group-toggle"
          data-group-by-lane=""
          onClick={() => onGroup(!grouped)}
          type="button"
        >
          Group by lane
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="fy-board-empty">No cards match.</p>
      ) : (
        <TableRows env={env} grouped={grouped} rows={rows} />
      )}
    </div>
  );
}

/** A closed or dropped card as a Table row, for the Archive. */
export const archiveRowsOf = (
  cards: readonly BoardCardOf[],
  env: Pick<BoardCardEnv, 'places'>,
): readonly BoardListRow[] =>
  cards.map(card => {
    const place = env.places.get(card.key);
    return {
      card,
      projectId: card.task.projectId,
      laneId: card.task.laneId,
      laneName: card.task.dropped === null ? (place?.laneName ?? card.task.laneId) : 'Dropped',
      category: place?.category ?? null,
      place: [0, 0] as const,
    };
  });
