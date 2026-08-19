import { chmod, lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { IRetiredArtifactPort, RetiredArtifactOutcome } from '../../lib/daemon/ports.ts';

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What one descent found, accumulated so the caller can say how much disk came back. */
interface Measured {
  files: number;
  bytes: number;
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
 * `/nix/store`, and following one would recursively delete somebody's Nix output.
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
    const measured: Measured = { files: 0, bytes: 0 };
    try {
      await this.#unseal(path, measured);
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      return { kind: 'failed', reason: errorMessage(error) };
    }
    return { kind: 'removed', files: measured.files, bytes: measured.bytes };
  }

  /**
   * Make one entry removable, and measure it, before its parent is asked to unlink it.
   *
   * The directory is chmodded BEFORE its children are read: a directory with no execute or write bit
   * can neither be listed nor have anything taken out of it, and both are needed on the way down.
   */
  async #unseal(path: string, measured: Measured): Promise<void> {
    const state = await lstat(path);
    if (state.isSymbolicLink()) {
      measured.files += 1;
      return;
    }
    if (!state.isDirectory()) {
      measured.files += 1;
      measured.bytes += state.size;
      return;
    }
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await this.#unseal(join(path, entry), measured);
  }
}
