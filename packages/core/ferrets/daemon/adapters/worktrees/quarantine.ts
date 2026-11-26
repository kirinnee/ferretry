import { createHash } from 'node:crypto';
import path from 'node:path';
import type { WorktreeFileSystem } from '../../lib/worktrees/ports.ts';
import type { ManagedWorktree, ManagedWorktreePresence, WorktreeAdoptionIdentity } from '../../lib/worktrees/types.ts';
import { WorktreeError } from '../../lib/worktrees/errors.ts';

/** The durable row already holds the opaque token; the same sibling name is recoverable after a restart. */
export const quarantinePath = (entry: ManagedWorktree): string =>
  path.join(
    path.dirname(entry.path),
    `.fy-remove-${createHash('sha256').update(`${entry.path}\0${entry.ownershipToken}`).digest('hex')}`,
  );

export async function removalIdentity(
  files: WorktreeFileSystem,
  entry: ManagedWorktree,
): Promise<WorktreeAdoptionIdentity | undefined> {
  const checkout = await files.directoryIdentity(entry.path);
  const gitDirectory = await files.directoryIdentity(entry.gitDir);
  const commonDirectory = await files.directoryIdentity(entry.commonDir);
  return checkout === undefined || gitDirectory === undefined || commonDirectory === undefined
    ? undefined
    : { checkout, gitDirectory, commonDirectory };
}

/** Called only for a durably authorized removal and after proving the held repository's recorded identity. */
export async function recoverQuarantine(
  files: WorktreeFileSystem,
  entry: ManagedWorktree,
  prune: () => Promise<void>,
): Promise<ManagedWorktreePresence | undefined> {
  const expected = entry.removalIdentity;
  if (expected === undefined) return undefined;
  const quarantine = quarantinePath(entry);
  const kind = await files.type(quarantine);
  const metadata = await files.directoryIdentity(entry.gitDir);
  if ((await files.type(entry.gitDir)) !== 'missing' && metadata !== expected.gitDirectory)
    throw new WorktreeError('verification_failed', 'the recorded worktree metadata was replaced');
  if (kind !== 'missing') {
    if (kind !== 'directory' || (await files.directoryIdentity(quarantine)) !== expected.checkout)
      return { kind: 'unverified', reason: `a different directory is preserved at recovery path ${quarantine}` };
    await files.removeTree(quarantine, expected.checkout);
    await prune();
    return { kind: 'absent' };
  }
  if ((await files.type(entry.path)) === 'missing') {
    await prune();
    return { kind: 'absent' };
  }
  if ((await files.directoryIdentity(entry.path)) !== expected.checkout)
    return { kind: 'unverified', reason: `the original path was replaced; inspect recovery path ${quarantine}` };
  return undefined;
}
