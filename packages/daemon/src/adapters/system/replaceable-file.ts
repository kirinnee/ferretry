import { lstat, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Whether this account could change the program or put another in its place. OWNERSHIP, not today's permission
 * bits: an owner can `chmod` its way back in. A ferret runs as this same account, so the program counts as
 * replaceable when any part of the path as found, or of the real file behind it, up to `/`, is owned by this
 * account (a link it could repoint, a folder it could fill), or is a folder anyone may write without the sticky
 * bit. A part that cannot be looked at counts as replaceable.
 */
export async function replaceableBy(account: number | undefined, file: string): Promise<boolean> {
  const real = await realpath(file).catch(() => file);
  for (const path of new Set([file, real])) if (await anyPartReplaceable(account, path)) return true;
  return false;
}

async function anyPartReplaceable(account: number | undefined, path: string): Promise<boolean> {
  for (let part = path; ; part = dirname(part)) {
    const status = await lstat(part).catch(() => undefined);
    if (status === undefined) return true;
    if (account !== undefined && status.uid === account) return true;
    const openToOthers = (status.mode & 0o022) !== 0 && (status.mode & 0o1000) === 0;
    // A symlink's own mode is always open and means nothing; what it names is checked on the real path.
    if (openToOthers && !status.isSymbolicLink()) return true;
    if (part === dirname(part)) return false;
  }
}
