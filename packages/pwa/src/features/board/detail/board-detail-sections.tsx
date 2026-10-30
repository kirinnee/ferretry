/** THE SECTIONS OF A CARD'S DETAIL: plain headed blocks in one flowing page, each drawing one fact and deciding nothing. */

import { type BoardTaskView, formatTaskRef, type TaskRef } from '@ferretry/protocol';
import { ExternalLink, GitBranch } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { Markdown } from '../../../components/markdown.tsx';
import {
  askOrigin,
  askWords,
  type CardAsks,
  type HistoryContext,
  historyRows,
  isWebLink,
  linkLabel,
  prLine,
} from '../../../lib/board-detail.ts';
import type { RunningOnMachine } from '../../../lib/board-model.ts';
import { ageLabel, type FerretNames } from '../../../lib/board-present.ts';
import { BoardIcon } from '../board-icons.tsx';

export interface DetailSectionProps {
  readonly id: string;
  readonly title: ReactNode;
  readonly count?: number;
  readonly children: ReactNode;
}

/** A plain block: a small muted heading and the facts under it. Nothing folds and nothing is boxed. */
export function DetailSection({ id, title, count, children }: DetailSectionProps) {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="fy-board-detail__section" data-section={id}>
      <h3 className="fy-board-detail__heading" id={heading}>
        {title}
        {count === undefined ? null : <span className="fy-board-detail__count">{count}</span>}
      </h3>
      <div className="fy-board-detail__body">{children}</div>
    </section>
  );
}

/** A person as a small round initial in the page's own colours; the name is always written beside it. */
export function Avatar({ name }: { readonly name: string }) {
  return (
    <span aria-hidden="true" className="fy-board-avatar">
      {name.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Prose({ text, empty }: { readonly text: string; readonly empty: string }) {
  return text.trim() === '' ? <p className="fy-board-detail__quiet">{empty}</p> : <Markdown text={text} />;
}

export function AskSection({
  task,
  names,
  now,
  onOpenSession,
}: {
  readonly task: BoardTaskView;
  readonly names: FerretNames;
  readonly now: number;
  readonly onOpenSession: (sessionId: string) => void;
}) {
  const origin = askOrigin(task, names, ageLabel(task.createdAt, now));
  return (
    <>
      <blockquote className="fy-board-detail__ask">{askWords(task.ask.text)}</blockquote>
      <p className="fy-board-detail__quiet" data-kind="ask-origin">
        from {origin.who}
        {origin.via === null ? null : ` via ${origin.via}`}
        {origin.age === null ? null : ` · ${origin.age}`}
        {origin.sessionId === null ? null : (
          <>
            {' · '}
            <button
              className="fy-board-detail__link"
              onClick={() => onOpenSession(origin.sessionId as string)}
              type="button"
            >
              {origin.chat}
            </button>
          </>
        )}
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
  if (task.dependsOn.length === 0 && task.blocks.length === 0) return null;
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

/**
 * What the card waits on, or one line saying nothing — with "Add dependency" always there and the form behind
 * it only once it is pressed, so a card that waits on nothing does not carry a form it will not use.
 */
export function DependsLine({
  task,
  adding,
  form,
  onOpen,
  onUndepend,
  onToggleAdd,
}: {
  readonly task: BoardTaskView;
  readonly adding: boolean;
  readonly form: ReactNode;
  readonly onOpen: (id: string) => void;
  readonly onUndepend: ((ref: TaskRef) => void) | null;
  readonly onToggleAdd: () => void;
}) {
  const none = task.dependsOn.length === 0 && task.blocks.length === 0;
  return (
    <>
      <DependencyChips onOpen={onOpen} onUndepend={onUndepend} task={task} />
      <p className="fy-board-detail__quiet" data-kind="add-dependency">
        {none ? 'Nothing. ' : null}
        <button
          aria-expanded={adding}
          className="fy-board-detail__link"
          data-action="add-dependency"
          onClick={onToggleAdd}
          type="button"
        >
          Add dependency
        </button>
      </p>
      {adding ? form : null}
    </>
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
            <BoardIcon name={prIconName(pr)} />{' '}
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

/** The icon that says where a PR stands, for the header's one-line meta and the Links list alike. */
export const prIconName = (pr: BoardTaskView['links']['prs'][number]) =>
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
            : 'pr-pass';

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

/** The card's history as a timeline, newest first: who, what, how long ago, and the note behind it muted below. */
export function HistorySection({
  task,
  context,
  now,
}: {
  readonly task: BoardTaskView;
  readonly context: HistoryContext;
  readonly now: number;
}) {
  const rows = historyRows(task.history, context);
  return (
    <ol className="fy-board-timeline">
      {rows.map(entry => (
        <li
          className="fy-board-timeline__row"
          data-minor={entry.minor ? '' : undefined}
          data-type={entry.type}
          key={entry.seq}
        >
          <Avatar name={entry.actor} />
          <div className="fy-board-timeline__what">
            <p className="fy-board-timeline__line">
              <strong>{entry.actor}</strong> {entry.text}
              <span className="fy-board-detail__quiet"> · {ageLabel(entry.at, now) ?? ''}</span>
            </p>
            {entry.detail === null ? null : <p className="fy-board-detail__detail">{entry.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
