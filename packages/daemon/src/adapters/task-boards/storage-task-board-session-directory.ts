import { SessionConfigSchema, SessionStateSchema } from '@ferretry/protocol';
import { z } from 'zod';
import { readTaskBoardFleet } from '../../lib/task-boards/fleet-read.ts';
import type { TaskBoardSession, TaskBoardSessionDirectory } from '../../lib/task-boards/types.ts';
import { isTerminalStatus, type WardenSessionStatus } from '../../lib/warden/types.ts';

/**
 * The one lifecycle-owned field the board domain needs, read on its own.
 *
 * NOT `SessionLifecycleConfigSchema`. The stored configuration document is a protocol envelope with
 * the lifecycle's fields merged over it, and the two disagree about `agent`: the lifecycle demands the
 * absolute executable it authorized, the protocol publishes the wrapper NAME. Parsing the whole
 * document with the lifecycle schema would therefore fail on a well-formed session and drop every
 * board member the daemon has. Reading only the field in question cannot.
 */
const CapabilityHashDocumentSchema = z.object({
  sessionCapabilityHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
});

/** The documents this directory reads, behind the narrowest port that answers the question. */
export interface TaskBoardSessionSource {
  /** Every session id the daemon's index holds. */
  sessionIds(): readonly string[];
  readConfig(id: string): Promise<unknown>;
  readState(id: string): Promise<unknown>;
}

/**
 * Every session the board domain may address, projected from the daemon's own documents.
 *
 * WHY A SESSION MAY BE MISSING FROM THIS ANSWER, AND WHY THAT IS THE POINT. A session appears here
 * only when it carries a `sessionCapabilityHash`. Every grant, invitation proof and child grant in
 * the board domain is keyed on that hash, so a session without one cannot be a member of anything —
 * and reporting it anyway would let `requireTaskBoardSession` resolve a session that no capability
 * can ever be bound to, turning a structural impossibility into a confusing authorization failure at
 * the far end. Sessions started before the credential existed are exactly this case.
 *
 * WHY `active` IS THE WARDEN'S ANSWER RATHER THAN A NEW ONE. `isTerminalStatus` already states which
 * statuses a session never leaves, and the board needs the same fact for a different purpose: a
 * grant held by a session that has stopped must not authorize. Two definitions of "still alive" in
 * one daemon would eventually disagree, and the disagreement would be an authorization bug rather
 * than a display bug. `stalled` counts as terminal there, which is the fail-closed direction here
 * too — a session nobody can reach should not be able to act on a board through a stale capability.
 *
 * WHY A SESSION WITH AN UNREADABLE DOCUMENT IS OMITTED RATHER THAN GUESSED AT. `incarnation` and
 * `runtimeGeneration` are both terms in `isCapabilityBoundToSession`. Defaulting either one would
 * manufacture a match against a capability minted for a different incarnation of the same id, which
 * is precisely the replay this domain exists to refuse.
 */
export class StorageTaskBoardSessionDirectory implements TaskBoardSessionDirectory {
  constructor(private readonly source: TaskBoardSessionSource) {}

  /**
   * WHY THIS WALK IS BOUNDED RATHER THAN A PLAIN `Promise.all`. The unbounded form started every
   * session in the daemon at once, so its cost grew with the fleet — a term with no ceiling — while
   * the aggregate task route next door was staying under a fixed limit for reads of the same fleet.
   * One fact, two answers. {@link readTaskBoardFleet} is now the only answer, and it also keeps this
   * list in the index's order rather than in whichever order the filesystem replied.
   *
   * WHAT THE BOUND ACTUALLY IS HERE, STATED SO NOBODY QUOTES THE WRONG NUMBER. `readTaskBoardFleet`
   * limits SESSIONS in flight, and {@link session} starts TWO document reads per session together.
   * So this walk peaks at **64 sessions and up to 128 open documents**, which is twice the aggregate
   * route's ceiling for the same limit — the two callers share a session bound, NOT a document
   * bound. That is still the property worth having, because 128 is a constant and the fleet is not.
   * `tests/integration/task-boards/storage-task-board-session-directory.test.ts` measures both
   * numbers rather than trusting this paragraph.
   */
  async snapshot(): Promise<readonly TaskBoardSession[]> {
    const sessions = await readTaskBoardFleet(this.source.sessionIds(), async id => await this.session(id));
    return sessions.filter((session): session is TaskBoardSession => session !== undefined);
  }

  private async session(id: string): Promise<TaskBoardSession | undefined> {
    const [rawConfig, rawState] = await Promise.all([this.source.readConfig(id), this.source.readState(id)]);
    const config = SessionConfigSchema.safeParse(rawConfig);
    const credential = CapabilityHashDocumentSchema.safeParse(rawConfig);
    if (!config.success || !credential.success) return undefined;
    const hash = credential.data.sessionCapabilityHash;
    if (hash === undefined) return undefined;
    const state = SessionStateSchema.safeParse(rawState);
    // A session whose state document is unreadable is not assumed live: the board's whole answer to
    // "may this capability act" depends on it, and the safe reading of "I cannot tell" is "no".
    const status = state.success ? (state.data.status as WardenSessionStatus) : undefined;
    return {
      id: config.data.id,
      incarnation: config.data.incarnation,
      runtimeGeneration: config.data.runtimeGeneration,
      parentSessionId: config.data.parent ?? null,
      mode: config.data.mode,
      active: status !== undefined && !isTerminalStatus(status),
      name: config.data.name,
      teammate: config.data.teammate ?? null,
      sessionCapabilityHash: hash,
    };
  }
}
