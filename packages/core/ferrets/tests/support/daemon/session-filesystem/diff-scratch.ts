import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type DiffScratch, SYMLINK_MODE } from '../../../../daemon/adapters/session/filesystem/runner-session-git.ts';
import type { DiffSide } from '../../../../daemon/lib/session/filesystem/index.ts';

/** Today's `diffSnapshots` scratch directory and `stageSide` writes, as tests provide them (the kernel's in product). */
export const testDiffScratch: DiffScratch = {
  async withScratch(use) {
    const scratch = await mkdtemp(path.join(tmpdir(), 'ferretry-diff-'));
    try {
      return await use(scratch, async (relative: string, side: DiffSide) => {
        const absolute = path.join(scratch, relative);
        await mkdir(path.dirname(absolute), { recursive: true });
        if (side.mode === SYMLINK_MODE) {
          // Recreate it as a symlink so Git reports the type natively. Git reads this with `readlink` and never
          // opens it, so the target is never followed — whether or not it still exists, or ever did.
          await symlink(new TextDecoder().decode(side.bytes), absolute);
          return;
        }
        await writeFile(absolute, side.bytes, { mode: side.mode & 0o777 });
        // `writeFile`'s mode is subject to umask; `chmod` is not.
        await chmod(absolute, side.mode & 0o777);
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
};
