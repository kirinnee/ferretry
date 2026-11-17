/**
 * WHERE AGENDA READS THE CARDS' HOOKS: the three app hooks this half offers (`contract/app-hooks.ts`), read from the
 * shell for ONE daemon (a page's own, or an open Inbox card's machine: {@link AgendaCardBoard}) and handed to the ask
 * surfaces below, each through the seam that already reads it:
 *
 * - `agenda.card-answer` → {@link DoneCloseBoardProvider} (an item's Done · closes) and {@link AgendaCardsBoardProvider}
 *   (a notice's Start and Close);
 * - `agenda.lane-proposal` → the Inbox's lane editor (`AgendaInbox.laneEditor`: Edit on a lane proposal opens it);
 * - `agenda.card-reference` → the reference surface's `&` proof and opener, so `&F12` in an ask's words links to the
 *   card when, and only when, the card is this daemon's.
 *
 * A hook nobody provides, or a value without the shape, is no hook: the surfaces draw as they do without Board.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import type { InboxLaneEditor } from '../../hooks/use-agenda-inbox.ts';
import {
  AGENDA_TASK_ANSWER_HOOK,
  AGENDA_TASK_REFERENCE_HOOK,
  AGENDA_LANE_PROPOSAL_HOOK,
  type AgendaTaskAnswer,
  type AgendaTaskReference,
  type AgendaLaneEditor,
  type AgendaLaneProposal,
  isAgendaTaskAnswer,
  isAgendaTaskReference,
  isAgendaLaneProposal,
} from '../../../contract/app-hooks.ts';
import { type DoneCloseBoard, DoneCloseBoardProvider } from '../../hooks/use-done-close.ts';
import { type AgendaTasksBoard, boardErr, boardOk } from '../../lib/agenda-cards-actions.ts';
import { type AgendaReferenceFacts, agendaReferenceSurface } from '../../lib/agenda-references.ts';
import type { DaemonId } from '../../lib/machine.ts';
import { type ReferenceSurface, ReferenceSurfaceProvider, useAppHook, useReferenceSurface } from '../../shell.ts';
import { AgendaTasksBoardProvider } from './agenda-cards-host.tsx';

/** The provided hooks of one daemon, narrowed: each `undefined` when nobody provides it. */
export interface AgendaBoardHooks {
  readonly daemonId: DaemonId;
  readonly cardAnswer: AgendaTaskAnswer | undefined;
  readonly laneProposal: AgendaLaneProposal | undefined;
  readonly cardReference: AgendaTaskReference | undefined;
}

/** The values the shell handed, kept only where they have the shape Agenda reads. */
export const agendaBoardHooks = (
  daemonId: DaemonId,
  provided: { readonly cardAnswer: unknown; readonly laneProposal: unknown; readonly cardReference: unknown },
): AgendaBoardHooks => ({
  daemonId,
  cardAnswer: isAgendaTaskAnswer(provided.cardAnswer) ? provided.cardAnswer : undefined,
  laneProposal: isAgendaLaneProposal(provided.laneProposal) ? provided.laneProposal : undefined,
  cardReference: isAgendaTaskReference(provided.cardReference) ? provided.cardReference : undefined,
});

/** The three hooks as the shell provides them for `daemonId`. */
export const useAgendaBoardHooks = (daemonId: DaemonId): AgendaBoardHooks => {
  const cardAnswer = useAppHook(daemonId, AGENDA_TASK_ANSWER_HOOK);
  const laneProposal = useAppHook(daemonId, AGENDA_LANE_PROPOSAL_HOOK);
  const taskReference = useAppHook(daemonId, AGENDA_TASK_REFERENCE_HOOK);
  return useMemo(
    () => agendaBoardHooks(daemonId, { cardAnswer, laneProposal, cardReference: taskReference }),
    [daemonId, cardAnswer, laneProposal, taskReference],
  );
};

/** The lane editor the Inbox opens on Edit, or `undefined` without a provider. */
export const laneEditorOf = (hooks: AgendaBoardHooks): AgendaLaneEditor | undefined => hooks.laneProposal?.editorFor;

/** The lane editors of the machines whose cards are on screen, as each card's scope registered them. */
export interface LaneEditorBook {
  /** Registers `editor` for `daemonId` until the returned release; no editor registers nothing. */
  readonly register: (daemonId: DaemonId, editor: AgendaLaneEditor | undefined) => () => void;
  readonly editorFor: InboxLaneEditor;
}

export const laneEditorBook = (): LaneEditorBook => {
  // One entry per REGISTRATION, not per function: every scope of one machine registers the same cached `editorFor`, so a
  // release that matched by function would erase every card's editor on that machine at once.
  const held = new Map<DaemonId, { readonly editor: AgendaLaneEditor }[]>();
  return {
    register: (daemonId, editor) => {
      if (editor === undefined) return () => undefined;
      const registration = { editor };
      held.set(daemonId, [...(held.get(daemonId) ?? []), registration]);
      return () => {
        const rest = (held.get(daemonId) ?? []).filter(known => known !== registration);
        if (rest.length === 0) held.delete(daemonId);
        else held.set(daemonId, rest);
      };
    },
    editorFor: (daemonId, ask, answer) => held.get(daemonId)?.at(-1)?.editor(ask, answer),
  };
};

/**
 * One card's Board: the three hooks read for THE CARD'S machine (the Inbox is every machine's), handed to what is drawn
 * inside as {@link AgendaBoardProviders} does for a page's own, and the machine's lane editor entered in `editors` while
 * it is on screen. Each card of another machine gets that machine's Board, never the page's.
 */
export function AgendaTaskBoard({
  daemonId,
  editors,
  onNavigate,
  children,
}: {
  readonly daemonId: DaemonId;
  readonly editors: LaneEditorBook;
  readonly onNavigate: (to: string) => void;
  readonly children: ReactNode;
}) {
  const hooks = useAgendaBoardHooks(daemonId);
  const editor = laneEditorOf(hooks);
  useEffect(() => editors.register(daemonId, editor), [editors, daemonId, editor]);
  return (
    <AgendaBoardProviders hooks={hooks} onNavigate={onNavigate}>
      {children}
    </AgendaBoardProviders>
  );
}

/** What the Inbox screens hand the page: the per-machine lane editor and the per-card scope that feeds it. */
export const useTaskBoards = (
  onNavigate: (to: string) => void,
): {
  readonly laneEditor: InboxLaneEditor;
  readonly cardBoard: (daemonId: DaemonId, children: ReactNode) => ReactNode;
} => {
  const editors = useMemo(laneEditorBook, []);
  const taskBoard = useCallback(
    (daemonId: DaemonId, children: ReactNode): ReactNode => (
      <AgendaTaskBoard daemonId={daemonId} editors={editors} onNavigate={onNavigate}>
        {children}
      </AgendaTaskBoard>
    ),
    [editors, onNavigate],
  );
  return { laneEditor: editors.editorFor, cardBoard: taskBoard };
};

const ELSEWHERE = 'That task is on another machine, so it cannot be changed from here.';

/** A notice's Start and Close, over the provided hook; a card of another daemon is refused, never sent. */
const agendaTasksBoardOf = (answer: AgendaTaskAnswer, daemonId: DaemonId): AgendaTasksBoard => ({
  start: async (target, key) => {
    if (target.daemonId !== daemonId) return boardErr({ status: 0, message: ELSEWHERE });
    const started = await answer.start(target.id, key ?? crypto.randomUUID());
    return started.ok
      ? boardOk({ started: started.value.started, sessionId: started.value.ferret })
      : boardErr({ status: started.status, message: started.message });
  },
  drop: async (target, reason) => {
    if (target.daemonId !== daemonId) return boardErr({ status: 0, message: ELSEWHERE });
    const dropped = await answer.drop(target.id, reason);
    return dropped.ok ? boardOk(undefined) : boardErr({ status: dropped.status, message: dropped.message });
  },
});

const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

/**
 * The `&` proof and opener over the provided hook, on top of the surface this sits in: a surface that already proves
 * cards (a ferret's chat, which built its own) is left as it is.
 */
function TaskReferences({
  reference,
  onNavigate,
  children,
}: {
  readonly reference: AgendaTaskReference | undefined;
  readonly onNavigate: (to: string) => void;
  readonly children: ReactNode;
}) {
  const outer = useReferenceSurface();
  const own = outer.taskReferenceResolver === undefined ? reference : undefined;
  useEffect(() => own?.watch(), [own]);
  const read = useCallback(() => own?.proves(), [own]);
  const proves = useSyncExternalStore(own?.subscribe ?? NO_SUBSCRIPTION, read, read);
  const surface = useMemo(
    () =>
      own === undefined || proves === undefined
        ? outer
        : { ...outer, taskReferenceResolver: proves, onTaskOpen: (id: string) => onNavigate(own.href(id)) },
    [outer, own, proves, onNavigate],
  );
  if (surface === outer) return <>{children}</>;
  return <ReferenceSurfaceProvider surface={surface}>{children}</ReferenceSurfaceProvider>;
}

/**
 * What Agenda itself proves on top of the surface above it (`!A3`, `:agent`, `@file`): with no facts the surface is
 * left exactly as it was, so a reader outside a ferret's page or a machine proves none of them.
 */
function OwnReferences({
  facts,
  children,
}: {
  readonly facts: AgendaReferenceFacts | undefined;
  readonly children: ReactNode;
}) {
  const outer = useReferenceSurface();
  const surface = useMemo(() => (facts === undefined ? outer : agendaReferenceSurface(outer, facts)), [outer, facts]);
  if (facts === undefined) return <>{children}</>;
  return <ReferenceSurfaceProvider surface={surface}>{children}</ReferenceSurfaceProvider>;
}

/**
 * The daemon the reference proofs ABOVE this point were built for: the nearest {@link AgendaBoardProviders}'s, and
 * `undefined` outside every one (then nothing says whose proofs a surface carries).
 */
const ProofDaemonContext = createContext<DaemonId | undefined>(undefined);

/**
 * The proofs a surface cannot give a card of ANOTHER machine: the page's proofs (`:agent`, `&card`, `!ask`, `@file`) read
 * the page's own daemon, and a reference in one daemon's words can never open a same-named thing on another
 * (docs/reference-standard.md). So a card whose daemon is not the one the proofs were built for is drawn over a surface
 * with those proofs removed, and its references stay prose. It FAILS CLOSED: outside {@link AgendaBoardProviders}
 * nothing says whose proofs the surface carries, so they are removed too. Only a card of the daemon the proofs were
 * built for keeps the surface as it is.
 */
export function TaskReferenceScope({
  daemonId,
  children,
}: {
  readonly daemonId: DaemonId;
  readonly children: ReactNode;
}) {
  const proofs = useContext(ProofDaemonContext);
  const outer = useReferenceSurface();
  const surface = useMemo(() => withoutProofs(outer), [outer]);
  if (proofs === daemonId) return <>{children}</>;
  return <ReferenceSurfaceProvider surface={surface}>{children}</ReferenceSurfaceProvider>;
}

/**
 * Where a daemon's providers begin: proofs an OUTER {@link AgendaBoardProviders} built for ANOTHER daemon are removed
 * before this one adds its own, then the context names this daemon. Without it a machine B's card, drawn inside the
 * page's providers for machine A, would name B as the proofs' daemon while still carrying A's `:agent` and `&F12`.
 */
function ProofScope({ daemonId, children }: { readonly daemonId: DaemonId; readonly children: ReactNode }) {
  const inherited = useContext(ProofDaemonContext);
  const outer = useReferenceSurface();
  const stripped = useMemo(() => withoutProofs(outer), [outer]);
  const inner = <ProofDaemonContext.Provider value={daemonId}>{children}</ProofDaemonContext.Provider>;
  if (inherited === undefined || inherited === daemonId) return inner;
  return <ReferenceSurfaceProvider surface={stripped}>{inner}</ReferenceSurfaceProvider>;
}

/** `surface` without the proofs and openers that read one daemon's facts. */
const withoutProofs = (surface: ReferenceSurface): ReferenceSurface => {
  const {
    agentReferenceResolver: _agent,
    taskReferenceResolver: _task,
    onTaskOpen: _taskOpen,
    agendaReferenceResolver: _agenda,
    onAgendaOpen: _agendaOpen,
    resolveFilePaths: _files,
    onCodeReferenceOpen: _fileOpen,
    ...rest
  } = surface;
  return rest;
};

/** Hands the ask surfaces below the provided Done · closes board, the notices' card board and the `&` proof. */
export function AgendaBoardProviders({
  hooks,
  onNavigate,
  references,
  children,
}: {
  readonly hooks: AgendaBoardHooks;
  readonly onNavigate: (to: string) => void;
  /** The facts `!A3`, `:agent` and `@file` are proved from; none leaves those kinds as prose. */
  readonly references?: AgendaReferenceFacts;
  readonly children: ReactNode;
}) {
  const { daemonId, cardAnswer } = hooks;
  const doneClose = useMemo(
    (): DoneCloseBoard | undefined => (cardAnswer === undefined ? undefined : { ...pickDone(cardAnswer), daemonId }),
    [cardAnswer, daemonId],
  );
  const cards = useMemo(
    () => (cardAnswer === undefined ? undefined : agendaTasksBoardOf(cardAnswer, daemonId)),
    [cardAnswer, daemonId],
  );
  const drawn = (
    <DoneCloseBoardProvider board={doneClose}>
      <ProofScope daemonId={daemonId}>
        <TaskReferences onNavigate={onNavigate} reference={hooks.cardReference}>
          <OwnReferences facts={references}>{children}</OwnReferences>
        </TaskReferences>
      </ProofScope>
    </DoneCloseBoardProvider>
  );
  return cards === undefined ? drawn : <AgendaTasksBoardProvider board={cards}>{drawn}</AgendaTasksBoardProvider>;
}

const pickDone = ({ subscribe, watch, card, done }: AgendaTaskAnswer): Omit<DoneCloseBoard, 'daemonId'> => ({
  subscribe,
  watch,
  card,
  done,
});
