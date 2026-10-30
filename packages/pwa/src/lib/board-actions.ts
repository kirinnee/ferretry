/**
 * THE BOARD'S WRITES, as one small set of verbs a page calls: move, reopen, depend, note, link, drop, edit,
 * and answer an agenda ask.
 *
 * EVERY VERB NAMES A CARD BY `(daemonId, taskId)`. A card lives on one machine, so a verb is sent to that
 * machine's daemon and no other; there is no "the card named F12" across the fleet.
 *
 * A REFUSAL IS A VALUE. Each verb answers `BoardResult` with {@link BoardMutationError}; nothing throws
 * for an expected refusal (needs a reason, owner only, a dependency cycle). The two the PWA can know
 * without asking — a move back with no reason, a move on a project with no lanes — are refused HERE,
 * before the round trip, with the protocol's own rule (`moveReasonProblem`); the daemon asks again and its
 * answer stands.
 *
 * THE ANSWER TO AN ASK is not a board action: asks live in the agenda, so it goes through the agenda
 * client (`respond`) that every other answer uses, to the ferret's own session.
 */

import {
  type AgendaRef,
  type AgendaResponse,
  type BoardErrorCode,
  type BoardResult,
  type BoardTaskActionRequestInput,
  type BoardTaskId,
  type BoardTaskView,
  boardErr,
  boardOk,
  type LaneSet,
  type TaskMessage,
} from '@ferretry/protocol';
import type { DaemonAgendaClient } from './agenda-client.ts';
import { checkMove } from './board-model.ts';
import type { DaemonBoardStore } from './board-store.ts';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';
import { daemonSessionScope } from './daemon-scope.ts';

/** Why a verb was not applied: the daemon's refusal, or one the PWA knew before asking. */
interface BoardMutationError {
  /** HTTP status; `0` when the verb never left the browser. */
  readonly status: number;
  readonly message: string;
  /** The daemon's code, or the local one: `no-lane-set` (project has no lanes) or `no-machine` (unpaired). */
  readonly boardCode: BoardErrorCode | 'no-machine' | null;
}

type BoardMutation = BoardResult<BoardTaskView, BoardMutationError>;

/** A card, named by its machine and id, with what a move needs to be checked: its lane and its lane set. */
interface BoardCardTarget {
  readonly daemonId: DaemonId;
  readonly id: BoardTaskId;
}

export interface BoardMoveTarget extends BoardCardTarget {
  readonly laneId: string;
  readonly laneSet: Pick<LaneSet, 'lanes' | 'variants'> | null;
}

type Action<Name extends BoardTaskActionRequestInput['action']> = Extract<
  BoardTaskActionRequestInput,
  { readonly action: Name }
>;

type BoardDependency = Pick<Action<'depend'>, 'task' | 'until'> & { readonly overrideReason?: string };
type BoardLinkTarget = Omit<Action<'link'>, 'action'>;
type BoardEdit = Omit<Action<'edit'>, 'action'>;

export interface BoardActions {
  /** Moves a card. A move back needs `reason` (refused here without a round trip when it is missing). */
  moveTask(target: BoardMoveTarget, to: string, reason?: string): Promise<BoardMutation>;
  /** Reopens a closed card into a lane, with the owner's reason and the ask as said. */
  reopen(target: BoardCardTarget, to: string, reason: string, ask: TaskMessage): Promise<BoardMutation>;
  depend(target: BoardCardTarget, dependency: BoardDependency): Promise<BoardMutation>;
  note(target: BoardCardTarget, text: string): Promise<BoardMutation>;
  link(target: BoardCardTarget, link: BoardLinkTarget): Promise<BoardMutation>;
  drop(target: BoardCardTarget, reason: string): Promise<BoardMutation>;
  editField(target: BoardCardTarget, edit: BoardEdit): Promise<BoardMutation>;
  /** Answers one of the card's open asks, in the ferret's own agenda. */
  answer(
    daemonId: DaemonId,
    ref: AgendaRef,
    response: AgendaResponse,
    note?: string,
  ): Promise<BoardResult<undefined, BoardMutationError>>;
}

export interface BoardActionsDeps {
  readonly store: Pick<DaemonBoardStore, 'act'>;
  readonly agenda: Pick<DaemonAgendaClient, 'respond'>;
  /** The current pairing of a machine, or `undefined` once it is unpaired. */
  readonly connection: (daemonId: DaemonId) => DaemonConnection | undefined;
}

const unpaired = (daemonId: DaemonId): BoardMutationError => ({
  status: 0,
  message: `machine ${daemonId} is no longer paired`,
  boardCode: 'no-machine',
});

export const createBoardActions = (deps: BoardActionsDeps): BoardActions => {
  const send = async (target: BoardCardTarget, request: BoardTaskActionRequestInput): Promise<BoardMutation> => {
    const machine = deps.connection(target.daemonId);
    if (machine === undefined) return boardErr(unpaired(target.daemonId));
    return await deps.store.act(machine, target.id, request);
  };

  return {
    moveTask: async (target, to, reason) => {
      const checked = checkMove(target.laneSet, target.laneId, to, reason);
      if (!checked.ok) {
        const problem = checked.error;
        return boardErr({
          status: 0,
          message:
            problem.code === 'reason-required'
              ? 'Moving a card back needs a reason.'
              : problem.code === 'no-lane-set'
                ? 'This project has no confirmed lanes to move between.'
                : `Lane ${to} is not on this project's board.`,
          boardCode:
            problem.code === 'reason-required' || problem.code === 'no-lane-set' ? problem.code : 'unknown-lane',
        });
      }
      const trimmed = reason?.trim();
      return await send(target, {
        action: 'move',
        to,
        ...(trimmed === undefined || trimmed === '' ? {} : { reason: trimmed }),
      });
    },
    reopen: (target, to, reason, ask) => send(target, { action: 'reopen', to, reason, ask }),
    depend: (target, { task, until, overrideReason }) =>
      send(target, {
        action: 'depend',
        task,
        until,
        ...(overrideReason === undefined ? {} : { override: { reason: overrideReason } }),
      }),
    note: (target, text) => send(target, { action: 'note', text }),
    link: (target, link) => send(target, { action: 'link', ...link }),
    drop: (target, reason) => send(target, { action: 'drop', reason }),
    editField: (target, edit) => send(target, { action: 'edit', ...edit }),
    answer: async (daemonId, ref, response, note) => {
      const machine = deps.connection(daemonId);
      if (machine === undefined) return boardErr(unpaired(daemonId));
      try {
        await deps.agenda.respond(machine, daemonSessionScope(machine, ref.sessionId), ref.id, response, note);
        return boardOk(undefined);
      } catch (reason) {
        const status = (reason as { readonly status?: unknown } | null)?.status;
        return boardErr({
          status: typeof status === 'number' ? status : 0,
          message: reason instanceof Error ? reason.message : String(reason),
          boardCode: null,
        });
      }
    },
  };
};
