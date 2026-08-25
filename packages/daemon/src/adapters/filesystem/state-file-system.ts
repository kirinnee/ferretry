import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  type DirectoryEntry,
  type DurableAppend,
  type DurableAppendOutcome,
  type FileInformation,
  type FileSystemFactory,
  type FileSystemPort,
  type FoundationPaths,
  isPathInside,
  type JournalFingerprint,
  temporaryFilePath,
} from '../../lib/index.ts';

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** The kind questions a directory read can answer without touching the entry itself. */
export interface DirectoryEntryKind {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
}

/**
 * What kind of entry this is, decided WITHOUT opening it.
 *
 * Opening is not an option: a FIFO left in the state home would block the caller until somebody
 * wrote to it, turning a classification into a hang. So the directory read's own answer is used,
 * and every non-directory, non-regular kind is simply "not a regular file".
 *
 * The one case worth a syscall is `DT_UNKNOWN`, which some FUSE, overlay and network mounts return
 * for everything: there every predicate is false, and refusing outright would make a perfectly
 * ordinary home unusable on those filesystems. It is resolved with `lstat`, which does not follow a
 * symlink and does not block on a FIFO. If even that cannot establish the kind, the entry is
 * neither a directory nor a regular file — fail closed, never "probably fine".
 */
export async function classifyDirectoryEntry(
  directory: string,
  entry: DirectoryEntryKind,
  lstatAt: (path: string) => Promise<Stats> = lstat,
): Promise<DirectoryEntry> {
  if (entry.isDirectory()) return { name: entry.name, directory: true, regularFile: false };
  if (entry.isFile()) return { name: entry.name, directory: false, regularFile: true };
  if (
    entry.isSymbolicLink() ||
    entry.isFIFO() ||
    entry.isSocket() ||
    entry.isBlockDevice() ||
    entry.isCharacterDevice()
  )
    return { name: entry.name, directory: false, regularFile: false };
  try {
    const kind = await lstatAt(join(directory, entry.name));
    return { name: entry.name, directory: kind.isDirectory(), regularFile: kind.isFile() };
  } catch {
    return { name: entry.name, directory: false, regularFile: false };
  }
}

function namesSameFile(information: Stats, expected: JournalFingerprint): boolean {
  return information.dev.toString() === expected.device && information.ino.toString() === expected.inode;
}

function fingerprintOf(information: Stats): JournalFingerprint {
  return {
    device: information.dev.toString(),
    inode: information.ino.toString(),
    size: information.size,
    modifiedAtMs: Math.trunc(information.mtimeMs),
  };
}

function pathIsInside(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return fromParent === '' || (!fromParent.startsWith(`..${sep}`) && fromParent !== '..' && !isAbsolute(fromParent));
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

  /**
   * Fleet provisioning owns one deliberately narrow class of links beneath the state home: an entry
   * under `fleet/homes` whose whole chain resolves back into one of the two directories the fleet owns
   * and writes.
   *
   * TWO DESTINATIONS, and they are two different contracts rather than one widened rule:
   *
   * - `fleet/shared` is the history pool. The harness owns that state and Ferretry never writes it,
   *   which is what makes a transcript safe to pool.
   * - `fleet/assets` is the asset tree. Ferretry owns it outright and every apply writes it, and the
   *   link is the whole point: an account's `CLAUDE.md` IS the shared document, so editing the document
   *   is editing every account that references it, with no apply in between.
   *
   * The exemption stays narrow in the direction that matters — the SOURCE must be under `fleet/homes`
   * and the resolved TARGET must be inside one of those two — because the invariant this makes a hole
   * in is "no operation follows a link out of the state home". A link pointing anywhere else, including
   * elsewhere in the state home, keeps the blanket refusal below. The complete chain is resolved rather
   * than the one hop, so a planted intermediate link cannot use this to escape either directory, and
   * anything unresolvable fails closed.
   */
  private async isProvisionedFleetLink(path: string): Promise<boolean> {
    const homes = join(this.paths.fleet, 'homes');
    if (path === homes || !pathIsInside(homes, path)) return false;
    try {
      const resolved = await realpath(path);
      return (
        pathIsInside(join(this.paths.fleet, 'shared'), resolved) ||
        pathIsInside(join(this.paths.fleet, 'assets'), resolved)
      );
    } catch {
      // A dangling, unreadable, or cyclic link is not provisioner-owned evidence. Fail closed.
      return false;
    }
  }

  private async checked(path: string): Promise<string> {
    const target = this.contained(path);
    const fromHome = relative(this.paths.home, target);
    let current: string = this.paths.home;
    try {
      const information = await lstat(current);
      if (information.isSymbolicLink() && !(await this.isProvisionedFleetLink(current)))
        throw new Error(`symbolic links are not allowed inside the state home: ${current}`);
    } catch (error) {
      if (isMissing(error)) return target;
      throw error;
    }
    if (fromHome.length === 0) return target;
    for (const component of fromHome.split(sep)) {
      current = join(current, component);
      try {
        const information = await lstat(current);
        if (information.isSymbolicLink() && !(await this.isProvisionedFleetLink(current)))
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
      const checked = await this.checked(path);
      const entries = await readdir(checked, { withFileTypes: true });
      // The kind is asked here, where the directory read already knows it and nothing is followed
      // or opened: a symlink reports as a symlink, so a caller deciding by name cannot be handed
      // somebody else's bytes, and a FIFO cannot make the classification block.
      return await Promise.all(entries.map(async entry => await classifyDirectoryEntry(checked, entry)));
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
      return { ...fingerprintOf(info), mode: info.mode & 0o777 };
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

  async createFileExclusive(path: string, mode: number): Promise<JournalFingerprint> {
    const target = await this.checked(path);
    await this.ensureDirectory(dirname(target), 0o700);
    const handle = await open(target, 'wx', mode);
    let information: Stats;
    try {
      await handle.sync();
      information = await handle.stat();
    } finally {
      await handle.close();
    }
    // The directory entry is the whole point of this call, so it has to be durable too.
    await this.syncDirectory(dirname(target));
    return fingerprintOf(information);
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
        fingerprint: fingerprintOf(after),
      };
    } finally {
      await handle.close();
    }
  }

  async appendLineToExisting(path: string, line: string, expect: JournalFingerprint): Promise<DurableAppendOutcome> {
    const target = await this.checked(path);
    let handle: FileHandle;
    try {
      // No O_CREAT. Creation belongs to createFileExclusive alone, so the call that would write the
      // next event can never be the call that resurrects a journal somebody deleted.
      handle = await open(target, constants.O_RDWR | constants.O_APPEND);
    } catch (error) {
      if (isMissing(error)) return { kind: 'absent' };
      throw error;
    }
    try {
      const before = await handle.stat();
      if (!namesSameFile(before, expect) || before.size !== expect.size) return { kind: 'replaced' };
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
      // The bytes are durable in an inode. Re-stat the PATHNAME to prove it still names THAT inode
      // and grew by exactly this record: an impostor swapped in mid-write, or a foreign appender
      // interleaving with it, would each make the byte offset reported below a lie.
      const named = await this.information(target);
      if (
        named === undefined ||
        named.device !== expect.device ||
        named.inode !== expect.inode ||
        named.size !== before.size + encoded.byteLength
      ) {
        return { kind: 'replaced' };
      }
      return {
        kind: 'appended',
        append: {
          byteOffset: before.size + (needsSeparator ? 1 : 0),
          byteLength: Buffer.byteLength(line, 'utf8'),
          fingerprint: {
            device: named.device,
            inode: named.inode,
            size: named.size,
            modifiedAtMs: named.modifiedAtMs,
          },
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
