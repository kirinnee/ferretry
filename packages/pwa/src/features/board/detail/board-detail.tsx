/**
 * THE CARD DETAIL (`/d/<id>/board/<taskId>`): one card in full, over the Board.
 *
 * One flowing page, in the manner of a task page: a header (id, title, a lane dropdown, who and where), plain
 * headed sections, a timeline, and a comment box pinned at the bottom. A side drawer on a wide screen and a
 * full-screen page on a phone; either way the address names the card, so Back leaves it and a link opens it. The card is read through the board store (one source of truth with
 * the Board behind it), every write goes through `BoardActions`, and an ask opens in its ferret's chat as
 * the same item view every `!A5` opens — it is answered there, never here. This file composes; the facts are `board-detail.ts` and the
 * sections draw them.
 */

import {
  type AgendaId,
  type BoardTaskId,
  type BoardTaskView,
  formatTaskRef,
  type LaneSet,
  parseTaskRef,
  type TaskRef,
} from '@ferretry/protocol';
import { ArrowLeft, Check, ChevronDown, Ellipsis, MessageSquare, X } from 'lucide-react';
import { Component, type ErrorInfo, type FormEvent, type ReactNode, useId, useMemo, useState } from 'react';
import { type BoardMachine, useBoardTask } from '../../../hooks/use-board.ts';
import { useBoardAsks } from '../../../hooks/use-board-asks.ts';
import type { DaemonAgendaClient } from '../../../lib/agenda-client.ts';
import { agendaConversationPath } from '../../../lib/agenda-inbox.ts';
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
  verdictLanes,
  written,
} from '../../../lib/board-detail.ts';
import { type BoardAnswer, boardDone } from '../../../lib/board-done.ts';
import type { RunningOnMachine } from '../../../lib/board-model.ts';
import { moveChoices, planMove } from '../../../lib/board-move.ts';
import type { FerretNames } from '../../../lib/board-present.ts';
import type { DaemonBoardStore } from '../../../lib/board-store.ts';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { daemonBoardPath, daemonSessionPath } from '../../../lib/pages/routes.ts';
import { AnswerIcon, BoardDoneAction } from '../board-done-action.tsx';
import { BoardIcon } from '../board-icons.tsx';
import { BoardReasonBox } from '../board-reason-box.tsx';
import { BoardSendBack, type SendBack, type SendBackPorts, useSendBackFiles } from '../board-send-back.tsx';
import {
  AskSection,
  AsksList,
  Avatar,
  type ChildLine,
  ChildrenList,
  DependsLine,
  DetailSection,
  HistorySection,
  LinksSection,
  Prose,
  prIconName,
  TermsTable,
} from './board-detail-sections.tsx';

export type BoardAgenda = Pick<DaemonAgendaClient, 'hydrate' | 'respond' | 'store'>;

/** What the detail needs from outside the Board: a way to speak to a ferret. */
export interface BoardDetailPorts extends SendBackPorts {
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

type MenuName = 'lane' | 'more';

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
  // The answer whose move is in flight (it spins; every answer waits), and why the last one did not go through.
  const [pressed, setPressed] = useState<BoardAnswer | null>(null);
  const [answerProblem, setAnswerProblem] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuName | null>(null);
  const [adding, setAdding] = useState(false);
  const [reparenting, setReparenting] = useState(false);
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
  const movable = laneSet !== null && category !== 'closed' && task.dropped === null;
  const firstPr = task.links.prs[0] ?? null;

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

  /**
   * One of the owner's answers (Done, Works, Not good, a move): the pressed control spins and every answer is
   * disabled until the daemon answers.
   */
  const settle = async (
    answer: BoardAnswer,
    work: () => Promise<{ readonly ok: boolean; readonly error?: { readonly message: string } }>,
  ): Promise<boolean> => {
    if (busy) return false;
    setPressed(answer);
    setAnswerProblem(null);
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const result = await work();
    setBusy(false);
    setPressed(null);
    if (result.ok) {
      setDialog(null);
      return true;
    }
    const message = result.error?.message ?? 'That did not go through.';
    // An answer's refusal is said beside the answers; a lane pick's beside the comment box, and a composer's in it.
    if (dialog === null && answer !== 'move') setAnswerProblem(message);
    else setProblem(message);
    return false;
  };

  const requestMove = (to: string, answer: BoardAnswer = 'move'): void => {
    setMenu(null);
    setNotice(null);
    const plan = planMove(laneSet, task.laneId, to);
    if (plan.kind === 'refused') setNotice(plan.message);
    else if (plan.kind === 'ask-reason') {
      setProblem(null);
      setDialog({
        kind: answer === 'not-good' ? 'rework' : 'move',
        to: plan.to,
        toName: laneNameOf(laneSet, plan.to),
      });
    } else if (plan.kind === 'send') void settle(answer, () => actions.moveTask(moveTarget, plan.to));
  };
  const sendBackFiles = useSendBackFiles(
    ports,
    machine.connection,
    dialog?.kind === 'move' || dialog?.kind === 'rework' ? recipient : null,
  );

  const copyLink = (): void => {
    setMenu(null);
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

  const submitReason = (reason: string): void => {
    if (dialog === null) return;
    if (dialog.kind === 'drop') void run(() => actions.drop(target, reason));
    else if (dialog.kind === 'undepend') void run(() => actions.undepend(target, dialog.ref, reason));
  };
  const submitSendBack = ({ reason, attachmentIds }: SendBack): void => {
    if (dialog?.kind !== 'move' && dialog?.kind !== 'rework') return;
    const files =
      attachmentIds.length === 0 || sendBackFiles === null
        ? undefined
        : { from: sendBackFiles.sessionId, ids: [...attachmentIds] };
    void settle(dialog.kind === 'rework' ? 'not-good' : 'move', () =>
      actions.moveTask(moveTarget, dialog.to, reason, files),
    );
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
            : {
                placeholder: 'Why is it going back? The ferret reads this.',
                submitLabel: 'Move back',
                busyLabel: 'Moving…',
              };

  const laneMenu = (
    <div aria-label="Move to…" className="fy-board-menu fy-board-detail__lanemenu" id={menuId} role="menu">
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
  );

  return (
    <>
      <div className="fy-board-detail__content">
        <header className="fy-board-detail__head" data-section="header">
          <div className="fy-board-detail__headline">
            <h2 className="fy-board-detail__title">
              <span className="fy-board-detail__id">{formatTaskRef({ id: task.id })}</span> {task.title}
            </h2>
            <div className="fy-board-detail__tools">
              {done === null ? null : (
                <BoardDoneAction
                  disabled={busy}
                  done={done}
                  onPress={() => requestMove(done.laneId, done.kind)}
                  pending={pressed === done.kind}
                  size="primary"
                  title={task.title}
                />
              )}
              <button
                className="kt-btn"
                data-variant="ghost"
                onClick={() => onNavigate(daemonSessionPath(machine.connection.daemonId, recipient))}
                type="button"
              >
                <MessageSquare aria-hidden="true" size={12} /> Open chat
              </button>
              <div className="fy-board-detail__menu">
                <button
                  aria-controls={menu === 'more' ? menuId : undefined}
                  aria-expanded={menu === 'more'}
                  aria-haspopup="menu"
                  aria-label="More actions"
                  className="kt-btn"
                  data-variant="ghost"
                  onClick={() => setMenu(value => (value === 'more' ? null : 'more'))}
                  type="button"
                >
                  <Ellipsis aria-hidden="true" size={14} />
                </button>
                {menu === 'more' ? (
                  <div aria-label="More actions" className="fy-board-menu" id={menuId} role="menu">
                    {movable ? (
                      <button
                        className="fy-board-menu__item"
                        onClick={() => setMenu('lane')}
                        role="menuitem"
                        type="button"
                      >
                        Move to…
                      </button>
                    ) : null}
                    <button
                      className="fy-board-menu__item"
                      onClick={() => {
                        setMenu(null);
                        setReparenting(true);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      Reparent…
                    </button>
                    {task.dropped === null ? (
                      <button
                        className="fy-board-menu__item"
                        onClick={() => {
                          setMenu(null);
                          setProblem(null);
                          setDialog({ kind: 'drop' });
                        }}
                        role="menuitem"
                        type="button"
                      >
                        Drop…
                      </button>
                    ) : null}
                    <button className="fy-board-menu__item" onClick={copyLink} role="menuitem" type="button">
                      Copy link
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <div className="fy-board-detail__meta">
            <span className="fy-board-detail__lane">
              {movable ? (
                <>
                  <button
                    aria-controls={menu === 'lane' ? menuId : undefined}
                    aria-expanded={menu === 'lane'}
                    aria-haspopup="menu"
                    aria-label={`Lane: ${laneNameOf(laneSet, task.laneId)}. Move to…`}
                    className="fy-board-detail__pill"
                    data-pill="lane"
                    onClick={() => setMenu(value => (value === 'lane' ? null : 'lane'))}
                    type="button"
                  >
                    {laneNameOf(laneSet, task.laneId)} <ChevronDown aria-hidden="true" size={12} />
                  </button>
                  {menu === 'lane' ? laneMenu : null}
                </>
              ) : (
                <span className="fy-board-detail__pill" data-pill="lane" data-static="">
                  {laneNameOf(laneSet, task.laneId)}
                </span>
              )}
            </span>
            {firstPr === null ? null : (
              <a
                className="fy-board-detail__metalink"
                data-meta="pr"
                href={firstPr.url}
                rel="noreferrer"
                target="_blank"
              >
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
            </span>
            <span className="fy-board-detail__faint">
              {kindLabel(task.kind)} · {projectName(task.projectId)}
            </span>
          </div>
          {task.dropped === null ? null : (
            <p className="fy-board-detail__quiet" data-state="dropped">
              Dropped: {task.dropped.reason}
            </p>
          )}
        </header>

        {verdict === null || task.dropped !== null ? null : (
          <fieldset aria-label="Your verdict" className="fy-board-detail__verdict">
            {verdict.closeLaneId === null ? null : (
              <button
                aria-busy={pressed === 'works'}
                className="kt-btn"
                data-pending={pressed === 'works' ? '' : undefined}
                data-variant="primary"
                data-verdict="works"
                disabled={busy}
                title="Works → Close"
                onClick={() => requestMove(verdict.closeLaneId as string, 'works')}
                type="button"
              >
                <AnswerIcon icon={Check} pending={pressed === 'works'} size={14} />
                Close
              </button>
            )}
            {verdict.reworkLaneId === null ? null : (
              <button
                aria-busy={pressed === 'not-good'}
                className="kt-btn"
                data-pending={pressed === 'not-good' ? '' : undefined}
                data-variant="ghost"
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
                <AnswerIcon icon={X} pending={pressed === 'not-good'} size={14} />
                Not good
              </button>
            )}
          </fieldset>
        )}
        {answerProblem === null ? null : (
          <p className="fy-board-reason__error fy-board-detail__answer-error" data-answer-error="" role="alert">
            {answerProblem}
          </p>
        )}

        {reparenting ? (
          <ReparentForm
            busy={busy}
            onCancel={() => setReparenting(false)}
            onSubmit={async parent => {
              const done = await run(() => actions.reparent(target, parent));
              if (done) {
                setReparenting(false);
                setNotice(parent === null ? 'Now a top-level card.' : `Moved under ${formatTaskRef(parent)}.`);
              }
              return done;
            }}
            problem={dialog === null ? problem : null}
          />
        ) : null}

        <DetailSection id="summary" title="Summary">
          <Prose empty="No summary yet." text={task.summary} />
        </DetailSection>

        <DetailSection id="ask" title="Ask">
          <AskSection
            names={names}
            now={now}
            onOpenSession={sessionId => onNavigate(daemonSessionPath(machine.connection.daemonId, sessionId))}
            task={task}
          />
        </DetailSection>

        {written(task.premise) ? (
          <DetailSection id="premise" title="Premise">
            <Prose empty="" text={task.premise} />
          </DetailSection>
        ) : null}
        {written(task.context) ? (
          <DetailSection id="context" title="Context">
            <Prose empty="" text={task.context} />
          </DetailSection>
        ) : null}
        {task.terms.length === 0 ? null : (
          <DetailSection count={task.terms.length} id="terms" title="Terms">
            <TermsTable terms={task.terms} />
          </DetailSection>
        )}
        {written(task.brief) ? (
          <DetailSection id="brief" title="Brief">
            <Prose empty="" text={task.brief} />
          </DetailSection>
        ) : null}

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
          <DependsLine
            adding={adding}
            form={
              <DependForm
                busy={busy}
                onAdd={(ref, until) => run(() => actions.depend(target, { task: ref, until }))}
                problem={dialog === null ? problem : null}
              />
            }
            onOpen={open}
            onToggleAdd={() => setAdding(value => !value)}
            onUndepend={ref => {
              setProblem(null);
              setDialog({ kind: 'undepend', ref });
            }}
            task={task}
          />
        </DetailSection>

        {task.waitingOnOwner.length + asks.open.length + asks.resolved.length === 0 ? null : (
          <DetailSection count={asks.open.length + asks.resolved.length} id="asks" title="Agenda asks">
            <AsksList
              asks={asks}
              names={names}
              onOpen={(sessionId, id) =>
                onNavigate(agendaConversationPath(machine.connection.daemonId, sessionId, id as AgendaId))
              }
            />
          </DetailSection>
        )}

        <DetailSection id="history" title="History">
          <HistorySection context={historyContext} now={now} task={task} />
        </DetailSection>
      </div>

      <footer className="fy-board-detail__foot">
        {problem === null || dialog !== null || adding || reparenting ? null : (
          <p className="fy-board-reason__error" data-problem="" role="alert">
            {problem}
          </p>
        )}
        {notice === null ? null : (
          <p className="fy-board-detail__notice" role="status">
            {notice}
          </p>
        )}
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
      </footer>

      {dialog?.kind === 'move' || dialog?.kind === 'rework' ? (
        <div className="fy-board__scrim">
          <BoardSendBack
            busy={busy}
            error={problem}
            files={sendBackFiles}
            heading={dialogHeading}
            onCancel={() => {
              setDialog(null);
              setProblem(null);
            }}
            onSubmit={submitSendBack}
            {...dialogWords}
          />
        </div>
      ) : dialog === null ? null : (
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
    </>
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

/** "Reparent…": the card it goes under, or nothing to make it a top-level card. */
function ReparentForm({
  busy,
  problem,
  onSubmit,
  onCancel,
}: {
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onSubmit: (parent: TaskRef | null) => Promise<boolean>;
  readonly onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const ref = parseTaskRef(text);
    if (!ref.ok && ref.error.code !== 'empty') {
      setError(`${text.trim()} is not a card id.`);
      return;
    }
    setError(null);
    void onSubmit(ref.ok ? ref.value : null);
  };
  return (
    <form className="fy-board-detail__form" data-form="reparent" onSubmit={submit}>
      <input
        aria-label="Parent card"
        className="fy-board-reason__input"
        onChange={event => setText(event.target.value)}
        placeholder="Move under… &F412 (empty: top level)"
        type="text"
        value={text}
      />
      <button className="kt-btn" data-variant="ghost" disabled={busy} type="submit">
        Reparent
      </button>
      <button className="kt-btn" data-variant="ghost" onClick={onCancel} type="button">
        Cancel
      </button>
      {(error ?? problem) ? (
        <p className="fy-board-reason__error" role="alert">
          {error ?? problem}
        </p>
      ) : null}
    </form>
  );
}

/** The comment box, in the chat composer's shape: Enter sends, Shift+Enter is a new line. */
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
  const send = (): void => {
    if (text.trim() === '') return;
    void onSend(text).then(failed => {
      setError(failed);
      if (failed === null) setText('');
    });
  };
  return (
    <form
      className="fy-board-detail__composer"
      data-form="comment"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        send();
      }}
    >
      <textarea
        aria-label={`Comment to ${name}`}
        className="fy-board-detail__composer-input"
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          send();
        }}
        placeholder={`Comment to ${name}…`}
        rows={1}
        value={text}
      />
      <button className="kt-btn" data-variant="primary" disabled={busy || text.trim() === ''} type="submit">
        Send
      </button>
      {error === null ? null : (
        <p className="fy-board-reason__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
