import { lstat, rm } from 'node:fs/promises';
import type { IRetiredArtifactPort, RetiredArtifactOutcome } from '../../lib/daemon/ports.ts';
import { walkTree } from './state-tree.ts';

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Removing a CLI-owned artifact tree an earlier release wrote.
 *
 * **It forces write permission back onto every directory on the way down, and that is the only reason
 * this exists.** The retired daemon snapshot store sealed each snapshot directory to mode 0555 when
 * its build finished, and an entry inside a directory can only be unlinked by somebody who may write
 * to that directory — so `rm -rf` on the store fails with EACCES on the first snapshot it reaches. A
 * store nobody can delete is the 100MB an upgraded host would otherwise carry forever.
 *
 * Symbolic links are counted and unlinked, never followed. The garbage-collection roots are links into
 * `/nix/store`, and following one would recursively delete somebody's Nix output. That walk is shared
 * with the reset verb's tree port — see `walkTree` — because how a tree is counted and how a link is
 * treated must never be two opinions.
 *
 * Nothing throws. A tree that is not there is `absent`, which is the ordinary answer on every host
 * that never ran the release this cleans up after, and anything else that goes wrong comes back as a
 * reason for the caller to warn with. Reclaiming disk may never fail a lifecycle command.
 */
export class FileRetiredArtifacts implements IRetiredArtifactPort {
  async retire(path: string): Promise<RetiredArtifactOutcome> {
    try {
      await lstat(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { kind: 'absent' };
      return { kind: 'failed', reason: errorMessage(error) };
    }
    try {
      const walk = await walkTree(path, { unseal: true });
      await rm(path, { recursive: true, force: true });
      return { kind: 'removed', files: walk.files, bytes: walk.bytes };
    } catch (error) {
      return { kind: 'failed', reason: errorMessage(error) };
    }
  }
}
