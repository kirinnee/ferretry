import { constants } from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';
import type { FencedPath } from '@ferretry/kernel/contract';
import type { StagedFileMover } from '../files.ts';

/**
 * Copies a file the browser worker staged into a fenced path, then drops the staged copy. GAP: the kernel's
 * `RootHandle` writes text only, so the bytes of a download or a PDF are copied here, to a path the kernel's root
 * already fenced; `COPYFILE_EXCL` keeps it from replacing a file unless asked.
 */
export const nodeStagedFiles: StagedFileMover = {
  copy: async (from: string, to: FencedPath, overwrite: boolean) => {
    await copyFile(from, to, overwrite ? 0 : constants.COPYFILE_EXCL);
    await rm(from, { force: true });
  },
};
