import { randomUUID } from 'node:crypto';
import { chmod, type FileHandle, lstat, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import {
  type DirectoryEntry,
  type DurableAppend,
  type FileInformation,
  type FileSystemFactory,
  type FileSystemPort,
  type FoundationPaths,
  isPathInside,
  temporaryFilePath,
} from '../../lib/index.ts';

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export class StateFileSystem implements FileSystemPort {
  constructor(
    private readonly paths: FoundationPaths,
    private readonly uniqueId: () => string = randomUUID,
  ) {}

  private contained(path: string): string {
    if (!isPathInside(this.paths.home, path)) throw new Error(`path is outside the state home: ${path}`);
    return path;
  }

  private async checked(path: string): Promise<string> {
    const target = this.contained(path);
    const fromHome = relative(this.paths.home, target);
    if (fromHome.length === 0) return target;
    let current: string = this.paths.home;
    for (const component of fromHome.split(sep)) {
      current = join(current, component);
      try {
        const information = await lstat(current);
        if (information.isSymbolicLink())
          throw new Error(`symbolic links are not allowed inside the state home: ${current}`);
      } catch (error) {
        if (isMissing(error)) break;
        throw error;
      }
    }
    return target;
  }

  async ensureDirectory(path: string, mode: number): Promise<void> {
    const target = await this.checked(path);
    await mkdir(target, { recursive: true, mode });
    await this.checked(target);
    await chmod(target, mode);
  }

  async setMode(path: string, mode: number): Promise<void> {
    await chmod(await this.checked(path), mode);
  }

  async listDirectory(path: string): Promise<readonly DirectoryEntry[]> {
    try {
      const entries = await readdir(await this.checked(path), { withFileTypes: true });
      return entries.map(entry => ({ name: entry.name, directory: entry.isDirectory() }));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async readText(path: string): Promise<string | undefined> {
    try {
      return await readFile(await this.checked(path), 'utf8');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async *readChunks(path: string, chunkSize: number, offset = 0): AsyncIterable<Uint8Array> {
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error('chunk size must be a positive integer');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
    let handle: FileHandle;
    try {
      handle = await open(await this.checked(path), 'r');
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    try {
      let position = offset;
      while (true) {
        const buffer = Buffer.allocUnsafe(chunkSize);
        const { bytesRead } = await handle.read(buffer, 0, chunkSize, position);
        if (bytesRead === 0) return;
        position += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    } finally {
      await handle.close();
    }
  }

  async readSlice(path: string, offset: number, length: number): Promise<Uint8Array | undefined> {
    let handle: FileHandle;
    try {
      handle = await open(await this.checked(path), 'r');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    try {
      const buffer = Buffer.alloc(length);
      let total = 0;
      while (total < length) {
        const { bytesRead } = await handle.read(buffer, total, length - total, offset + total);
        if (bytesRead === 0) return undefined;
        total += bytesRead;
      }
      return buffer;
    } finally {
      await handle.close();
    }
  }

  async information(path: string): Promise<FileInformation | undefined> {
    try {
      const info = await stat(await this.checked(path));
      return {
        device: info.dev.toString(),
        inode: info.ino.toString(),
        size: info.size,
        modifiedAtMs: Math.trunc(info.mtimeMs),
        mode: info.mode & 0o777,
      };
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(await this.checked(path), 'r');
    try {
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM') throw error;
    } finally {
      await handle.close();
    }
  }

  async writeTextAtomic(path: string, text: string): Promise<void> {
    const target = await this.checked(path);
    await this.ensureDirectory(dirname(target), 0o700);
    await this.ensureDirectory(this.paths.temporary, 0o700);
    const temporary = temporaryFilePath(this.paths, target, this.uniqueId());
    let handle: FileHandle | undefined;
    try {
      handle = await open(await this.checked(temporary), 'wx', 0o600);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      await chmod(target, 0o600);
      await this.syncDirectory(dirname(target));
      if (dirname(target) !== this.paths.temporary) await this.syncDirectory(this.paths.temporary);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async appendLineDurable(path: string, line: string): Promise<DurableAppend> {
    const target = await this.checked(path);
    await this.ensureDirectory(dirname(target), 0o700);
    const existed = (await this.information(target)) !== undefined;
    const handle = await open(target, 'a+', 0o600);
    try {
      const before = await handle.stat();
      let needsSeparator = false;
      if (before.size > 0) {
        const last = new Uint8Array(1);
        await handle.read(last, 0, 1, before.size - 1);
        needsSeparator = last[0] !== 0x0a;
      }
      const encoded = Buffer.from(`${needsSeparator ? '\n' : ''}${line}\n`, 'utf8');
      await handle.writeFile(encoded);
      await handle.chmod(0o600);
      await handle.sync();
      const after = await handle.stat();
      if (!existed) await this.syncDirectory(dirname(target));
      return {
        byteOffset: before.size + (needsSeparator ? 1 : 0),
        byteLength: Buffer.byteLength(line, 'utf8'),
        fingerprint: {
          device: after.dev.toString(),
          inode: after.ino.toString(),
          size: after.size,
          modifiedAtMs: Math.trunc(after.mtimeMs),
        },
      };
    } finally {
      await handle.close();
    }
  }

  async removeFile(path: string): Promise<void> {
    await rm(await this.checked(path), { force: true });
  }

  async sweepTemporaryFiles(): Promise<void> {
    const entries = await this.listDirectory(this.paths.temporary);
    await Promise.all(
      entries
        .filter(entry => entry.name.endsWith('.tmp'))
        .map(
          async entry =>
            await rm(await this.checked(join(this.paths.temporary, entry.name)), {
              force: true,
              recursive: entry.directory,
            }),
        ),
    );
  }
}

export class StateFileSystemFactory implements FileSystemFactory {
  constructor(private readonly uniqueId: () => string = randomUUID) {}

  create(paths: FoundationPaths): FileSystemPort {
    return new StateFileSystem(paths, this.uniqueId);
  }
}
