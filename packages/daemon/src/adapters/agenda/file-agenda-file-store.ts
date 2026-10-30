import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AgendaFileStore, isAgendaSessionId } from '../../lib/agenda/index.ts';

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

  async writeAtomic(sessionId: string, name: string, text: string): Promise<void> {
    const file = this.file(sessionId, name);
    const directory = this.sessionDirectory(sessionId);
    const temporary = join(directory, `.${name.replace(/\.json$/u, '')}-${this.uniqueId()}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    await rename(this.file(sessionId, from), this.file(sessionId, to));
  }

  async remove(sessionId: string, name: string): Promise<void> {
    await rm(this.file(sessionId, name), { force: true });
  }
}
