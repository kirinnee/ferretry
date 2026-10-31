import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import { AgentFileError, type AgentFilesystem } from '../../lib/agent-files/index.ts';

/** The agent file tools' disk, over Node. Created files are never executable and never follow a link. */
export class NodeAgentFilesystem implements AgentFilesystem {
  async realpath(path: string): Promise<string> {
    return await realpath(path);
  }

  async lstat(
    path: string,
  ): Promise<{ readonly kind: 'file' | 'directory' | 'link' | 'other'; readonly size: number } | undefined> {
    try {
      const entry = await lstat(path);
      return {
        kind: entry.isSymbolicLink() ? 'link' : entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
        size: entry.size,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR')
        return undefined;
      throw error;
    }
  }

  async fileSize(path: string): Promise<number | undefined> {
    const entry = await stat(path).catch(() => undefined);
    return entry?.isFile() === true ? entry.size : undefined;
  }

  async mkdirp(path: string, mode: number): Promise<void> {
    await mkdir(path, { recursive: true, mode });
  }

  async writeNew(path: string, bytes: Uint8Array, mode: number): Promise<void> {
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
  }

  async copyNew(from: string, to: string, maxBytes: number): Promise<number> {
    const handle = await open(
      to,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
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
