import { err, type Result } from '@ferretry/std';
import type { StartFailure, StartRefusal } from '../../../contract/index.ts';

/**
 * What the owner is told for each closed runner refusal (`StartRefusal`): a runner mints no text, so the daemon says the
 * next thing to check instead of the bare code. `real_harness` has its own sentence (`REAL_HARNESS_REFUSED`).
 */
const SENTENCES: Readonly<Record<Exclude<StartRefusal, 'real_harness'>, string>> = {
  unavailable:
    'the runner could not be reached on this machine, so the ferret was not started: check that it is installed and running, then try again',
  failed:
    'the runner could not open a pane for the ferret, so it was not started: a pane with its name may still be running (stop it), or the runner refused the launch (see the daemon log), then try again',
  limits:
    "the machine's limits left no room for the ferret, so it was not started: stop another ferret or raise the cap in limits.yaml, then try again",
};

/** A start or resume the runner refused, as the failure the caller is told. */
export const runnerRefusal = (refusal: Exclude<StartRefusal, 'real_harness'>): Result<never, StartFailure> =>
  err({
    code: refusal === 'unavailable' ? 'runner_unavailable' : 'failed',
    reason: SENTENCES[refusal],
  } as StartFailure);
