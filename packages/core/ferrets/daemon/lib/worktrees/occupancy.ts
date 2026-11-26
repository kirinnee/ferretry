import { WorktreeRemovalRefusal } from './errors.ts';
import type { CheckManagedWorktreeRemovalInput, RemoveManagedWorktreeInput } from './types.ts';

function fingerprint(input: CheckManagedWorktreeRemovalInput): string {
  return JSON.stringify([
    input.ownerActive,
    input.currentWorkingDirectory,
    input.otherSessions ?? [],
    input.liveTerminals ?? 0,
    input.undeterminedEvidence ?? [],
  ]);
}

/** Last host sample, after Git inspection AND pinning, immediately before the delete spawn. */
export async function verifyWorktreeOccupancy(
  previous: CheckManagedWorktreeRemovalInput,
  refresh: RemoveManagedWorktreeInput['refreshEvidence'],
): Promise<void> {
  const boundary = (await refresh?.()) ?? previous;
  if (fingerprint(boundary) !== fingerprint(previous)) {
    throw new WorktreeRemovalRefusal(`refusing to remove ${previous.managed.path}: occupancy changed before deletion`, [
      { code: 'undetermined_evidence', message: 'host occupancy changed after the final preflight' },
    ]);
  }
}
