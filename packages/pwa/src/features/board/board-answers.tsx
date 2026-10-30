/**
 * THE OWNER'S ANSWERS ON A CARD, AS ONE FLOW: Done, Close, Not good, Reopen, a ⋯ pick and a drop. The Board page
 * and the ferret's own Tasks tab both use it, so a card behaves the same wherever the owner answers it.
 *
 * - A move forward is sent at once. A move BACK opens the send-back composer (the words, and pictures where the
 *   machine takes them) and is sent only with its words.
 * - While a card's move is in flight the pressed control spins (`answerFor`), every answer on that card waits,
 *   and a second press or a drop is not a second move.
 * - A refusal is said on the card it belongs to, and kept in the composer when one is open.
 */

import type { BoardReopenAttachments } from '@ferretry/protocol';
import { type ReactNode, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BoardActions } from '../../lib/board-actions.ts';
import { ANSWER_AT_REST, type BoardAnswer, type BoardAnswerState } from '../../lib/board-done.ts';
import { planMove } from '../../lib/board-move.ts';
import type { BoardCardOf, BoardGroupOf } from '../../lib/board-view.ts';
import type { DaemonConnection, DaemonId } from '../../lib/daemon-connection.ts';
import { BoardSendBack, type SendBack, type SendBackPorts, useSendBackFiles } from './board-send-back.tsx';

export interface BoardAnswersInput {
  readonly actions: Pick<BoardActions, 'moveTask'>;
  /** How pictures reach the card's ferret; absent, the composer takes words alone. */
  readonly ports: SendBackPorts | undefined;
  /** The pairing of the machine a card is on. */
  readonly connectionOf: (daemonId: DaemonId) => DaemonConnection | undefined;
  /** A phone: the composer slides up from the bottom. */
  readonly phone: boolean;
  /** Says (or clears) why a move could not even be planned: the project has no lanes, or not that one. */
  readonly onNotice: (message: string | null) => void;
  /** Draw the composer over the whole page (a chat's side pane would clip it), rather than in place. */
  readonly portal?: boolean;
}

export interface BoardAnswers {
  /** One answer on one card; `answer` names the control that asked, which words the composer and spins. */
  readonly requestMove: (card: BoardCardOf, group: BoardGroupOf, laneId: string, answer?: BoardAnswer) => void;
  readonly answerFor: (card: BoardCardOf) => BoardAnswerState;
  /** The send-back composer while a move back waits for its words; `null` otherwise. */
  readonly composer: ReactNode;
}

interface PendingMove {
  readonly card: BoardCardOf;
  readonly group: BoardGroupOf;
  readonly to: string;
  readonly toName: string;
  readonly answer: BoardAnswer;
}

/** How the composer reads for the control that opened it. */
const sendBackWords = (pending: PendingMove) => {
  const title = pending.card.task.title;
  switch (pending.answer) {
    case 'not-good':
      return { heading: `Not good: send ${title} back to ${pending.toName}`, submitLabel: 'Send back' };
    case 'reopen':
      return {
        heading: `Reopen ${title}: back to ${pending.toName}`,
        placeholder: 'Why is it going back? The ferret reads this.',
        submitLabel: 'Reopen',
        busyLabel: 'Reopening…',
      };
    default:
      return {
        heading: `Move ${title} back to ${pending.toName}`,
        placeholder: 'Why is it going back? The ferret reads this.',
        submitLabel: 'Move back',
        busyLabel: 'Moving…',
      };
  }
};

const without = <Value,>(map: ReadonlyMap<string, Value>, key: string): ReadonlyMap<string, Value> => {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
};

export function useBoardAnswers({
  actions,
  ports,
  connectionOf,
  phone,
  onNotice,
  portal = false,
}: BoardAnswersInput): BoardAnswers {
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Per card: the answer in flight, and the last refusal. Several cards can be settling at once.
  const [settling, setSettling] = useState<ReadonlyMap<string, BoardAnswer>>(() => new Map());
  const [refusals, setRefusals] = useState<ReadonlyMap<string, string>>(() => new Map());

  const send = useCallback(
    async (
      card: BoardCardOf,
      group: BoardGroupOf,
      to: string,
      answer: BoardAnswer,
      reason?: string,
      attachments?: BoardReopenAttachments,
    ): Promise<string | null> => {
      setSettling(current => new Map(current).set(card.key, answer));
      setRefusals(current => without(current, card.key));
      const result = await actions.moveTask(
        { daemonId: card.daemonId, id: card.task.id, laneId: card.task.laneId, laneSet: group.laneSet },
        to,
        reason,
        attachments,
      );
      setSettling(current => without(current, card.key));
      if (result.ok) return null;
      setRefusals(current => new Map(current).set(card.key, result.error.message));
      return result.error.message;
    },
    [actions],
  );

  const requestMove = useCallback(
    (card: BoardCardOf, group: BoardGroupOf, laneId: string, answer: BoardAnswer = 'move'): void => {
      // One answer at a time per card: a second press while the first is in flight is not a second move.
      if (settling.has(card.key)) return;
      const plan = planMove(group.laneSet, card.task.laneId, laneId);
      onNotice(null);
      if (plan.kind === 'refused') {
        onNotice(plan.message);
        return;
      }
      if (plan.kind === 'ask-reason') {
        const toName = group.laneSet?.lanes.find(lane => lane.id === plan.to)?.name ?? plan.to;
        setProblem(null);
        setPending({ card, group, to: plan.to, toName, answer });
        return;
      }
      if (plan.kind === 'send') void send(card, group, plan.to, answer);
    },
    [send, settling, onNotice],
  );

  // The composer's files go to the card's ferret: its assignee, else its owner ferret (where the daemon looks).
  const files = useSendBackFiles(
    ports,
    pending === null ? undefined : connectionOf(pending.card.daemonId),
    pending === null ? null : (pending.card.task.assignee ?? pending.card.task.owner),
  );

  const submit = async ({ reason, attachmentIds }: SendBack): Promise<void> => {
    if (pending === null) return;
    setProblem(null);
    const attachments =
      attachmentIds.length === 0 || files === null ? undefined : { from: files.sessionId, ids: [...attachmentIds] };
    const refused = await send(pending.card, pending.group, pending.to, pending.answer, reason, attachments);
    if (refused === null) setPending(null);
    else setProblem(refused);
  };

  const answerFor = useCallback(
    (card: BoardCardOf): BoardAnswerState => {
      const pressed = settling.get(card.key) ?? null;
      const error = refusals.get(card.key) ?? null;
      return pressed === null && error === null ? ANSWER_AT_REST : { pressed, error };
    },
    [settling, refusals],
  );

  const drawn =
    pending === null ? null : (
      <div className="fy-board__scrim" data-phone={phone ? '' : undefined}>
        <BoardSendBack
          busy={settling.has(pending.card.key)}
          error={problem}
          files={files}
          key={pending.card.key}
          onCancel={() => {
            setPending(null);
            setProblem(null);
          }}
          onSubmit={sendBack => void submit(sendBack)}
          {...sendBackWords(pending)}
        />
      </div>
    );

  return {
    requestMove,
    answerFor,
    composer: drawn === null || !portal ? drawn : createPortal(drawn, document.body),
  };
}
