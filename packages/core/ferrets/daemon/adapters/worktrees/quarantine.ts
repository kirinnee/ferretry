import { createHash } from 'node:crypto';
import path from 'node:path';
import type { WorktreeFileSystem } from '../../lib/worktrees/ports.ts';
import type {
  ManagedWorktree,
  ManagedWorktreePresence,
  WorktreeAdoptionIdentity,
  WorktreeRemovalIdentity,
  RecordRemovalIdentity,
} from '../../lib/worktrees/types.ts';
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

/** The recorded linked-worktree metadata, still in the recorded repository and unlocked NOW. */
export async function verifyRemovalMetadata(
  files: WorktreeFileSystem,
  entry: Pick<ManagedWorktree, 'path' | 'commonDir' | 'gitDir'>,
  expected: WorktreeAdoptionIdentity,
  checkBacklink = true,
  allowMissingBacklink = false,
): Promise<void> {
  if (
    path.dirname(entry.gitDir) !== path.join(entry.commonDir, 'worktrees') ||
    (await files.directoryIdentity(entry.commonDir)) !== expected.commonDirectory ||
    (await files.directoryIdentity(entry.gitDir)) !== expected.gitDirectory
  )
    throw new WorktreeError(
      'verification_failed',
      'the recorded worktree metadata or repository was replaced or is missing',
    );
  if (checkBacklink) {
    if (!(allowMissingBacklink && (await files.type(path.join(entry.gitDir, 'gitdir'))) === 'missing')) {
      const backlink = (await files.readText(path.join(entry.gitDir, 'gitdir'))).replace(/\n$/, '');
      if (!path.isAbsolute(backlink) && backlink.split(path.sep).includes('..'))
        throw new WorktreeError(
          'verification_failed',
          'a relative worktree backlink with parent traversal is unsafe; run git worktree repair',
        );
      if (path.resolve(entry.gitDir, backlink) !== path.join(entry.path, '.git'))
        throw new WorktreeError('verification_failed', 'the recorded worktree metadata points to a different checkout');
    }
  }
  if ((await files.type(path.join(entry.gitDir, 'locked'))) !== 'missing')
    throw new WorktreeError('unsafe_remove', 'the worktree is locked; its checkout and metadata are kept');
}

const missingRemovalProof = () =>
  new WorktreeError(
    'unsafe_remove',
    'checkout removal could not be proved; metadata is kept; run git worktree repair or remove it yourself',
  );

/** Only an actual identity-bound deletion, verified absent, can authorize metadata cleanup. */
export async function removeQuarantinedCheckout(
  files: WorktreeFileSystem,
  entry: ManagedWorktree,
  expected: WorktreeRemovalIdentity,
  recordRemovalIdentity?: RecordRemovalIdentity,
): Promise<WorktreeRemovalIdentity> {
  const quarantine = quarantinePath(entry);
  const result = await files.removeTree(
    quarantine,
    expected.checkout,
    async () => await verifyRemovalMetadata(files, entry, expected),
  );
  if (result !== 'deleted' || (await files.type(quarantine)) !== 'missing') throw missingRemovalProof();
  const completed = { ...expected, checkoutRemoved: true as const };
  await recordRemovalIdentity?.(completed);
  return completed;
}

/** Remove exactly the journalled metadata directory. Git must never prune other registrations. */
export async function removeRecordedMetadata(
  files: WorktreeFileSystem,
  entry: Pick<ManagedWorktree, 'path' | 'commonDir' | 'gitDir'>,
  expected: WorktreeRemovalIdentity,
  recordRemovalIdentity?: RecordRemovalIdentity,
): Promise<void> {
  if (expected.checkoutRemoved !== true) throw missingRemovalProof();
  await verifyRemovalMetadata(files, entry, expected, true, expected.metadataCleanupStarted === true);
  await recordRemovalIdentity?.({ ...expected, metadataCleanupStarted: true });
  let started = false;
  await files.removeTree(entry.gitDir, expected.gitDirectory, async () => {
    // The first unlink may delete gitdir itself. Later vetoes still check identity and any newly arrived lock.
    await verifyRemovalMetadata(files, entry, expected, !started, expected.metadataCleanupStarted === true);
    started = true;
  });
  if (
    (await files.directoryIdentity(entry.commonDir)) !== expected.commonDirectory ||
    (await files.type(entry.gitDir)) !== 'missing'
  )
    throw new WorktreeError('verification_failed', 'the recorded worktree metadata removal could not be proved');
}

/** Called only for a durably authorized removal and after proving the held repository's recorded identity. */
export async function recoverQuarantine(
  files: WorktreeFileSystem,
  entry: ManagedWorktree,
  recordRemovalIdentity?: RecordRemovalIdentity,
): Promise<ManagedWorktreePresence | undefined> {
  const expected = entry.removalIdentity;
  if (expected === undefined) return undefined;
  const quarantine = quarantinePath(entry);
  const kind = await files.type(quarantine);
  if (kind === 'missing' && (await files.type(entry.path)) === 'missing' && expected.checkoutRemoved !== true)
    return { kind: 'unverified', reason: missingRemovalProof().message };
  // A crash after both deletes needs only a tombstone. Missing metadata never authorizes deleting a checkout.
  if (
    kind === 'missing' &&
    (await files.type(entry.path)) === 'missing' &&
    (await files.type(entry.gitDir)) === 'missing'
  ) {
    if ((await files.directoryIdentity(entry.commonDir)) !== expected.commonDirectory)
      throw new WorktreeError('verification_failed', 'the recorded repository was replaced');
    return { kind: 'absent' };
  }
  if (kind === 'missing' && (await files.type(entry.path)) === 'missing') {
    await removeRecordedMetadata(files, entry, expected, recordRemovalIdentity);
    return { kind: 'absent' };
  }
  await verifyRemovalMetadata(files, entry, expected);
  if (kind !== 'missing') {
    if (kind !== 'directory' || (await files.directoryIdentity(quarantine)) !== expected.checkout)
      return { kind: 'unverified', reason: `a different directory is preserved at recovery path ${quarantine}` };
    await verifyRemovalMetadata(files, entry, expected);
    const completed = await removeQuarantinedCheckout(files, entry, expected, recordRemovalIdentity);
    await removeRecordedMetadata(files, entry, completed, recordRemovalIdentity);
    return { kind: 'absent' };
  }
  if ((await files.directoryIdentity(entry.path)) !== expected.checkout)
    return { kind: 'unverified', reason: `the original path was replaced; inspect recovery path ${quarantine}` };
  return undefined;
}
