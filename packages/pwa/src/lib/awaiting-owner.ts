/**
 * WHICH CARDS ARE WAITING ON THE OWNER'S ANSWER: the one rule the Inbox and the task side panel's Cards view share.
 *
 * A card needs the owner only while it sits in a GATE lane — a lane only the owner moves on from: a verify lane ("Try
 * it": Done / Not good) or an owner-gated active lane ("OK to build?": the plan or design to approve) — and only when a
 * person asked for it. A card in any other lane (todo, in progress, review, merged, closed), a dropped card, and a card
 * a ferret made for another ferret never wait on the owner, however long they have been quiet: they live on the Kanban
 * and the List, and nowhere that asks for an answer.
 */

import type { Lane, LaneSet } from '@ferretry/protocol';
import { askedByPerson } from './board-human.ts';
import type { BoardCardOf } from './board-view.ts';

/** A lane only the owner moves a card on from: a verify lane, or any owner-gated lane that is not the closing one. */
export const isGateLane = (lane: Pick<Lane, 'category' | 'ownerGate'>): boolean =>
  lane.category === 'verify' || (lane.ownerGate === true && lane.category !== 'closed');

/** What the owner is asked: to try the work, or to approve a plan before the building starts. */
export type GateStage = 'try' | 'approve';

/** The gate the card sits in, or `null` when its lane is not a gate (or the project's lanes are not known). */
const gateStageOf = (
  task: Pick<BoardCardOf['task'], 'laneId'>,
  laneSet: Pick<LaneSet, 'lanes'> | null,
): GateStage | null => {
  const lane = laneSet?.lanes.find(candidate => candidate.id === task.laneId);
  if (lane === undefined || !isGateLane(lane)) return null;
  return lane.category === 'verify' ? 'try' : 'approve';
};

/** The gate this card is waiting in for the owner, or `null`: not in a gate lane, dropped, or not asked for by a person. */
export const awaitingOwner = (card: BoardCardOf, laneSet: Pick<LaneSet, 'lanes'> | null): GateStage | null =>
  card.task.dropped !== null || !askedByPerson(card.task) ? null : gateStageOf(card.task, laneSet);
