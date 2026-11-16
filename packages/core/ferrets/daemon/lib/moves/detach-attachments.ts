import type { JobKeeperSource } from '../../../contract/job-keeping.ts';
import { bounded, KEEPER_TIMEOUT_MS } from './bounded.ts';

/** How long the attachments get to print their detach message and exit before the pane is killed anyway. */
const DETACH_WAIT_MS = 4_000;
const POLL_MS = 250;

/**
 * Asks the keeper to detach every attachment of the ferret, then waits (bounded) for them to be gone. Never throws and
 * never blocks the move for longer than {@link DETACH_WAIT_MS}: the pane's kill breaks any attachment still there, and the
 * jobs are the keeper's whether or not the attachment let go in time. Answers whether every attachment was seen gone.
 */
export async function detachAttachments(
  keeper: Pick<JobKeeperSource, 'attachments' | 'detach'>,
  ferret: string,
  io: {
    readonly sleep: (ms: number) => Promise<void>;
    /** How long each keeper question may take (default {@link KEEPER_TIMEOUT_MS}). */
    readonly timeoutMs?: number;
    readonly log: { warn(message: string, fields?: Record<string, unknown>): void };
  },
): Promise<boolean> {
  // One question to the keeper, bounded: a keeper that hangs must not hold the move.
  const asked = async <T>(work: Promise<T>): Promise<T> =>
    await bounded(work, io.timeoutMs ?? KEEPER_TIMEOUT_MS, 'the job keeper', io.sleep);
  try {
    if ((await asked(keeper.attachments(ferret))).length === 0) return true;
    await asked(keeper.detach(ferret));
    for (let waited = 0; waited < DETACH_WAIT_MS; waited += POLL_MS) {
      await io.sleep(POLL_MS);
      if ((await asked(keeper.attachments(ferret))).length === 0) return true;
    }
    io.log.warn('attachments were still there when the move went ahead; the kill will end them', { ferret });
    return false;
  } catch (error) {
    io.log.warn('attachments could not be detached; the move goes ahead and the kill will end them', {
      ferret,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
