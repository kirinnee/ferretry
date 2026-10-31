/**
 * THE SECTIONS OF A CARD'S DETAIL: plain headed blocks in one flowing page, each drawing one fact and deciding nothing.
 * Every text a ferret wrote (summary, premise, context, brief, How to test) is Markdown drawn by the chat's one
 * renderer (`ChatProse`), so hypermedia blocks and references behave exactly as in a message or an agenda card.
 */

import { type BoardTaskView, formatTaskRef, type TaskRef } from '@ferretry/protocol';
import { ExternalLink, GitBranch } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { ChatProse } from '../../../components/chat-prose.tsx';
import {
  askOrigin,
  askWords,
  type CardAsks,
  type HistoryContext,
  historyRows,
  isWebLink,
  linkLabel,
  prLine,
  testSteps,
} from '../../../lib/board-detail.ts';
import type { RunningOnMachine } from '../../../lib/board-model.ts';
import { ageLabel, type FerretNames } from '../../../lib/board-present.ts';
import { agendaHeading } from '../../agenda/agenda-delivery.tsx';
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

/** A card's Markdown, drawn as the chat draws it. */
export const cardProse = (text: string): ReactNode => <ChatProse text={text} />;

export function Prose({ text }: { readonly text: string }) {
  return <div className="fy-board-detail__prose">{cardProse(text)}</div>;
}

/**
 * HOW TO TEST: the owner's checklist before Done. A list is drawn as numbered steps, each with a box the owner
 * ticks as they go (on this screen only: a tick is a reminder, never a verdict); anything else is drawn whole.
 */
export function HowToTest({ text, renderProse }: { readonly text: string; readonly renderProse: Prose }) {
  const parsed = testSteps(text);
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  if (parsed === null) return <div className="fy-board-test">{renderProse(text)}</div>;
  const toggle = (step: number): void =>
    setTicked(current => {
      const next = new Set(current);
      if (!next.delete(step)) next.add(step);
      return next;
    });
  return (
    <div className="fy-board-test" data-test-steps={parsed.steps.length}>
      {parsed.lead === null ? null : <div className="fy-board-test__lead">{renderProse(parsed.lead)}</div>}
      <ol className="fy-board-test__list">
        {parsed.steps.map((step, index) => (
          <li
            className="fy-board-test__step"
            data-done={ticked.has(index) ? '' : undefined}
            // biome-ignore lint/suspicious/noArrayIndexKey: a step's place is its identity
            key={index}
          >
            <input
              aria-label={`Step ${index + 1} checked`}
              checked={ticked.has(index)}
              className="fy-attn-step__box"
              data-test-tick={index}
              onChange={() => toggle(index)}
              type="checkbox"
            />
            <span aria-hidden="true" className="fy-board-test__n">
              {index + 1}
            </span>
            <div className="fy-board-test__text">{renderProse(step)}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}

type Prose = (text: string) => ReactNode;

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

/**
 * The card's asks, one row each — blocking first, then open, then answered. A list is only a list: a row opens the
 * item's view in its ferret's chat (the same view a `!A5` click opens), where it is answered; nothing is answered here.
 */
export function AsksList({
  asks,
  names,
  onOpen,
}: {
  readonly asks: CardAsks;
  readonly names: FerretNames;
  /** Open one ask's view, by the ferret whose agenda holds it. */
  readonly onOpen: (sessionId: string, id: string) => void;
}) {
  if (asks.open.length === 0 && asks.resolved.length === 0) {
    return <p className="fy-board-detail__quiet">{asks.reading ? 'Reading the asks…' : 'No asks have been raised.'}</p>;
  }
  const open = [...asks.open].sort((a, b) => Number(b.blocking) - Number(a.blocking));
  return (
    <ul className="fy-board-detail__list" data-kind="asks">
      {open.map(row => (
        <li data-state={row.blocking ? 'blocking' : 'open'} key={`${row.ref.sessionId}/${row.ref.id}`}>
          <button
            className="fy-board-detail__askrow"
            data-ask-open={row.ref.id}
            onClick={() => onOpen(row.ref.sessionId, row.ref.id)}
            type="button"
          >
            <strong>{row.blocking ? 'Blocking' : 'Open'}</strong> ·{' '}
            {row.item === null ? `${row.ref.id} from ${names(row.ref.sessionId)}` : agendaHeading(row.item)}
          </button>
        </li>
      ))}
      {asks.resolved.map(({ sessionId, item }) => (
        <li data-state="resolved" key={`${sessionId}/${item.id}:${item.resolvedAt}`}>
          <button
            className="fy-board-detail__askrow"
            data-ask-open={item.id}
            onClick={() => onOpen(sessionId, item.id)}
            type="button"
          >
            <strong>{item.disposition === 'dismissed' ? 'Dismissed' : 'Answered'}</strong> · {agendaHeading(item)}
            {item.resolutionNote === null ? null : (
              <span className="fy-board-detail__quiet"> · {item.resolutionNote}</span>
            )}
          </button>
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
