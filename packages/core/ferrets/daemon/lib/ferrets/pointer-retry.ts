import { type Runner, type RunnerHandle, runnerDeliveryFailure } from '../../../contract/kinds/runner.ts';

/** How many times a relaunch's pointer is typed before the ferret is left for an owner to stop and resume. */
export const POINTER_ATTEMPTS = 3;
/** The wait before each further attempt, on the kernel clock when one is bound (a unit fixture waits for nothing). */
const POINTER_RETRY_DELAY_MS = 2_000;

/**
 * Today's revive typed the pointer again when the pane was not ready for it. A refusal the runner proved typed NOTHING
 * (a pane at work or behind a dialog, a composer holding a draft or one that cannot be read) may go again; `exited`,
 * a hold, `unconfirmed` (it may have landed: typing it twice would hand the ferret the turn twice) and any rejection
 * that says nothing about the keys never do.
 */
function mayTypeAgain(error: unknown): boolean {
  const failure = runnerDeliveryFailure(error);
  if (failure === undefined) return false;
  if (failure.kind === 'not_ready') return failure.why !== 'exited';
  return failure.kind === 'composer_occupied' || failure.kind === 'composer_unreadable';
}

/**
 * Types `text` into the pane behind `handle`, at most {@link POINTER_ATTEMPTS} times. Before each further attempt the
 * pane is probed again: a pane that is gone ends the loop, as does a handle that is no longer this ferret's. Rejects
 * with the LAST rejection (never a made-up one), so the caller says what it said before.
 */
export async function typePointer(
  runner: Runner,
  handle: RunnerHandle,
  text: string,
  still: () => boolean,
  pause: (ms: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await runner.deliver(handle, { text });
      return;
    } catch (error) {
      if (attempt >= POINTER_ATTEMPTS || !mayTypeAgain(error)) throw error;
      await pause(POINTER_RETRY_DELAY_MS);
      if (!still() || !(await runner.alive(handle).catch(() => false))) throw error;
    }
  }
}
