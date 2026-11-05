import { createReadStream } from 'node:fs';
import { type FileHandle, mkdir, open, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { VoiceFileSink, VoiceInstallFiles } from '../../lib/voice-install/index.ts';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const EXECUTABLE_MODE = 0o700;

/** A sink over an open file: every chunk is written in full, and `close` flushes to disk first. */
function sinkOver(handle: FileHandle): VoiceFileSink {
  return {
    write: async chunk => {
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        offset += bytesWritten;
      }
    },
    close: async () => {
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  };
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/** The speech engine's files, on the real disk. Directories and files are owner-only. */
export class NodeVoiceInstallFiles implements VoiceInstallFiles {
  async size(path: string): Promise<number | undefined> {
    try {
      const info = await stat(path);
      return info.isFile() ? info.size : undefined;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  read(path: string): AsyncIterable<Uint8Array> {
    return createReadStream(path);
  }

  async openAppend(path: string, options: { readonly truncate: boolean }): Promise<VoiceFileSink> {
    await mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
    return sinkOver(await open(path, options.truncate ? 'w' : 'a', FILE_MODE));
  }

  async openStaged(path: string, options: { readonly executable: boolean }): Promise<VoiceFileSink> {
    await mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
    // `wx`: a staging directory is fresh, so an existing file means two entries share a path — refuse it.
    return sinkOver(await open(path, 'wx', options.executable ? EXECUTABLE_MODE : FILE_MODE));
  }

  async makeDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  }

  async rename(from: string, to: string): Promise<void> {
    await mkdir(dirname(to), { recursive: true, mode: DIRECTORY_MODE });
    await rename(from, to);
  }

  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  async readText(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async writeText(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
    await writeFile(path, text, { mode: FILE_MODE });
  }

  async freeBytes(path: string): Promise<number | undefined> {
    // The directory may not exist yet: ask about the nearest one that does.
    let probe = path;
    for (;;) {
      try {
        const info = await statfs(probe);
        return Number(info.bavail) * Number(info.bsize);
      } catch (error) {
        const parent = dirname(probe);
        if (!isMissing(error) || parent === probe) return undefined;
        probe = parent;
      }
    }
  }

  async list(path: string): Promise<readonly string[]> {
    try {
      return await readdir(path);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }
}
