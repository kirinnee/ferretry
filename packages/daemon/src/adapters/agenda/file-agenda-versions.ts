import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgendaId } from '@ferretry/protocol';
import { type AgendaSeenStore, isAgendaSessionId } from '../../lib/agenda/index.ts';

export { AGENDA_VERSIONS_DIRECTORY } from './sqlite-agenda-versions.ts';
export { FileAgendaVersionStore } from './worker-agenda-versions.ts';

const AGENDA_SEEN_FILE = 'agenda-seen.json';

/** The per-device "last seen" marks of a session: `agenda-seen.json`, `{ [deviceId]: { [itemId]: version } }`. */
export class FileAgendaSeenStore implements AgendaSeenStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly sessionDirectory: (sessionId: string) => string,
    private readonly uniqueId: () => string = randomUUID,
  ) {}

  private file(sessionId: string): string {
    if (!isAgendaSessionId(sessionId)) throw new Error(`not a valid agenda session id: ${sessionId}`);
    return join(this.sessionDirectory(sessionId), AGENDA_SEEN_FILE);
  }

  private async load(sessionId: string): Promise<Record<string, Record<string, number>>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file(sessionId), 'utf8'));
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, Record<string, number>>)
        : {};
    } catch {
      return {};
    }
  }

  async seen(sessionId: string, id: AgendaId, deviceId: string): Promise<number | undefined> {
    const mark = (await this.load(sessionId))[deviceId]?.[id];
    return typeof mark === 'number' ? mark : undefined;
  }

  async mark(sessionId: string, id: AgendaId, deviceId: string, version: number): Promise<number> {
    const run = this.tail.then(async () => {
      const marks = await this.load(sessionId);
      const held = marks[deviceId]?.[id];
      const standing = typeof held === 'number' && held > version ? held : version;
      if (standing === held) return standing;
      const next = { ...marks, [deviceId]: { ...marks[deviceId], [id]: standing } };
      const file = this.file(sessionId);
      const temporary = `${file}.${this.uniqueId()}.tmp`;
      await mkdir(this.sessionDirectory(sessionId), { recursive: true, mode: 0o700 });
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return standing;
    });
    this.tail = run.catch(() => undefined);
    return await run;
  }
}
