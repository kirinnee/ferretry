import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { WaitHeartbeat, WaitHeartbeatSink } from '../../../lib/session/monitor/types.ts';
import type { SessionId } from '../../../lib/session-id.ts';
import { writeJsonAtomic } from './atomic-json.ts';

/**
 * The proof that a park is being watched, inside the session's own private directory.
 *
 * WHY A FILE AND NOT ONLY AN EVENT. A park suspends the nudge, the stall reflex and the turn ceiling,
 * so the one question anybody asks about it is "is anything still going to end this". A journal entry
 * answers that only to a reader who replays the journal; a file at a known path answers it to a
 * human, to the warden, and to a supervisor that has just restarted and holds no history at all.
 *
 * THE FILE CARRIES BOTH INSTANTS ON PURPOSE. `at` is when the loop last looked, `expiresAt` is when
 * the park is due to be woken. A file whose `at` is older than its own `expiresAt` is a wake that did
 * not fire — a missed tick, stated by the artifact itself rather than inferred from its absence. An
 * absent file means no tick has ever serviced this park, which is the same fault one stage earlier.
 *
 * `checks/waiting.json` IS KTEAM'S OWN PATH, kept so an operator who knows where to look still finds
 * it, and so a migrated state home reads the same either side of the cut.
 */
export class FileWaitHeartbeat implements WaitHeartbeatSink {
  constructor(
    private readonly sessionDirectory: (id: SessionId) => string,
    private readonly uniqueId: () => string = randomUUID,
  ) {}

  async publish(id: SessionId, beat: WaitHeartbeat): Promise<void> {
    // Absent rather than null, for the reason the state document uses: a reader should see a field
    // that was not applicable, not one that was explicitly emptied.
    await writeJsonAtomic(
      join(this.sessionDirectory(id), 'checks', 'waiting.json'),
      {
        at: beat.at,
        since: beat.since,
        elapsedSeconds: beat.elapsedSeconds,
        ...(beat.until === undefined ? {} : { until: beat.until }),
        ...(beat.condition === undefined ? {} : { condition: beat.condition }),
        ...(beat.expiresAt === undefined ? {} : { expiresAt: beat.expiresAt }),
        ...(beat.remainingSeconds === undefined ? {} : { remainingSeconds: beat.remainingSeconds }),
      },
      this.uniqueId,
    );
  }
}
