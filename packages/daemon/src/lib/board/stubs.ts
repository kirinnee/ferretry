/**
 * STUBS for the board ports later units implement (`board-design.md` §6). Each says exactly what it
 * does not know, and each is replaced, not extended:
 *
 * - {@link StubLaneSetSource} → U3 (projects and lanes)
 * - {@link NoopReopenNotifier} and {@link NoAgendaLinks} → U7 (spawn, signal and agenda links)
 *
 * They do no IO, which is why they live in the domain tier and are unit tested.
 */
import {
  type BoardProjectId,
  type BoardTask,
  type BoardTaskId,
  LANE_TEMPLATES,
  type LaneSet,
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';
import type { AgendaLinkSource, CardAsks, LaneSetSource, ReopenNotifier } from './ports.ts';

/** Who a stub lane set says proposed it. Not a session id: nothing proposed it. */
export const STUB_LANE_SET_PROPOSER = 'stub';

/**
 * STUB, REPLACED BY U3. Files every session on the Unfiled board and gives every project the
 * `pr-release-verify` template, unconfirmed. U3 resolves `config.projectId` and stores real lane sets.
 */
export class StubLaneSetSource implements LaneSetSource {
  async projectOf(_sessionId: string): Promise<BoardProjectId> {
    return UNFILED_PROJECT_ID;
  }

  async laneSet(projectId: BoardProjectId): Promise<LaneSet> {
    const template = LANE_TEMPLATES['pr-release-verify'];
    return {
      projectId,
      version: 1,
      confirmedBy: null,
      proposedBy: STUB_LANE_SET_PROPOSER,
      lanes: [...template.lanes],
      variants: template.variants,
    };
  }
}

/** STUB, REPLACED BY U7. No agenda item names a card yet, so no card has asks. */
export class NoAgendaLinks implements AgendaLinkSource {
  async asksFor(_cards: readonly BoardTask[]): Promise<ReadonlyMap<BoardTaskId, CardAsks>> {
    return new Map();
  }
}

/**
 * STUB, REPLACED BY U7. Delivers nothing: the reopen is recorded on the card, and the card's ferret
 * learns of it only by reading the card until U7 queues `[reopened &F412 by owner: …]` to it.
 */
export class NoopReopenNotifier implements ReopenNotifier {
  async reopened(): Promise<void> {}
}
