/**
 * THE BOARD'S TABLE VIEW (the route is still `?view=list`): the CURRENT SUMMARY. What waits on the owner leads
 * ("To test", with its Done action), then what is being worked on, then two quiet sections of what merged and
 * what released lately. A row is the title, its one-line summary, the status pill and when it last mattered;
 * the people and the PR numbers live on the card. The Archive keeps the flat, columned rows.
 *
 * Done (or Reopen) spins while its move is in flight and the row's refusal is said under it, as on a card.
 */

import { formatTaskRef } from '@ferretry/protocol';
import { CornerDownRight } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ANSWER_AT_REST, type BoardAnswerState } from '../../lib/board-done.ts';
import { isAgentTask } from '../../lib/board-human.ts';
import { cardSegments } from '../../lib/board-present.ts';
import {
  SUMMARY_SECTIONS,
  SUMMARY_WINDOW_LABEL,
  SUMMARY_WINDOWS,
  type SummaryRow,
  type SummaryWindow,
  summarySections,
} from '../../lib/board-summary.ts';
import { type BoardCardOf, type BoardListRow, listRows } from '../../lib/board-view.ts';
import type { BoardModel } from '../../lib/board-model.ts';
import { RouteLink } from '../../shell/route-link.tsx';
import { ToTestActions } from './board-card.tsx';
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

/** Why the row's last move did not go through, under the row. */
function AnswerError({ answer }: { readonly answer: BoardAnswerState }) {
  return answer.error === null ? null : (
    <p className="fy-board-table__error" data-answer-error="" role="alert">
      {answer.error}
    </p>
  );
}

function TableRow({ row, env }: RowProps) {
  const { card } = row;
  const { task } = card;
  const place = env.places.get(card.key);
  const done = place === undefined ? undefined : env.doneFor?.(card, place);
  const answer = env.answerFor?.(card) ?? ANSWER_AT_REST;
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
      data-settling={answer.pressed === null ? undefined : answer.pressed}
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
          <BoardDoneAction
            disabled={answer.pressed !== null}
            done={done.done}
            onPress={done.press}
            pending={answer.pressed === done.done.kind}
            title={task.title}
            touch={env.touch === true}
          />
        )}
      </div>
      <AnswerError answer={answer} />
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
}

/** The Archive's rows, flat, one per card. */
export function TableRows({ rows, env }: TableRowsProps) {
  return (
    <div className="fy-board-table">
      <TableHead />
      <ul className="fy-board-table__rows">
        {rows.map(row => (
          <TableRow env={env} key={row.card.key} row={row} />
        ))}
      </ul>
    </div>
  );
}

export interface TableViewProps {
  readonly model: BoardModel;
  /** Closed cards, read only to list what was released lately; empty until read. */
  readonly closed?: BoardModel;
  readonly env: BoardCardEnv;
  readonly window: SummaryWindow;
  readonly onWindow: (window: SummaryWindow) => void;
}

function SummaryRowView({ entry, env }: { readonly entry: SummaryRow; readonly env: BoardCardEnv }) {
  const { card, row } = entry;
  const { task } = card;
  const action = SUMMARY_SECTIONS[entry.section].action;
  const place = env.places.get(card.key);
  const done = action && place !== undefined ? env.doneFor?.(card, place) : undefined;
  const moves = action && place !== undefined ? env.movesFor(card, place) : undefined;
  const verdict = moves !== undefined && row.category === 'verify';
  const answer = env.answerFor?.(card) ?? ANSWER_AT_REST;
  const href = env.hrefFor(card);
  const extras = cardSegments(task, { names: env.names, now: env.now, category: row.category, machine: null }).filter(
    segment => segment.key === 'blocked' || segment.key === 'subs',
  );
  return (
    <li
      className="fy-board-summary__row"
      data-action={action ? '' : undefined}
      data-agent={isAgentTask(task) ? '' : undefined}
      data-section={entry.section}
      data-settling={answer.pressed === null ? undefined : answer.pressed}
      data-task={task.id}
      data-touch={env.touch === true ? '' : undefined}
      data-under={entry.under === null ? undefined : ''}
    >
      <div className="fy-board-table__what">
        <div className="fy-board-table__line">
          {entry.under === null ? null : (
            <CornerDownRight aria-label="Made for the card above" className="fy-board-summary__under" size={12} />
          )}
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
      <div className="fy-board-summary__meta">
        {action ? null : (
          <span className="fy-board-pill" data-category={row.category ?? 'unplaced'} title="Lane">
            {row.laneName}
          </span>
        )}
        <span className="fy-board-summary__when">{entry.when}</span>
      </div>
      <div className="fy-board-summary__act">
        {verdict ? (
          <ToTestActions answer={answer} card={card} done={done} moves={moves} touch={env.touch === true} />
        ) : done === undefined ? null : (
          <BoardDoneAction
            disabled={answer.pressed !== null}
            done={done.done}
            onPress={done.press}
            pending={answer.pressed === done.done.kind}
            title={task.title}
            touch={env.touch === true}
          />
        )}
      </div>
      <AnswerError answer={answer} />
    </li>
  );
}

/**
 * THE TABLE: the current summary, not a spreadsheet. What waits on the owner leads, then what is being worked
 * on, then two compact sections of what merged and what released lately (the time window narrows those two).
 */
export function TableView({ model, closed, env, window, onWindow }: TableViewProps) {
  const sections = useMemo(
    () =>
      summarySections({
        rows: listRows(model),
        closedRows: closed === undefined ? [] : listRows(closed),
        window,
        now: env.now,
      }),
    [model, closed, window, env.now],
  );
  return (
    <div className="fy-board-list fy-board-summary">
      <div className="fy-board-table__tools">
        <span className="fy-board-summary__tools-label" id="board-summary-window">
          Merged and released in the last
        </span>
        <div aria-labelledby="board-summary-window" className="fy-board-sort" role="toolbar">
          {SUMMARY_WINDOWS.map(option => (
            <button
              aria-pressed={window === option}
              className="fy-board-sort__option"
              data-window={option}
              key={option}
              onClick={() => onWindow(option)}
              type="button"
            >
              {SUMMARY_WINDOW_LABEL[option]}
            </button>
          ))}
        </div>
      </div>
      {sections.length === 0 ? (
        <p className="fy-board-empty">Nothing to show for this window.</p>
      ) : (
        sections.map(section => (
          <section
            aria-label={section.title}
            className="fy-board-summary__section"
            data-action={section.action ? '' : undefined}
            data-section={section.id}
            key={section.id}
          >
            <h2 className="fy-board-summary__head">
              {section.title}
              <span className="fy-board-table__group-count">{section.rows.length}</span>
            </h2>
            <ul className="fy-board-table__rows">
              {section.rows.map(entry => (
                <SummaryRowView entry={entry} env={env} key={entry.card.key} />
              ))}
            </ul>
          </section>
        ))
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
