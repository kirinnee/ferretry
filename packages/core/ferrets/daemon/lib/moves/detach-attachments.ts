import type { JobKeeperSource } from '../../../contract/job-keeping.ts';
import { bounded } from './bounded.ts';

/**
 * How long, IN TOTAL on the caller's clock, the whole detach may take — the questions to the keeper included — before the
 * pane is killed anyway. Each keeper question has its own bound, so counting polls would let a slow keeper hold the move for
 * many times this; the deadline is what is measured.
 */
const DETACH_WAIT_MS = 4_000;
const POLL_MS = 250;
/** How long each keeper question gets here (shorter than the gate's: this one holds the move while the old pane is still up). */
const DETACH_QUESTION_MS = 1_500;

/**
 * Asks the keeper to detach every attachment of the ferret, then waits (bounded) for them to be gone. Never throws and
 * never blocks the move for much longer than {@link DETACH_WAIT_MS} overall: the pane's kill breaks any attachment still there, and the
 * jobs are the keeper's whether or not the attachment let go in time. Answers whether every attachment was seen gone.
 */
export async function detachAttachments(
  keeper: Pick<JobKeeperSource, 'attachments' | 'detach'>,
  ferret: string,
  io: {
    readonly sleep: (ms: number) => Promise<void>;
    /** The caller's clock, the one the total wait is measured on. */
    readonly nowMs: () => number;
    /** How long each keeper question may take (default {@link DETACH_QUESTION_MS}). */
    readonly timeoutMs?: number;
    readonly log: { warn(message: string, fields?: Record<string, unknown>): void };
  },
): Promise<boolean> {
  const deadline = io.nowMs() + DETACH_WAIT_MS;
  const remaining = (): number => Math.max(0, deadline - io.nowMs());
  // One question to the keeper, bounded: a keeper that hangs must not hold the move. With the deadline above, the whole detach
  // is a few seconds at the very most, however slow the keeper is.
  const asked = async <T>(work: Promise<T>): Promise<T> =>
    await bounded(work, io.timeoutMs ?? DETACH_QUESTION_MS, 'the job keeper', io.sleep);
  try {
    if ((await asked(keeper.attachments(ferret))).length === 0) return true;
    await asked(keeper.detach(ferret));
    while (remaining() > 0) {
      await io.sleep(Math.min(POLL_MS, remaining()));
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
