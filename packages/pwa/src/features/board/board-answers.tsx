/**
 * THE OWNER'S ANSWERS, AS ONE FLOW: Done, Not good and Send back. Only the agenda's cards to try use it: the Board
 * and its cards are read-only (no ⋯ pick, no drop, no Done, Not good or Reopen button), the owner answers in the agenda.
 *
 * - A move forward is sent at once. A move BACK opens the send-back composer (the words, and pictures where the
 *   machine takes them) and is sent only with its words.
 * - While a card's move is in flight the pressed control spins (`answerFor`), every answer on that card waits,
 *   and a second press is not a second move.
 * - A refusal is said on the card it belongs to, and kept in the composer when one is open.
 */

import type { BoardReopenAttachments } from '@ferretry/protocol';
import { type ReactNode, useCallback, useState } from 'react';
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
  /** Says (or clears) why a move could not even be planned: the project has no lanes, or not that one. */
  readonly onNotice: (message: string | null) => void;
}

export interface BoardAnswers {
  /** One answer on one card; `answer` names the control that asked, which words the composer and spins. */
  readonly requestMove: (card: BoardCardOf, group: BoardGroupOf, laneId: string, answer?: BoardAnswer) => void;
  readonly answerFor: (card: BoardCardOf) => BoardAnswerState;
  /**
   * The composer under this card while its move back waits for words, as wide as the card (no sheet, no popup);
   * `null` for any other card.
   */
  readonly composerFor: (card: BoardCardOf) => ReactNode;
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
    case 'send-back':
      return {
        heading: `Send ${title} back to ${pending.toName}`,
        placeholder: 'What should change?',
        submitLabel: 'Send back',
      };
    default:
      return {
        heading: `Move ${title} back to ${pending.toName}`,
        placeholder: 'Why is it going back?',
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

export function useBoardAnswers({ actions, ports, connectionOf, onNotice }: BoardAnswersInput): BoardAnswers {
  const [pending, setPending] = useState<PendingMove | null>(null);
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
        if (connectionOf(card.daemonId) === undefined) {
          onNotice('That machine is not connected here, so the card cannot be sent back from this page.');
          return;
        }
        const toName = group.laneSet?.lanes.find(lane => lane.id === plan.to)?.name ?? plan.to;
        setPending({ card, group, to: plan.to, toName, answer });
        return;
      }
      if (plan.kind === 'send') void send(card, group, plan.to, answer);
    },
    [send, settling, onNotice, connectionOf],
  );

  // The composer's files go to the card's ferret: its assignee, else its owner ferret (where the daemon looks).
  const files = useSendBackFiles(
    ports,
    pending === null ? undefined : connectionOf(pending.card.daemonId),
    pending === null ? null : (pending.card.task.assignee ?? pending.card.task.owner),
  );

  const submit = async ({ reason, attachmentIds }: SendBack): Promise<string | null> => {
    if (pending === null) return null;
    const attachments =
      attachmentIds.length === 0 || files === null ? undefined : { from: files.sessionId, ids: [...attachmentIds] };
    const refused = await send(pending.card, pending.group, pending.to, pending.answer, reason, attachments);
    if (refused === null) setPending(null);
    return refused;
  };

  const answerFor = useCallback(
    (card: BoardCardOf): BoardAnswerState => {
      const pressed = settling.get(card.key) ?? null;
      const error = refusals.get(card.key) ?? null;
      return pressed === null && error === null ? ANSWER_AT_REST : { pressed, error };
    },
    [settling, refusals],
  );

  const daemon = pending === null ? undefined : connectionOf(pending.card.daemonId);
  const box =
    pending === null || daemon === undefined ? null : (
      <BoardSendBack
        busy={settling.has(pending.card.key)}
        error={null}
        files={files}
        key={pending.card.key}
        onCancel={() => setPending(null)}
        onSubmit={submit}
        target={{
          daemon,
          sessionId: files?.sessionId ?? pending.card.task.assignee ?? pending.card.task.owner ?? pending.card.task.id,
        }}
        {...sendBackWords(pending)}
      />
    );
  const composerFor = (card: BoardCardOf): ReactNode =>
    pending !== null && pending.card.key === card.key ? box : null;

  return { requestMove, answerFor, composerFor };
}
