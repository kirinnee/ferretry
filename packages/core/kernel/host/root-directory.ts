import { basename, dirname } from 'node:path';
import type { RootIdentity } from '../contract/ports/roots.ts';
import type { HostFs, OpenedDirectory } from './adapters/node-fs.ts';
import type { RootRefusal } from './roots.ts';

/** A creating handle is the ownership receipt. A later lookup by name can only verify it, never mint it. */
export async function createPrivateDirectory<S extends { readonly fs: HostFs; readonly ownerRoot: boolean }>(
  scope: S,
  full: string,
  uid: number | undefined,
  openParent: (scope: S, path: string) => Promise<OpenedDirectory>,
  refuse: (reason: RootRefusal) => never,
): Promise<RootIdentity> {
  if (scope.ownerRoot) return refuse('read_only');
  const parent = await openParent(scope, dirname(full));
  try {
    if (uid === undefined || parent.identity.owner !== uid || (parent.identity.mode & 0o7777) !== 0o700)
      return refuse('changed');
    // openChild performs mkdir + O_DIRECTORY|O_NOFOLLOW open through this held, private parent.
    const made = await parent.openChild(basename(full), { mode: 0o700 }).catch(() => refuse('changed'));
    try {
      if (!made.created) return refuse('changed');
      const identity = made.folder.identity;
      if (identity.owner !== uid || (identity.mode & 0o7777) !== 0o700) return refuse('changed');
      await parent.sync();
      return { device: identity.device, inode: identity.inode };
    } finally {
      await made.folder.close();
    }
  } finally {
    await parent.close();
  }
}
