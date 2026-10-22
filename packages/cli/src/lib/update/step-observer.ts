import type { IProgress } from '../progress/index.ts';
import { describeActivity, type UpdateObserver, type UpdatePhase } from './activity.ts';

/** Phases in the order an update moves through them; a step never goes back to an earlier one. */
const RANK: Readonly<Record<UpdatePhase, number>> = {
  refreshing: 0,
  preparing: 0,
  upgrading: 1,
  downloading: 1,
  building: 2,
  verifying: 3,
  unpacking: 4,
  switching: 5,
};

/**
 * An observer that turns a package manager's activity into progress steps for `target`.
 *
 * A step only moves FORWARD. nix interleaves downloads and builds, and a line per flip would bury the
 * run in `✔ Downloading` / `✔ Building` pairs; an activity from an earlier phase still updates the
 * detail of the step on screen, so the numbers keep moving.
 */
export function stepObserver(progress: IProgress, target: string): UpdateObserver {
  let phase: UpdatePhase | undefined;
  return activity => {
    const described = describeActivity(activity, target);
    if (phase === undefined || RANK[activity.phase] > RANK[phase]) {
      phase = activity.phase;
      progress.start(described.step);
    }
    if (described.detail !== undefined) progress.detail(described.detail);
  };
}
