import { type BigIntStats, constants, createReadStream } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import {
  AgentFileError,
  type AgentFileIdentity,
  type AgentFilesystem,
  type AgentOpenFile,
} from '../../lib/agent-files/index.ts';

const NEW_FILE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const COPY_CHUNK_BYTES = 64 * 1024;

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR';

function identityOf(entry: BigIntStats): AgentFileIdentity {
  return {
    kind: entry.isSymbolicLink() ? 'link' : entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
    device: entry.dev,
    inode: entry.ino,
    links: Number(entry.nlink),
    size: Number(entry.size),
  };
}

/** A file opened to read; a copy reads THIS descriptor, never the path again. */
class NodeOpenFile implements AgentOpenFile {
  constructor(
    private readonly handle: FileHandle,
    readonly identity: AgentFileIdentity,
  ) {}

  async copyTo(to: string, maxBytes: number): Promise<number> {
    const target = await open(to, NEW_FILE_FLAGS, 0o600);
    const buffer = new Uint8Array(COPY_CHUNK_BYTES);
    let written = 0;
    try {
      for (;;) {
        const { bytesRead } = await this.handle.read(buffer, 0, buffer.byteLength, written);
        if (bytesRead === 0) break;
        written += bytesRead;
        if (written > maxBytes) throw new AgentFileError('bad_request', 'that file grew past the upload size limit');
        await target.write(buffer, 0, bytesRead);
      }
    } finally {
      await target.close();
    }
    return written;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

/** The agent file tools' disk, over Node. Created files are never executable and never follow a link. */
export class NodeAgentFilesystem implements AgentFilesystem {
  async realpath(path: string): Promise<string> {
    return await realpath(path);
  }

  async lstat(
    path: string,
  ): Promise<{ readonly kind: 'file' | 'directory' | 'link' | 'other'; readonly size: number } | undefined> {
    const entry = await this.identity(path);
    return entry === undefined ? undefined : { kind: entry.kind, size: entry.size };
  }

  async identity(path: string): Promise<AgentFileIdentity | undefined> {
    try {
      return identityOf(await lstat(path, { bigint: true }));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async openRead(path: string): Promise<AgentOpenFile> {
    // NOFOLLOW: a link at the last step is refused, not followed. NONBLOCK: a pipe opens at once, then is refused as not a file.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let opened: NodeOpenFile | undefined;
    try {
      opened = new NodeOpenFile(handle, identityOf(await handle.stat({ bigint: true })));
      return opened;
    } finally {
      if (opened === undefined) await handle.close();
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

  async mkdirp(path: string, mode: number): Promise<void> {
    await mkdir(path, { recursive: true, mode });
  }

  async writeNew(path: string, bytes: Uint8Array, mode: number): Promise<void> {
    const handle = await open(path, NEW_FILE_FLAGS, mode);
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
  }

  async copyNew(from: string, to: string, maxBytes: number): Promise<number> {
    const handle = await open(to, NEW_FILE_FLAGS, 0o644);
    let written = 0;
    try {
      for await (const chunk of createReadStream(from)) {
        const bytes = chunk as Uint8Array;
        written += bytes.byteLength;
        if (written > maxBytes) throw new AgentFileError('bad_request', 'that file is over the save size limit');
        await handle.write(bytes);
      }
    } finally {
      await handle.close();
    }
    return written;
  }

  async remove(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    await rm(path, { force: true, recursive: options?.recursive === true });
  }
}
