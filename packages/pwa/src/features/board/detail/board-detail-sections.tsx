/** THE SECTIONS OF A CARD'S DETAIL: each a small collapsible block that draws one fact and decides nothing. */

import { type BoardTaskView, formatTaskRef, type TaskRef } from '@ferretry/protocol';
import { ChevronRight, ExternalLink, GitBranch } from 'lucide-react';
import type { ReactNode } from 'react';
import { Markdown } from '../../../components/markdown.tsx';
import {
  type CardAsks,
  foldHistory,
  type HistoryContext,
  historyRows,
  isWebLink,
  type LaneStep,
  linkLabel,
  prLine,
} from '../../../lib/board-detail.ts';
import type { RunningOnMachine } from '../../../lib/board-model.ts';
import { ageLabel, type FerretNames } from '../../../lib/board-present.ts';
import { BoardIcon } from '../board-icons.tsx';

export interface DetailSectionProps {
  readonly id: string;
  readonly title: string;
  readonly count?: number;
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
}

/** A section the reader can fold; the browser's own disclosure carries the keyboard and screen-reader behaviour. */
export function DetailSection({ id, title, count, defaultOpen = true, children }: DetailSectionProps) {
  return (
    <details className="fy-board-detail__section" data-section={id} open={defaultOpen}>
      <summary className="fy-board-detail__summary">
        <ChevronRight aria-hidden="true" className="fy-board-detail__chevron" size={12} />
        <span>{title}</span>
        {count === undefined ? null : <span className="fy-board-detail__count">{count}</span>}
      </summary>
      <div className="fy-board-detail__body">{children}</div>
    </details>
  );
}

export function LaneStepper({ steps }: { readonly steps: readonly LaneStep[] }) {
  if (steps.length === 0) return <p className="fy-board-detail__quiet">This project has no confirmed lanes.</p>;
  return (
    <ol aria-label="Lanes" className="fy-board-stepper">
      {steps.map(step => (
        <li
          aria-current={step.state === 'current' ? 'step' : undefined}
          className="fy-board-stepper__step"
          data-state={step.state}
          key={step.id}
        >
          {step.name}
        </li>
      ))}
    </ol>
  );
}

export function Prose({ text, empty }: { readonly text: string; readonly empty: string }) {
  return text.trim() === '' ? <p className="fy-board-detail__quiet">{empty}</p> : <Markdown text={text} />;
}

export function AskSection({ task, names }: { readonly task: BoardTaskView; readonly names: FerretNames }) {
  return (
    <>
      <blockquote className="fy-board-detail__ask">{task.ask.text}</blockquote>
      <p className="fy-board-detail__quiet">
        Said in{' '}
        {task.ask.source.startsWith('session:') ? names(task.ask.source.slice('session:'.length)) : task.ask.source}.
      </p>
      {task.clarifications.length === 0 ? null : (
        <ul className="fy-board-detail__list">
          {task.clarifications.map(clarification => (
            <li key={`${clarification.at}:${clarification.text}`}>
              <span className="fy-board-detail__quiet">
                Clarified by {clarification.by.kind === 'owner' ? 'you' : 'a ferret'}
                {clarification.by.kind === 'ferret' ? ` (${names(clarification.by.sessionId)})` : ''}:{' '}
              </span>
              {clarification.text}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function TermsTable({ terms }: { readonly terms: BoardTaskView['terms'] }) {
  if (terms.length === 0) return <p className="fy-board-detail__quiet">No terms spelled out yet.</p>;
  return (
    <table className="fy-board-detail__terms">
      <thead>
        <tr>
          <th scope="col">Term</th>
          <th scope="col">Meaning</th>
        </tr>
      </thead>
      <tbody>
        {terms.map(entry => (
          <tr key={entry.term}>
            <th scope="row">{entry.term}</th>
            <td>{entry.meaning}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface ChildLine {
  readonly task: BoardTaskView;
  readonly laneName: string;
}

export function ChildrenList({
  lines,
  now,
  onOpen,
}: {
  readonly lines: readonly ChildLine[];
  readonly now: number;
  readonly onOpen: (id: string) => void;
}) {
  if (lines.length === 0) return <p className="fy-board-detail__quiet">No sub-cards.</p>;
  return (
    <ul className="fy-board-detail__list" data-kind="children">
      {lines.map(({ task, laneName }) => (
        <li key={task.id}>
          <button className="fy-board-detail__link" onClick={() => onOpen(task.id)} type="button">
            {formatTaskRef({ id: task.id })} {task.title}
          </button>
          <span className="fy-board-detail__quiet">
            {' '}
            · {laneName} · {task.activity}
            {ageLabel(task.lastTouchedAt, now) === null ? '' : ` · ${ageLabel(task.lastTouchedAt, now)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function DependencyChips({
  task,
  onOpen,
  onUndepend,
}: {
  readonly task: BoardTaskView;
  readonly onOpen: (id: string) => void;
  readonly onUndepend: ((ref: TaskRef) => void) | null;
}) {
  const waiting = new Set(task.blockedBy.map(ref => formatTaskRef(ref)));
  if (task.dependsOn.length === 0 && task.blocks.length === 0) {
    return <p className="fy-board-detail__quiet">Nothing waits on this, and it waits on nothing.</p>;
  }
  return (
    <div className="fy-board-detail__chips">
      {task.dependsOn.length === 0 ? null : (
        <fieldset aria-label="Depends on" className="fy-board-detail__chiprow">
          <span className="fy-board-detail__quiet">Depends on</span>
          {task.dependsOn.map(dependency => {
            const label = formatTaskRef(dependency.task);
            return (
              <span className="fy-board-chip" data-waiting={waiting.has(label) ? '' : undefined} key={label}>
                <button className="fy-board-chip__open" onClick={() => onOpen(dependency.task.id)} type="button">
                  {label} · until {dependency.until}
                  {dependency.override === undefined ? '' : ' · overridden'}
                </button>
                {onUndepend === null ? null : (
                  <button
                    aria-label={`Stop waiting for ${label}`}
                    className="fy-board-chip__x"
                    onClick={() => onUndepend(dependency.task)}
                    type="button"
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
        </fieldset>
      )}
      {task.blocks.length === 0 ? null : (
        <fieldset aria-label="Blocks" className="fy-board-detail__chiprow">
          <span className="fy-board-detail__quiet">Blocks</span>
          {task.blocks.map(ref => (
            <span className="fy-board-chip" key={formatTaskRef(ref)}>
              <button className="fy-board-chip__open" onClick={() => onOpen(ref.id)} type="button">
                {formatTaskRef(ref)}
              </button>
            </span>
          ))}
        </fieldset>
      )}
    </div>
  );
}

const Anchor = ({ value }: { readonly value: string }) =>
  isWebLink(value) ? (
    <a className="fy-board-detail__anchor" href={value} rel="noreferrer" target="_blank">
      {linkLabel(value)}
      <ExternalLink aria-hidden="true" size={10} />
    </a>
  ) : (
    <code>{value}</code>
  );

export function LinksSection({
  task,
  runningOn,
}: {
  readonly task: BoardTaskView;
  readonly runningOn: readonly RunningOnMachine[];
}) {
  const { prs, branch, docs } = task.links;
  const empty = prs.length === 0 && branch === null && docs.length === 0 && task.shippedIn === null;
  if (empty) return <p className="fy-board-detail__quiet">No PR, branch or doc linked yet.</p>;
  return (
    <ul className="fy-board-detail__list" data-kind="links">
      {prs.map(pr => {
        const line = prLine(pr);
        return (
          <li data-tone={line.tone} key={pr.url}>
            <BoardIcon
              name={
                pr.state === 'merged'
                  ? 'pr-merged'
                  : pr.state === 'closed'
                    ? 'pr-closed'
                    : pr.draft
                      ? 'pr-draft'
                      : pr.checks === 'failing'
                        ? 'pr-fail'
                        : pr.checks === 'pending'
                          ? 'pr-pending'
                          : 'pr-pass'
              }
            />{' '}
            <a className="fy-board-detail__anchor" href={pr.url} rel="noreferrer" target="_blank">
              {pr.repo}#{pr.number}
            </a>
            <span className="fy-board-detail__quiet">
              {' '}
              · {line.state}
              {line.checks === null ? '' : ` · ${line.checks}`}
              {pr.releasedIn === null ? '' : ` · in ${pr.releasedIn.version}`}
            </span>
          </li>
        );
      })}
      {task.shippedIn === null ? null : (
        <li data-kind="shipped">
          Shipped in <strong>{task.shippedIn.version}</strong>
          {runningOn.length === 0 ? null : (
            <ul aria-label="Running on" className="fy-board-detail__running">
              {runningOn.map(machine => (
                <li data-has={machine.has ? 'yes' : 'no'} key={machine.daemonId}>
                  {machine.machine}:{' '}
                  {machine.has
                    ? `running ${machine.version}`
                    : machine.version === null
                      ? 'version unknown'
                      : `still on ${machine.version}`}
                </li>
              ))}
            </ul>
          )}
        </li>
      )}
      {branch === null ? null : (
        <li>
          <GitBranch aria-hidden="true" size={11} /> <Anchor value={branch} />
        </li>
      )}
      {docs.map(doc => (
        <li key={doc}>
          <Anchor value={doc} />
        </li>
      ))}
    </ul>
  );
}

/** Where the card stands on one line each: id, kind and project are in the header; this is the asks log. */
export function AsksList({ asks, names }: { readonly asks: CardAsks; readonly names: FerretNames }) {
  if (asks.open.length === 0 && asks.resolved.length === 0) {
    return <p className="fy-board-detail__quiet">{asks.reading ? 'Reading the asks…' : 'No asks have been raised.'}</p>;
  }
  return (
    <ul className="fy-board-detail__list" data-kind="asks">
      {asks.open.map(row => (
        <li data-state="open" key={`${row.ref.sessionId}/${row.ref.id}`}>
          <strong>{row.blocking ? 'Blocking' : 'Open'}</strong> ·{' '}
          {row.item === null ? `${row.ref.id} from ${names(row.ref.sessionId)}` : row.item.title}
        </li>
      ))}
      {asks.resolved.map(item => (
        <li data-state="resolved" key={`${item.id}:${item.resolvedAt}`}>
          <strong>{item.disposition === 'dismissed' ? 'Dismissed' : 'Answered'}</strong> · {item.title}
          {item.resolutionNote === null ? null : (
            <span className="fy-board-detail__quiet"> · {item.resolutionNote}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function HistorySection({
  task,
  context,
  now,
}: {
  readonly task: BoardTaskView;
  readonly context: HistoryContext;
  readonly now: number;
}) {
  const items = foldHistory(historyRows(task.history, context));
  const row = (entry: ReturnType<typeof historyRows>[number]) => (
    <li data-type={entry.type} key={entry.seq}>
      <span className="fy-board-detail__quiet">{ageLabel(entry.at, now) ?? ''} · </span>
      <strong>{entry.actor}</strong> {entry.text}
      {entry.detail === null ? null : <span className="fy-board-detail__detail">{entry.detail}</span>}
    </li>
  );
  return (
    <ol className="fy-board-detail__history">
      {items.map(item =>
        item.kind === 'row' ? (
          row(item.row)
        ) : (
          <li data-kind="fold" key={`fold-${item.rows[0]?.seq}`}>
            <details>
              <summary className="fy-board-detail__quiet">{item.label}</summary>
              <ol className="fy-board-detail__history">{item.rows.map(row)}</ol>
            </details>
          </li>
        ),
      )}
    </ol>
  );
}
