import { constants } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FencedPath } from '@ferretry/kernel/contract';
import type { StagedFileMover } from '../files.ts';

/** Today's `SAVED_FILE_MODE` and `DIRECTORY_MODE` (`agent-files/files.ts`): a saved file is never executable. */
const SAVED_FILE_MODE = 0o644;
const DIRECTORY_MODE = 0o755;

/**
 * Copies a file the browser worker staged into a path the kernel's `work` root already fenced, then drops the staged
 * copy. GAP: the kernel's `RootHandle` writes text only, so the bytes of a download or a PDF are written here. The
 * file is opened `O_NOFOLLOW` (never through a link) and `O_EXCL` unless the caller asked to overwrite, and the copy
 * stops at `maxBytes` and removes what it wrote.
 */
export const nodeStagedFiles: StagedFileMover = {
  copy: async (from, to: FencedPath, options) => {
    await mkdir(dirname(to), { recursive: true, mode: DIRECTORY_MODE });
    const flags =
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      (options.overwrite ? constants.O_TRUNC : constants.O_EXCL);
    const target = await open(to, flags, SAVED_FILE_MODE);
    const source = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
    let size = 0;
    try {
      const chunk = new Uint8Array(64 * 1024);
      for (;;) {
        const { bytesRead } = await source.read(chunk, 0, chunk.byteLength, null);
        if (bytesRead === 0) break;
        size += bytesRead;
        if (size > options.maxBytes) throw new Error('over the save size limit');
        await target.write(chunk, 0, bytesRead);
      }
    } catch (error) {
      await target.close();
      await rm(to, { force: true });
      throw error;
    } finally {
      await source.close();
    }
    await target.close();
    await rm(from, { force: true });
    return size;
  },
};
