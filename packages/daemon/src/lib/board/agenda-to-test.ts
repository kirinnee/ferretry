/**
 * WHICH CARDS WAIT TO BE TRIED: the agenda reads this when an item is raised, to decide whether the owner's
 * one tap may also close the card. "To test" is the lane `release.published` enters (Released · to test) —
 * the same notion the board's own lane facts use, so there is no second list of lane names here.
 */
import { type BoardTask, laneForTrigger, type LaneSet, type TaskRef } from '@ferretry/protocol';

/** A card and the lane set its board uses, as the board reads it. */
export interface CardWithLanes {
  readonly task: BoardTask;
  readonly laneSet: LaneSet | null;
}

export class AgendaToTestLanes {
  constructor(
    private readonly card: (id: string) => Promise<CardWithLanes | undefined>,
    private readonly machineId: () => string | undefined,
  ) {}

  /** False for a card of another machine, one that is not on the board, and one in any other lane. */
  async inToTest(ref: TaskRef): Promise<boolean> {
    if (ref.machineId !== undefined && ref.machineId !== this.machineId()) return false;
    const found = await this.card(ref.id).catch(() => undefined);
    if (found === undefined || found.laneSet === null) return false;
    const lane = laneForTrigger(found.laneSet, found.task.workflow, 'release.published');
    return lane.ok && lane.value !== null && lane.value.id === found.task.laneId;
  }
}
