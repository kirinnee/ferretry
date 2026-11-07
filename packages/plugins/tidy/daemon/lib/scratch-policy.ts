/**
 * Safety policy for reclaiming a stopped ferret's scratch, copied from today's `lib/scratch/policy.ts` and kept pure so
 * a sweep can explain every refusal before it touches a folder.
 *
 * Today's whitelist of the daemon's own session files is gone: in 5.0 the daemon's records live under `state/`, which
 * a ferret's folder never contains. What replaces it is the one thing that must never be swept: a git worktree.
 */

export interface ScratchEligibilityInput {
  readonly stopped: boolean;
  /** When the ferret stopped (ms since the epoch), or `undefined` when unknown. */
  readonly stoppedAtMs: number | undefined;
  /** The newest modification time under the folder (ms), or `undefined` when none could be read. */
  readonly newestMtimeMs: number | undefined;
  readonly nowMs: number;
  readonly ttlMs: number;
  /** The folder is a git worktree: its branch may hold work that is not pushed anywhere else. */
  readonly gitWorktree: boolean;
  /** Another ferret that is not stopped works in this same folder. */
  readonly sharedWithLive: boolean;
}

export interface ScratchEligibility {
  readonly eligible: boolean;
  readonly reason?: string;
}

export function scratchEligibility(input: ScratchEligibilityInput): ScratchEligibility {
  if (!input.stopped) return { eligible: false, reason: 'not stopped' };
  if (input.sharedWithLive) return { eligible: false, reason: 'another ferret is still working in this folder' };
  if (input.gitWorktree)
    return { eligible: false, reason: 'a git worktree: its branch may hold work that is not pushed' };
  const settledAt = input.stoppedAtMs ?? input.newestMtimeMs;
  if (settledAt === undefined || !Number.isFinite(settledAt))
    return { eligible: false, reason: 'no stop time and no file time to age from' };
  const age = input.nowMs - settledAt;
  if (age < input.ttlMs)
    return { eligible: false, reason: `stopped for ${Math.round(age / 3_600_000)}h, under the wait` };
  if (input.newestMtimeMs !== undefined && input.nowMs - input.newestMtimeMs < input.ttlMs)
    return { eligible: false, reason: 'a file in the folder changed inside the wait' };
  return { eligible: true };
}
