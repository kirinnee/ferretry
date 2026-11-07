import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type AgendaFileStore, isAgendaSessionId } from '../../lib/agenda/index.ts';

/** Which file this is and how it stands: a rename, an edit or a rewrite changes it. */
const identityOf = (information: Stats): string =>
  `${String(information.dev)}:${String(information.ino)}:${String(information.size)}:${String(information.mtimeMs)}:${String(information.ctimeMs)}`;

/** A session's agenda files, as plain files in its own directory. */
export class FileAgendaFileStore implements AgendaFileStore {
  constructor(
    private readonly sessionDirectory: (sessionId: string) => string,
    private readonly uniqueId: () => string = randomUUID,
  ) {}

  file(sessionId: string, name: string): string {
    if (!isAgendaSessionId(sessionId)) throw new Error(`not a valid agenda session id: ${sessionId}`);
    return join(this.sessionDirectory(sessionId), name);
  }

  async read(sessionId: string, name: string): Promise<string | undefined> {
    try {
      return await readFile(this.file(sessionId, name), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async identity(sessionId: string, name: string): Promise<string | undefined> {
    try {
      return identityOf(await stat(this.file(sessionId, name)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async readIdentified(
    sessionId: string,
    name: string,
  ): Promise<{ readonly text: string; readonly identity: string } | undefined> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.file(sessionId, name), 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      // The identity of the DESCRIPTOR read, not of whatever the name points at a moment later.
      const identity = identityOf(await handle.stat());
      return { text: await handle.readFile('utf8'), identity };
    } finally {
      await handle.close();
    }
  }

  async writeAtomic(sessionId: string, name: string, text: string): Promise<void> {
    const file = this.file(sessionId, name);
    const directory = this.sessionDirectory(sessionId);
    const temporary = join(directory, `.${name.replace(/\.json$/u, '')}-${this.uniqueId()}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
      await this.syncDirectory(directory);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  /** Reads only the uncommitted suffix, never the growing committed history. Offsets count UTF-8 bytes. */
  async readAfter(sessionId: string, name: string, bytes: number): Promise<Uint8Array> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.file(sessionId, name), 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && bytes === 0) return new Uint8Array();
      throw error;
    }
    try {
      const size = (await handle.stat()).size;
      if (size < bytes) throw new Error(`append cursor exceeds file: ${name}`);
      const chunks: Buffer[] = [];
      for await (const chunk of handle.createReadStream({ start: bytes, autoClose: false }))
        chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    } finally {
      await handle.close();
    }
  }

  async appendSynced(sessionId: string, name: string, bytes: Uint8Array): Promise<void> {
    const directory = this.sessionDirectory(sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(this.file(sessionId, name), 'a', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.syncDirectory(directory);
  }

  async truncate(sessionId: string, name: string, bytes: number): Promise<void> {
    const handle = await open(this.file(sessionId, name), 'r+');
    try {
      await handle.truncate(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    await rename(this.file(sessionId, from), this.file(sessionId, to));
  }

  async remove(sessionId: string, name: string): Promise<void> {
    await rm(this.file(sessionId, name), { force: true });
  }
}
