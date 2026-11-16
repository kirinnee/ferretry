/**
 * THE CARD DETAIL (`/d/<id>/board/<taskId>`): one card in full, over the Board — READ-ONLY.
 *
 * One flowing page, in the manner of a task page: a header (id, title, the summary line, the lane as plain text,
 * who and where), then the card read top to bottom as an agenda card reads — the status, then premise and context
 * as two tinted blocks, the ask, How to test as a numbered list (its boxes are a reading aid), the brief, the terms
 * (each also a tap tip where the text uses it) — then the plain headed sections and a timeline. Nothing folds.
 * The owner has NO hand controls here: no lane menu, no Done, no Not good, no Reopen, no dependency form, no
 * comment box, no reparent or drop. The board runs itself and the owner answers where a card asks, in the agenda;
 * a ferret is spoken to in its own chat ("Open chat"). The only buttons are reading aids: Open chat, Copy link,
 * and links to the agenda items, sub-cards and sessions. A side drawer on a wide screen and a full-screen page on
 * a phone; either way the address names the card, so Back leaves it and a link opens it. The card is read through
 * the board store (one source of truth with the Board behind it) and an ask opens in its ferret's chat as the same
 * item view every `!A5` opens — it is answered there, never here. This file composes; the facts are
 * `board-detail.ts` and the sections draw them.
 */

import {
  type CardId,
  type CardView,
  formatCardRef,
  type LaneSet,
  parseCardRef,
  writtenProgressParts,
} from '../../../contract/index.ts';
import { ArrowLeft, Link, MessageSquare, X } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode, useMemo, useState } from 'react';
import { type BoardMachine, useBoardCard } from '../../hooks/use-board.ts';
import { activityText, hasLinks, kindLabel, laneCategoryOf, laneNameOf, written } from '../../lib/board-detail.ts';
import type { RunningOnMachine } from '../../lib/board-model.ts';
import type { FerretNames } from '../../lib/board-present.ts';
import type { DaemonBoardStore } from '../../lib/board-store.ts';
import { useCardAsks } from '../../hooks/use-card-asks.ts';
import { agendaAskPath, boardPath, ferretPath } from '../../lib/paths.ts';
import { cardProse } from '../prose.tsx';
import { markTerms, TermLayer } from './card-terms.tsx';
import { Situation } from './situation.tsx';
import { BoardIcon } from '../board-icons.tsx';
import {
  AsksList,
  AskSection,
  Avatar,
  type ChildLine,
  ChildrenList,
  DependsLine,
  DetailSection,
  HistorySection,
  HowToTest,
  LinksSection,
  Prose,
  prIconName,
  TermsTable,
} from './board-detail-sections.tsx';

/** The card's own texts, each `null` when empty, with the first use of each term marked as a tap tip, in reading order. */
const markedTexts = (task: CardView) => {
  const seen = new Set<number>();
  const mark = (text: string): string | null => (written(text) ? markTerms(text, task.terms, seen) : null);
  return {
    progress: writtenProgressParts(task.progress).map(part => ({
      ...part,
      text: markTerms(part.text, task.terms, seen),
    })),
    premise: mark(task.premise),
    context: mark(task.context),
    howToTest: mark(task.howToTest),
    brief: mark(task.brief),
  };
};

export interface BoardDetailProps {
  readonly store: DaemonBoardStore;
  readonly machine: BoardMachine;
  readonly taskId: string;
  readonly names: FerretNames;
  readonly now: number;
  readonly projectName: (projectId: string) => string;
  /** The cards the Board already has, for sub-cards and the release each machine is on. */
  readonly siblings: readonly {
    readonly task: CardView;
    readonly laneName: string;
    readonly runningOn: readonly RunningOnMachine[];
  }[];
  /** A phone shows the card as a page of its own; a wide screen as a drawer beside the Board. */
  readonly phone: boolean;
  readonly onClose: () => void;
  readonly onNavigate: (to: string) => void;
}

/**
 * ONE CARD THAT CANNOT BE DRAWN STAYS IN ITS DRAWER. Without this, a throw anywhere in a card reached the
 * pane's boundary and replaced the whole Board with "reload to recover" — which a reload could not fix, since
 * the same card throws again — and the error itself was only in a console a phone does not show
 * (2026-10-30). Here the drawer keeps its bar (Close still works), the Board stays usable behind it, and the
 * error's own message is on screen, so the reader can say what failed. A different card starts clean.
 */
class CardErrorBoundary extends Component<
  {
    readonly label: string;
    readonly onReport?: (message: string, error: unknown, componentStack: string | null | undefined) => void;
    readonly children: ReactNode;
  },
  { readonly error: string | null }
> {
  override state: { readonly error: string | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { readonly error: string } {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { error: message.trim() === '' ? 'Unknown error' : message };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const report = this.props.onReport ?? ((message, caught, stack) => console.warn(message, caught, stack));
    report(`ferretry: card ${this.props.label} failed to render`, error, info?.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="fy-board-detail__empty" role="alert">
        <p className="m-0">{this.props.label} could not be drawn.</p>
        <p className="fy-board-detail__error m-0">{this.state.error}</p>
      </div>
    );
  }
}

export function BoardDetail(props: BoardDetailProps) {
  const { phone, onClose, taskId, machine } = props;
  const ref = parseCardRef(taskId);
  const label = ref.ok ? formatCardRef(ref.value) : taskId;
  return (
    <div className="fy-board-detail__scrim" data-mode={phone ? 'page' : 'drawer'}>
      <div aria-hidden="true" className="fy-board-detail__backdrop" onClick={onClose} />
      <aside
        aria-label={`Card ${label}`}
        className="fy-board-detail"
        data-mode={phone ? 'page' : 'drawer'}
        onKeyDown={event => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <div className="fy-board-detail__bar">
          <button aria-label="Back to the Board" className="fy-board-detail__close" onClick={onClose} type="button">
            {phone ? <ArrowLeft aria-hidden="true" size={14} /> : <X aria-hidden="true" size={14} />}
            {phone ? 'Board' : null}
          </button>
        </div>
        {ref.ok ? (
          <CardErrorBoundary key={`${String(machine.connection.daemonId)}/${label}`} label={label}>
            <LoadedCard {...props} id={ref.value.id} />
          </CardErrorBoundary>
        ) : (
          <p className="fy-board-detail__empty" role="status">
            {machine.name} has no card {label}.
          </p>
        )}
      </aside>
    </div>
  );
}

function LoadedCard(props: BoardDetailProps & { readonly id: CardId }) {
  const { store, machine, id } = props;
  const state = useBoardCard(store, machine.connection, id);
  const label = formatCardRef({ id });
  if (state.missing) {
    return (
      <p className="fy-board-detail__empty" role="status">
        {machine.name} has no card {label}.
      </p>
    );
  }
  if (state.task !== null) return <DetailBody {...props} laneSet={state.laneSet} task={state.task} />;
  if (state.status === 'error') {
    return (
      <p className="fy-board-detail__empty" role="alert">
        The card could not be read: {state.error ?? 'the machine did not answer'}.
      </p>
    );
  }
  return (
    <p className="fy-board-detail__empty" role="status">
      Reading {label}…
    </p>
  );
}

function DetailBody({
  store,
  task,
  laneSet,
  machine,
  names,
  now,
  projectName,
  siblings,
  onNavigate,
}: BoardDetailProps & { readonly task: CardView; readonly laneSet: LaneSet | null }) {
  const [notice, setNotice] = useState<string | null>(null);

  const category = laneCategoryOf(laneSet, task.laneId);
  const recipient = task.assignee ?? task.owner;
  const here = siblings.find(card => card.task.id === task.id);
  const children: readonly ChildLine[] = useMemo(
    () =>
      siblings
        .filter(card => card.task.parent !== null && card.task.parent.id === task.id)
        .map(card => ({ task: card.task, laneName: card.laneName })),
    [siblings, task.id],
  );
  const historyContext = useMemo(
    () => ({ names, laneName: (laneId: string) => laneNameOf(laneSet, laneId) }),
    [names, laneSet],
  );
  const open = (id: string): void => onNavigate(`${boardPath(machine.connection.daemonId)}/${encodeURIComponent(id)}`);
  const marked = useMemo(() => markedTexts(task), [task]);
  const asks = useCardAsks(store, machine.connection, task);
  const firstPr = task.links.prs[0] ?? null;

  const copyLink = (): void => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard === undefined) {
      setNotice('This browser cannot copy; the address bar has the link.');
      return;
    }
    void clipboard.writeText(window.location.href).then(
      () => setNotice('Link copied.'),
      () => setNotice('The link could not be copied.'),
    );
  };

  return (
    <div className="fy-board-detail__content">
      <header className="fy-board-detail__head" data-section="header">
        <div className="fy-board-detail__headline">
          <h2 className="fy-board-detail__title">
            <span className="fy-board-detail__id">{formatCardRef({ id: task.id })}</span> {task.title}
          </h2>
          <div className="fy-board-detail__tools">
            <button
              className="kt-btn"
              data-variant="ghost"
              onClick={() => onNavigate(ferretPath(machine.connection.daemonId, recipient))}
              type="button"
            >
              <MessageSquare aria-hidden="true" size={12} /> Open chat
            </button>
            <button className="kt-btn" data-variant="ghost" onClick={copyLink} type="button">
              <Link aria-hidden="true" size={12} /> Copy link
            </button>
          </div>
        </div>
        {written(task.summary) ? (
          <div className="fy-board-detail__summary" data-section="summary">
            {cardProse(task.summary)}
          </div>
        ) : null}
        <div className="fy-board-detail__meta">
          <span className="fy-board-detail__pill" data-pill="lane" data-static="">
            {laneNameOf(laneSet, task.laneId)}
          </span>
          {firstPr === null ? null : (
            <a className="fy-board-detail__metalink" data-meta="pr" href={firstPr.url} rel="noreferrer" target="_blank">
              <BoardIcon name={prIconName(firstPr)} size={13} /> {firstPr.repo}#{firstPr.number}
            </a>
          )}
          <span className="fy-board-detail__who" data-meta="assignee">
            <Avatar name={names(recipient)} /> {names(recipient)}
          </span>
          <span className="fy-board-detail__activity" data-activity={task.activity}>
            <BoardIcon
              name={
                category === 'verify'
                  ? 'to-test'
                  : task.activity === 'active'
                    ? 'active'
                    : task.activity === 'stale'
                      ? 'stale'
                      : task.activity === 'orphaned'
                        ? 'orphaned'
                        : 'waiting'
              }
              size={13}
            />{' '}
            {activityText(task, category)}
          </span>
          <span className="fy-board-detail__faint">
            {kindLabel(task.kind)} · {projectName(task.projectId)}
          </span>
        </div>
        {task.dropped === null ? null : (
          <div className="fy-board-detail__quiet" data-state="dropped">
            Dropped: {cardProse(task.dropped.reason)}
          </div>
        )}
        {notice === null ? null : (
          <p className="fy-board-detail__notice" role="status">
            {notice}
          </p>
        )}
      </header>

      <TermLayer renderProse={cardProse} terms={task.terms}>
        <Situation
          context={marked.context}
          premise={marked.premise}
          renderProse={cardProse}
          progress={marked.progress}
        />

        <DetailSection id="ask" title="Ask">
          <AskSection
            names={names}
            now={now}
            onOpenSession={sessionId => onNavigate(ferretPath(machine.connection.daemonId, sessionId))}
            task={task}
          />
        </DetailSection>

        {marked.howToTest === null ? null : (
          <DetailSection id="how-to-test" title="How to test">
            <HowToTest key={marked.howToTest} renderProse={cardProse} text={marked.howToTest} />
          </DetailSection>
        )}

        {marked.brief === null ? null : (
          <DetailSection id="brief" title="Brief">
            <Prose text={marked.brief} />
          </DetailSection>
        )}
        {task.terms.length === 0 ? null : (
          <DetailSection count={task.terms.length} id="terms" title="Terms">
            <TermsTable terms={task.terms} />
          </DetailSection>
        )}
      </TermLayer>

      {children.length === 0 ? null : (
        <DetailSection count={children.length} id="children" title="Sub-cards">
          <ChildrenList lines={children} now={now} onOpen={open} />
        </DetailSection>
      )}

      {hasLinks(task) ? (
        <DetailSection id="links" title="Links">
          <LinksSection runningOn={here?.runningOn ?? []} task={task} />
        </DetailSection>
      ) : null}

      <DetailSection id="depends" title="Depends on">
        <DependsLine onOpen={open} task={task} />
      </DetailSection>

      {asks.open.length + asks.resolved.length === 0 ? null : (
        <DetailSection count={asks.open.length + asks.resolved.length} id="asks" title="Agenda asks">
          <AsksList asks={asks} names={names} onOpen={(ferret, id) => onNavigate(agendaAskPath(ferret, id))} />
        </DetailSection>
      )}

      <DetailSection id="history" title="History">
        <HistorySection context={historyContext} now={now} task={task} />
      </DetailSection>
    </div>
  );
}
