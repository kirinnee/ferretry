/**
 * WHERE AGENDA READS THE CARDS' HOOKS: the three app hooks this half offers (`contract/app-hooks.ts`), read from the
 * shell for this half's daemon and handed to the ask surfaces below, each through the seam that already reads it:
 *
 * - `agenda.card-answer` → {@link DoneCloseBoardProvider} (an item's Done · closes) and {@link AgendaCardsBoardProvider}
 *   (a notice's Start and Close);
 * - `agenda.lane-proposal` → the Inbox's lane editor (`AgendaInbox.laneEditor`: Edit on a lane proposal opens it);
 * - `agenda.card-reference` → the reference surface's `&` proof and opener, so `&F12` in an ask's words links to the
 *   card when, and only when, the card is this daemon's.
 *
 * A hook nobody provides, or a value without the shape, is no hook: the surfaces draw as they do without Board.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  AGENDA_CARD_ANSWER_HOOK,
  AGENDA_CARD_REFERENCE_HOOK,
  AGENDA_LANE_PROPOSAL_HOOK,
  type AgendaCardAnswer,
  type AgendaCardReference,
  type AgendaLaneEditor,
  type AgendaLaneProposal,
  isAgendaCardAnswer,
  isAgendaCardReference,
  isAgendaLaneProposal,
} from '../../../contract/app-hooks.ts';
import { type DoneCloseBoard, DoneCloseBoardProvider } from '../../hooks/use-done-close.ts';
import { type AgendaCardsBoard, boardErr, boardOk } from '../../lib/agenda-cards-actions.ts';
import type { DaemonId } from '../../lib/machine.ts';
import { ReferenceSurfaceProvider, useAppHook, useReferenceSurface } from '../../shell.ts';
import { AgendaCardsBoardProvider } from './agenda-cards-host.tsx';

/** The provided hooks of one daemon, narrowed: each `undefined` when nobody provides it. */
export interface AgendaBoardHooks {
  readonly daemonId: DaemonId;
  readonly cardAnswer: AgendaCardAnswer | undefined;
  readonly laneProposal: AgendaLaneProposal | undefined;
  readonly cardReference: AgendaCardReference | undefined;
}

/** The values the shell handed, kept only where they have the shape Agenda reads. */
export const agendaBoardHooks = (
  daemonId: DaemonId,
  provided: { readonly cardAnswer: unknown; readonly laneProposal: unknown; readonly cardReference: unknown },
): AgendaBoardHooks => ({
  daemonId,
  cardAnswer: isAgendaCardAnswer(provided.cardAnswer) ? provided.cardAnswer : undefined,
  laneProposal: isAgendaLaneProposal(provided.laneProposal) ? provided.laneProposal : undefined,
  cardReference: isAgendaCardReference(provided.cardReference) ? provided.cardReference : undefined,
});

/** The three hooks as the shell provides them for `daemonId`. */
export const useAgendaBoardHooks = (daemonId: DaemonId): AgendaBoardHooks => {
  const cardAnswer = useAppHook(daemonId, AGENDA_CARD_ANSWER_HOOK);
  const laneProposal = useAppHook(daemonId, AGENDA_LANE_PROPOSAL_HOOK);
  const cardReference = useAppHook(daemonId, AGENDA_CARD_REFERENCE_HOOK);
  return useMemo(
    () => agendaBoardHooks(daemonId, { cardAnswer, laneProposal, cardReference }),
    [daemonId, cardAnswer, laneProposal, cardReference],
  );
};

/** The lane editor the Inbox opens on Edit, or `undefined` without a provider. */
export const laneEditorOf = (hooks: AgendaBoardHooks): AgendaLaneEditor | undefined => hooks.laneProposal?.editorFor;

const ELSEWHERE = 'That card is on another machine, so it cannot be changed from here.';

/** A notice's Start and Close, over the provided hook; a card of another daemon is refused, never sent. */
const agendaCardsBoardOf = (answer: AgendaCardAnswer, daemonId: DaemonId): AgendaCardsBoard => ({
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
function CardReferences({
  reference,
  onNavigate,
  children,
}: {
  readonly reference: AgendaCardReference | undefined;
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

/** Hands the ask surfaces below the provided Done · closes board, the notices' card board and the `&` proof. */
export function AgendaBoardProviders({
  hooks,
  onNavigate,
  children,
}: {
  readonly hooks: AgendaBoardHooks;
  readonly onNavigate: (to: string) => void;
  readonly children: ReactNode;
}) {
  const { daemonId, cardAnswer } = hooks;
  const doneClose = useMemo(
    (): DoneCloseBoard | undefined => (cardAnswer === undefined ? undefined : { ...pickDone(cardAnswer), daemonId }),
    [cardAnswer, daemonId],
  );
  const cards = useMemo(
    () => (cardAnswer === undefined ? undefined : agendaCardsBoardOf(cardAnswer, daemonId)),
    [cardAnswer, daemonId],
  );
  const drawn = (
    <DoneCloseBoardProvider board={doneClose}>
      <CardReferences onNavigate={onNavigate} reference={hooks.cardReference}>
        {children}
      </CardReferences>
    </DoneCloseBoardProvider>
  );
  return cards === undefined ? drawn : <AgendaCardsBoardProvider board={cards}>{drawn}</AgendaCardsBoardProvider>;
}

const pickDone = ({ subscribe, watch, card, done }: AgendaCardAnswer): Omit<DoneCloseBoard, 'daemonId'> => ({
  subscribe,
  watch,
  card,
  done,
});
