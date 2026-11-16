import type { StateFileDef } from '@ferretry/kernel/contract';
import type { SessionId } from '../../lib/session-id.ts';
import type { JournalFingerprint } from '../../lib/storage-types.ts';

export function sameFingerprint(left: JournalFingerprint | null, right: JournalFingerprint | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.device === right.device &&
      left.inode === right.inode &&
      left.size === right.size &&
      left.modifiedAtMs === right.modifiedAtMs)
  );
}

/** Where a collection file of `id` lives, for messages: the declared path with its `*` filled. */
export function fileOf(file: StateFileDef, id: SessionId): string {
  return file.path.replace('*', id);
}

export function assertFleetTailLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
    throw new Error('fleet event limit must be an integer between 1 and 10000');
}
