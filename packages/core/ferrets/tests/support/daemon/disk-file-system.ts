/**
 * A real-disk stand-in for the few `FileSystemPort` methods the session artifact adapters use (the monitor's atomic
 * JSON, the resume turn store, the signal artifacts), for the tests that read the written files back. Tests are exempt
 * from `banned-globals`; a daemon binds the real port. Behaviour mirrors the state file system: directories `0700`,
 * files `0600`, a whole file replaced by rename, a line appended with its own newline, an absent file removed quietly.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileSystemPort } from '../../../daemon/lib/ports.ts';

type DiskFileSystemPort = Pick<
  FileSystemPort,
  'ensureDirectory' | 'writeTextAtomic' | 'appendLineDurable' | 'removeFile' | 'readText'
>;

export class DiskFileSystem implements DiskFileSystemPort {
  async ensureDirectory(path: string, mode: number): Promise<void> {
    await mkdir(path, { recursive: true, mode });
  }

  async writeTextAtomic(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  }

  async appendLineDurable(path: string, line: string): ReturnType<FileSystemPort['appendLineDurable']> {
    const before = await stat(path).catch(() => undefined);
    await appendFile(path, `${line}\n`, { mode: 0o600 });
    const after = await stat(path);
    return {
      byteOffset: before?.size ?? 0,
      byteLength: Buffer.byteLength(line, 'utf8'),
      fingerprint: {
        device: String(after.dev),
        inode: String(after.ino),
        size: after.size,
        modifiedAtMs: after.mtimeMs,
      },
    };
  }

  async removeFile(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  async readText(path: string): Promise<string | undefined> {
    return await readFile(path, 'utf8').catch((failure: NodeJS.ErrnoException) => {
      if (failure.code === 'ENOENT') return undefined;
      throw failure;
    });
  }
}
