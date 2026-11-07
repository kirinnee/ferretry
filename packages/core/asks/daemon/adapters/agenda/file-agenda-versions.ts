import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgendaId } from '../../lib/protocol/agenda.ts';
import { z } from 'zod';
import { type AgendaSeenStore, isAgendaSessionId } from '../../lib/agenda/index.ts';

export { AGENDA_VERSIONS_DIRECTORY } from './sqlite-agenda-versions.ts';
export { FileAgendaVersionStore } from './worker-agenda-versions.ts';

const AGENDA_SEEN_FILE = 'agenda-seen.json';

const SeenMarksSchema = z.record(z.string(), z.record(z.string(), z.number().int().nonnegative()));

/** The per-device "last seen" marks of a session: `agenda-seen.json`, `{ [deviceId]: { [itemId]: version } }`. */
export class FileAgendaSeenStore implements AgendaSeenStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly sessionDirectory: (sessionId: string) => string,
    private readonly uniqueId: () => string = randomUUID,
    private readonly warn: (message: string) => void = message => console.warn(message),
  ) {}

  private file(sessionId: string): string {
    if (!isAgendaSessionId(sessionId)) throw new Error(`not a valid agenda session id: ${sessionId}`);
    return join(this.sessionDirectory(sessionId), AGENDA_SEEN_FILE);
  }

  /** An absent file holds no marks. One that cannot be read throws: a mark must never be written over marks it could not see. */
  private async load(sessionId: string): Promise<Record<string, Record<string, number>>> {
    let text: string;
    try {
      text = await readFile(this.file(sessionId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    return SeenMarksSchema.parse(JSON.parse(text));
  }

  /**
   * The marks a mark starts from. A file that was read but is not marks (torn, or not what was written) is set aside as
   * `agenda-seen.json.corrupt-<id>` with a warning and the marks start empty: they are display hints, and the file is
   * kept rather than written over.
   */
  private async loadForMark(sessionId: string): Promise<Record<string, Record<string, number>>> {
    try {
      return await this.load(sessionId);
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
      const file = this.file(sessionId);
      const kept = `${file}.corrupt-${this.uniqueId()}`;
      await rename(file, kept);
      this.warn(`agenda ${sessionId}: the seen marks could not be understood and were set aside as ${kept}`);
      return {};
    }
  }

  async seen(sessionId: string, id: AgendaId, deviceId: string): Promise<number | undefined> {
    // Only a display hint: marks that cannot be read are none. A mark, which writes the file back, never starts from them.
    const marks = await this.load(sessionId).catch((): Record<string, Record<string, number>> => ({}));
    const mark = marks[deviceId]?.[id];
    return typeof mark === 'number' ? mark : undefined;
  }

  async mark(sessionId: string, id: AgendaId, deviceId: string, version: number): Promise<number> {
    const run = this.tail.then(async () => {
      const marks = await this.loadForMark(sessionId);
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
