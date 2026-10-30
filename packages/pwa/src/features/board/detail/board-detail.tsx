/**
 * THE CARD DETAIL (`/d/<id>/board/<taskId>`): one card in full, over the Board.
 *
 * A side drawer on a wide screen and a full-screen page on a phone; either way the address names the card,
 * so Back leaves it and a link opens it. The card is read through the board store (one source of truth with
 * the Board behind it), every write goes through `BoardActions`, and an answer to a waiting ask goes through
 * the agenda client every other answer uses. This file composes; the facts are `board-detail.ts` and the
 * sections draw them.
 */

import {
  type BoardTaskId,
  type BoardTaskView,
  formatTaskRef,
  type LaneSet,
  parseTaskRef,
  type TaskRef,
} from '@ferretry/protocol';
import { ArrowLeft, Check, ChevronDown, MessageSquare, X } from 'lucide-react';
import { Component, type ErrorInfo, type FormEvent, type ReactNode, useId, useMemo, useState } from 'react';
import { type BoardMachine, useBoardTask } from '../../../hooks/use-board.ts';
import { useBoardAsks } from '../../../hooks/use-board-asks.ts';
import type { DaemonAgendaClient } from '../../../lib/agenda-client.ts';
import type { BoardActions } from '../../../lib/board-actions.ts';
import {
  activityText,
  askSessions,
  collectAsks,
  commentNote,
  ferretComment,
  hasLinks,
  kindLabel,
  laneCategoryOf,
  laneNameOf,
  laneStepper,
  verdictLanes,
  written,
} from '../../../lib/board-detail.ts';
import type { RunningOnMachine } from '../../../lib/board-model.ts';
import { boardDone } from '../../../lib/board-done.ts';
import { moveChoices, planMove } from '../../../lib/board-move.ts';
import { peopleLabel, type FerretNames } from '../../../lib/board-present.ts';
import type { DaemonBoardStore } from '../../../lib/board-store.ts';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { daemonBoardPath, daemonSessionPath } from '../../../lib/pages/routes.ts';
import { BoardIcon } from '../board-icons.tsx';
import { BoardDoneAction } from '../board-done-action.tsx';
import { BoardReasonBox } from '../board-reason-box.tsx';
import {
  AskSection,
  AsksList,
  type ChildLine,
  ChildrenList,
  DependencyChips,
  DetailSection,
  HistorySection,
  LaneStepper,
  LinksSection,
  Prose,
  TermsTable,
} from './board-detail-sections.tsx';
import { WaitingOnYou } from './board-detail-waiting.tsx';

export type BoardAgenda = Pick<DaemonAgendaClient, 'hydrate' | 'respond' | 'store'>;

/** What the detail needs from outside the Board: a way to speak to a ferret. */
export interface BoardDetailPorts {
  /** Sends one message to a ferret's session on this machine. */
  readonly sendMessage: (daemon: DaemonConnection, sessionId: string, message: string) => Promise<void>;
}

export interface BoardDetailProps {
  readonly store: DaemonBoardStore;
  readonly agenda: BoardAgenda;
  readonly actions: BoardActions;
  readonly machine: BoardMachine;
  readonly taskId: string;
  readonly names: FerretNames;
  readonly now: number;
  readonly projectName: (projectId: string) => string;
  /** The cards the Board already has, for sub-cards and the release each machine is on. */
  readonly siblings: readonly {
    readonly task: BoardTaskView;
    readonly laneName: string;
    readonly runningOn: readonly RunningOnMachine[];
  }[];
  readonly ports: BoardDetailPorts;
  /** A phone shows the card as a page of its own; a wide screen as a drawer beside the Board. */
  readonly phone: boolean;
  readonly onClose: () => void;
  readonly onNavigate: (to: string) => void;
}

type Dialog =
  | { readonly kind: 'move'; readonly to: string; readonly toName: string }
  | { readonly kind: 'rework'; readonly to: string; readonly toName: string }
  | { readonly kind: 'drop' }
  | { readonly kind: 'undepend'; readonly ref: TaskRef };

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
  const ref = parseTaskRef(taskId);
  const label = ref.ok ? formatTaskRef(ref.value) : taskId;
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
          <span className="fy-board-detail__ref">{label}</span>
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

function LoadedCard(props: BoardDetailProps & { readonly id: BoardTaskId }) {
  const { store, machine, id } = props;
  const state = useBoardTask(store, machine.connection, id);
  const label = formatTaskRef({ id });
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
  task,
  laneSet,
  agenda,
  actions,
  machine,
  names,
  now,
  projectName,
  siblings,
  ports,
  onNavigate,
}: BoardDetailProps & { readonly task: BoardTaskView; readonly laneSet: LaneSet | null }) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();

  const target = { daemonId: machine.connection.daemonId, id: task.id };
  const moveTarget = { ...target, laneId: task.laneId, laneSet };
  const category = laneCategoryOf(laneSet, task.laneId);
  const verdict = verdictLanes(laneSet, task.laneId);
  const done = verdict === null ? boardDone({ laneSet, category, dropped: task.dropped !== null }) : null;
  const recipient = task.assignee ?? task.owner;
  const asks = collectAsks(task, useBoardAsks(agenda, machine.connection, askSessions(task)));
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
  const open = (id: string): void =>
    onNavigate(`${daemonBoardPath(machine.connection.daemonId)}/${encodeURIComponent(id)}`);

  const run = async (work: () => Promise<{ readonly ok: boolean; readonly error?: { readonly message: string } }>) => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const result = await work();
    setBusy(false);
    if (result.ok) {
      setDialog(null);
      return true;
    }
    setProblem(result.error?.message ?? 'That did not go through.');
    return false;
  };

  const requestMove = (to: string): void => {
    setMenuOpen(false);
    setNotice(null);
    const plan = planMove(laneSet, task.laneId, to);
    if (plan.kind === 'refused') setNotice(plan.message);
    else if (plan.kind === 'ask-reason') {
      setProblem(null);
      setDialog({ kind: 'move', to: plan.to, toName: laneNameOf(laneSet, plan.to) });
    } else if (plan.kind === 'send') void run(() => actions.moveTask(moveTarget, plan.to));
  };

  const submitReason = (reason: string): void => {
    if (dialog === null) return;
    if (dialog.kind === 'move' || dialog.kind === 'rework')
      void run(() => actions.moveTask(moveTarget, dialog.to, reason));
    else if (dialog.kind === 'drop') void run(() => actions.drop(target, reason));
    else void run(() => actions.undepend(target, dialog.ref, reason));
  };

  const dialogHeading =
    dialog === null
      ? ''
      : dialog.kind === 'move'
        ? `Move ${task.title} back to ${dialog.toName}`
        : dialog.kind === 'rework'
          ? `Not good: send ${task.title} back to ${dialog.toName}`
          : dialog.kind === 'drop'
            ? `Drop ${task.title}`
            : `Stop ${task.title} waiting for ${formatTaskRef(dialog.ref)}`;
  const dialogWords =
    dialog === null
      ? {}
      : dialog.kind === 'drop'
        ? { placeholder: 'Why is it being dropped?', submitLabel: 'Drop it', busyLabel: 'Dropping…' }
        : dialog.kind === 'undepend'
          ? { placeholder: 'Why does it no longer wait?', submitLabel: 'Stop waiting', busyLabel: 'Saving…' }
          : dialog.kind === 'rework'
            ? {
                placeholder: 'What is not good? The ferret reads this.',
                submitLabel: 'Send back',
                busyLabel: 'Sending…',
              }
            : {};

  return (
    <div className="fy-board-detail__content">
      <header className="fy-board-detail__head" data-section="header">
        <h2 className="fy-board-detail__title">{task.title}</h2>
        <p className="fy-board-detail__meta">
          <span>{formatTaskRef({ id: task.id })}</span>
          <span>{kindLabel(task.kind)}</span>
          <span>{projectName(task.projectId)}</span>
          <span>{peopleLabel(task, names)}</span>
          {task.dropped === null ? null : <span data-state="dropped">Dropped: {task.dropped.reason}</span>}
        </p>
        <p className="fy-board-detail__activity" data-activity={task.activity}>
          <BoardIcon
            name={
              category === 'verify'
                ? 'to-test'
                : task.waitingOnOwner.length > 0
                  ? 'waiting-on-you'
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
        </p>
      </header>

      {notice === null ? null : (
        <p className="fy-board-detail__notice" role="status">
          {notice}
        </p>
      )}

      {verdict === null || task.dropped !== null ? null : (
        <fieldset aria-label="Your verdict" className="fy-board-detail__verdict">
          {verdict.closeLaneId === null ? null : (
            <button
              className="fy-board-detail__big"
              data-verdict="works"
              disabled={busy}
              title="Works → Close"
              onClick={() => requestMove(verdict.closeLaneId as string)}
              type="button"
            >
              <Check aria-hidden="true" size={14} />
              Close
            </button>
          )}
          {verdict.reworkLaneId === null ? null : (
            <button
              className="fy-board-detail__big"
              data-verdict="not-good"
              disabled={busy}
              title={`Not good → back to ${laneNameOf(laneSet, verdict.reworkLaneId)}, with a reason`}
              onClick={() => {
                setProblem(null);
                const to = verdict.reworkLaneId as string;
                setDialog({ kind: 'rework', to, toName: laneNameOf(laneSet, to) });
              }}
              type="button"
            >
              <X aria-hidden="true" size={14} />
              Not good
            </button>
          )}
        </fieldset>
      )}

      {done === null ? null : (
        <div className="fy-board-detail__done">
          <BoardDoneAction
            disabled={busy}
            done={done}
            onPress={() => requestMove(done.laneId)}
            size="primary"
            title={task.title}
          />
        </div>
      )}

      <DetailSection id="stepper" title="Lane">
        <LaneStepper steps={laneStepper(laneSet, task.laneId)} />
      </DetailSection>

      <DetailSection id="summary" title="Summary">
        <Prose empty="No summary yet." text={task.summary} />
      </DetailSection>

      {task.waitingOnOwner.length === 0 ? null : (
        <DetailSection
          count={task.waitingOnOwner.length}
          id="waiting"
          title={
            <span className="fy-board-detail__titled">
              <BoardIcon name="waiting-on-you" size={12} /> Waiting on you
            </span>
          }
        >
          <WaitingOnYou
            asks={asks}
            names={names}
            onAnswer={async (ref, response, note) => {
              const result = await actions.answer(machine.connection.daemonId, ref, response, note);
              return result.ok ? null : result.error.message;
            }}
          />
        </DetailSection>
      )}

      <DetailSection id="ask" title="Ask">
        <AskSection
          names={names}
          now={now}
          onOpenSession={sessionId => onNavigate(daemonSessionPath(machine.connection.daemonId, sessionId))}
          task={task}
        />
      </DetailSection>

      {written(task.premise) ? (
        <DetailSection defaultOpen={false} id="premise" title="Premise">
          <Prose empty="" text={task.premise} />
        </DetailSection>
      ) : null}
      {written(task.context) ? (
        <DetailSection defaultOpen={false} id="context" title="Context">
          <Prose empty="" text={task.context} />
        </DetailSection>
      ) : null}
      {task.terms.length === 0 ? null : (
        <DetailSection count={task.terms.length} defaultOpen={false} id="terms" title="Terms">
          <TermsTable terms={task.terms} />
        </DetailSection>
      )}
      {written(task.brief) ? (
        <DetailSection defaultOpen={false} id="brief" title="Brief">
          <Prose empty="" text={task.brief} />
        </DetailSection>
      ) : null}

      {children.length === 0 ? null : (
        <DetailSection count={children.length} id="children" title="Sub-cards">
          <ChildrenList lines={children} now={now} onOpen={open} />
        </DetailSection>
      )}

      <DetailSection id="depends" title="Depends on and blocks">
        <DependencyChips
          onOpen={open}
          onUndepend={ref => {
            setProblem(null);
            setDialog({ kind: 'undepend', ref });
          }}
          task={task}
        />
        <DependForm
          busy={busy}
          onAdd={(ref, until) => run(() => actions.depend(target, { task: ref, until }))}
          problem={dialog === null ? problem : null}
        />
      </DetailSection>

      {hasLinks(task) ? (
        <DetailSection id="links" title="Links">
          <LinksSection runningOn={here?.runningOn ?? []} task={task} />
        </DetailSection>
      ) : null}

      {asks.open.length + asks.resolved.length === 0 ? null : (
        <DetailSection count={asks.open.length + asks.resolved.length} id="asks" title="Asks">
          <AsksList asks={asks} names={names} />
        </DetailSection>
      )}

      <DetailSection id="history" title="History">
        <HistorySection context={historyContext} now={now} task={task} />
      </DetailSection>

      <fieldset aria-label="Card actions" className="fy-board-detail__actions">
        {laneSet === null || category === 'closed' || task.dropped !== null ? null : (
          <div className="fy-board-detail__menu">
            <button
              aria-controls={menuOpen ? menuId : undefined}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="kt-btn"
              data-variant="ghost"
              onClick={() => setMenuOpen(value => !value)}
              type="button"
            >
              Move <ChevronDown aria-hidden="true" size={12} />
            </button>
            {menuOpen ? (
              <div aria-label="Move to…" className="fy-board-menu" id={menuId} role="menu">
                {moveChoices(laneSet, task.laneId).map(choice => (
                  <button
                    className="fy-board-menu__item"
                    data-backward={choice.backward ? '' : undefined}
                    key={choice.laneId}
                    onClick={() => requestMove(choice.laneId)}
                    role="menuitem"
                    type="button"
                  >
                    {choice.name}
                    {choice.backward ? ' (needs a reason)' : ''}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}
        <button
          className="kt-btn"
          data-variant="ghost"
          onClick={() => onNavigate(daemonSessionPath(machine.connection.daemonId, recipient))}
          type="button"
        >
          <MessageSquare aria-hidden="true" size={12} /> Open chat
        </button>
        {task.dropped !== null ? null : (
          <button
            className="kt-btn"
            data-variant="ghost"
            onClick={() => {
              setProblem(null);
              setDialog({ kind: 'drop' });
            }}
            type="button"
          >
            Drop
          </button>
        )}
      </fieldset>

      <CommentForm
        busy={busy}
        name={names(recipient)}
        onSend={async text => {
          setBusy(true);
          setProblem(null);
          try {
            await ports.sendMessage(machine.connection, recipient, ferretComment(task, text));
          } catch (reason) {
            setBusy(false);
            return reason instanceof Error ? reason.message : 'The message did not go through.';
          }
          const noted = await actions.note(target, commentNote(text));
          setBusy(false);
          setNotice(
            noted.ok
              ? `Sent to ${names(recipient)}.`
              : `Sent to ${names(recipient)}, but not noted: ${noted.error.message}`,
          );
          return null;
        }}
      />

      {dialog === null ? null : (
        <div className="fy-board__scrim">
          <BoardReasonBox
            busy={busy}
            error={problem}
            heading={dialogHeading}
            onCancel={() => {
              setDialog(null);
              setProblem(null);
            }}
            onSubmit={submitReason}
            {...dialogWords}
          />
        </div>
      )}
    </div>
  );
}

function DependForm({
  busy,
  problem,
  onAdd,
}: {
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onAdd: (ref: TaskRef, until: 'shipped' | 'released') => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [until, setUntil] = useState<'shipped' | 'released'>('shipped');
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const ref = parseTaskRef(text);
    if (!ref.ok) {
      setError(
        ref.error.code === 'empty' ? 'Name the card it waits for, like &F412.' : `${text.trim()} is not a card id.`,
      );
      return;
    }
    setError(null);
    void onAdd(ref.value, until).then(ok => {
      if (ok) setText('');
      else setError('The daemon refused that dependency.');
    });
  };
  return (
    <form className="fy-board-detail__form" onSubmit={submit}>
      <input
        aria-label="Card it waits for"
        className="fy-board-reason__input"
        onChange={event => setText(event.target.value)}
        placeholder="Depend on… &F412"
        type="text"
        value={text}
      />
      <select
        aria-label="Until"
        className="fy-board-reason__input"
        onChange={event => setUntil(event.target.value === 'released' ? 'released' : 'shipped')}
        value={until}
      >
        <option value="shipped">until shipped</option>
        <option value="released">until released</option>
      </select>
      <button className="kt-btn" data-variant="ghost" disabled={busy} type="submit">
        Depend
      </button>
      {(error ?? problem) ? (
        <p className="fy-board-reason__error" role="alert">
          {error ?? problem}
        </p>
      ) : null}
    </form>
  );
}

function CommentForm({
  busy,
  name,
  onSend,
}: {
  readonly busy: boolean;
  readonly name: string;
  readonly onSend: (text: string) => Promise<string | null>;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (text.trim() === '') return;
    void onSend(text).then(failed => {
      setError(failed);
      if (failed === null) setText('');
    });
  };
  return (
    <form className="fy-board-detail__form" data-form="comment" onSubmit={submit}>
      <textarea
        aria-label={`Comment to ${name}`}
        className="fy-board-reason__input"
        onChange={event => setText(event.target.value)}
        placeholder={`Comment to ${name}…`}
        rows={2}
        value={text}
      />
      <button className="kt-btn" data-variant="primary" disabled={busy || text.trim() === ''} type="submit">
        Send to ferret
      </button>
      {error === null ? null : (
        <p className="fy-board-reason__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
