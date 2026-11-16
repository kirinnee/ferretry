import type { ScratchPort } from '@ferretry/kernel/contract';
import type { DiffSide } from '../../../lib/session/filesystem/index.ts';
import { type DiffScratch, SYMLINK_MODE } from './runner-session-git.ts';

/**
 * The diff's private scratch directory (today's `mkdtemp` under the temp dir), over the kernel's scratch port: a fresh
 * `0700` folder, removed after `use` however it ended. A side is written with exactly its permission bits, and a side
 * whose mode is a symlink becomes a link whose target is its bytes, never followed (the kernel's scratch refuses to
 * write through one).
 */
export class KernelDiffScratch implements DiffScratch {
  constructor(private readonly scratch: ScratchPort) {}

  async withScratch<T>(
    use: (directory: string, stage: (relative: string, side: DiffSide) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const directory = await this.scratch.open();
    try {
      return await use(directory.path, async (relative, side) => {
        const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
        if (parent !== '') await directory.makeDirectory(parent);
        if (side.mode === SYMLINK_MODE) await directory.symlink(relative, new TextDecoder().decode(side.bytes));
        else await directory.writeFile(relative, side.bytes, side.mode & 0o777);
      });
    } finally {
      await directory.close();
    }
  }
}
