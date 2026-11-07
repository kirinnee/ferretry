import { constants } from 'node:fs';
import { mkdir, open, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Clock, FencedPath } from '@ferretry/kernel/contract';
import type { StagedFileMover } from '../files.ts';
import { STAGED_FILE_TTL_MS } from '../files-policy.ts';

// GAP (kernel port, banned-globals stays visible here): a page's staged copies are opened `O_NOFOLLOW` in a private
// folder so a link planted there is never followed; no kernel root handle opens a file that way.

/** Today's `SAVED_FILE_MODE`, `DIRECTORY_MODE` and `PRIVATE_DIRECTORY_MODE` (`agent-files/files.ts`). */
const SAVED_FILE_MODE = 0o644;
const DIRECTORY_MODE = 0o755;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
/** `<placed-at>-<token>`: when a copy was placed, so a sweep knows when it is due. */
const PLACED_NAME = /^(\d+)-[0-9a-f-]+$/u;

/**
 * The bytes the file tools write. GAP: the kernel's `RootHandle` writes text only, so the daemon's upload copies and a
 * saved download or PDF are written here — the copy into a path the kernel's `work` root already fenced, opened
 * `O_NOFOLLOW` (never through a link) and `O_EXCL` unless asked to overwrite, bounded, never executable.
 */
export function nodeStagedFiles(uploadDirectory: string, clock: Pick<Clock, 'nowMs'>): StagedFileMover {
  /** Removes the copies placed for earlier uploads once their time has passed: a page may read one when its form is sent. */
  const sweep = async (): Promise<void> => {
    const cutoff = clock.nowMs() - STAGED_FILE_TTL_MS;
    const names = await readdir(uploadDirectory).catch(() => []);
    for (const name of names) {
      const placedAt = PLACED_NAME.exec(name)?.[1];
      if (placedAt !== undefined && Number(placedAt) > cutoff) continue;
      await rm(join(uploadDirectory, name), { recursive: true, force: true }).catch(() => undefined);
    }
  };
  return {
    place: async (name, bytes) => {
      await sweep();
      const directory = join(uploadDirectory, `${String(clock.nowMs())}-${crypto.randomUUID()}`);
      await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      const path = join(directory, name);
      await writeFile(path, bytes, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
      return path;
    },
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
}
