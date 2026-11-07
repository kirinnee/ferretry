import type { AgendaId } from '../../lib/protocol/agenda.ts';
import { z } from 'zod';
import type { AgendaSeenStore } from '../../lib/agenda/index.ts';
import type { StateAgendaFiles } from './state-agenda-files.ts';

export { SqliteAgendaVersionStore } from './sqlite-agenda-versions.ts';

const AGENDA_SEEN_FILE = 'agenda-seen.json';

const SeenMarksSchema = z.record(z.string(), z.record(z.string(), z.number().int().nonnegative()));

type Marks = Record<string, Record<string, number>>;

/** The per-device "last seen" marks of a session: `agenda-seen.json`, `{ [deviceId]: { [itemId]: version } }`. */
export class FileAgendaSeenStore implements AgendaSeenStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly files: Pick<StateAgendaFiles, 'read' | 'writeAtomic' | 'rename' | 'file'>,
    private readonly uniqueId: () => string,
    private readonly warn: (message: string) => void,
  ) {}

  /** An absent file holds no marks. One that cannot be read throws: a mark must never be written over marks it could not see. */
  private async load(sessionId: string): Promise<Marks> {
    const text = await this.files.read(sessionId, AGENDA_SEEN_FILE);
    if (text === undefined) return {};
    return SeenMarksSchema.parse(JSON.parse(text));
  }

  /**
   * The marks a mark starts from. A file that was read but is not marks (torn, or not what was written) is set aside as
   * `agenda-seen.json.corrupt-<id>` with a warning and the marks start empty: they are display hints, and the file is
   * kept rather than written over.
   */
  private async loadForMark(sessionId: string): Promise<Marks> {
    try {
      return await this.load(sessionId);
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
      const kept = `${AGENDA_SEEN_FILE}.corrupt-${this.uniqueId()}`;
      await this.files.rename(sessionId, AGENDA_SEEN_FILE, kept);
      this.warn(
        `agenda ${sessionId}: the seen marks could not be understood and were set aside as ${this.files.file(sessionId, kept)}`,
      );
      return {};
    }
  }

  async seen(sessionId: string, id: AgendaId, deviceId: string): Promise<number | undefined> {
    // Only a display hint: marks that cannot be read are none. A mark, which writes the file back, never starts from them.
    const marks = await this.load(sessionId).catch((): Marks => ({}));
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
      await this.files.writeAtomic(sessionId, AGENDA_SEEN_FILE, `${JSON.stringify(next, null, 2)}\n`);
      return standing;
    });
    this.tail = run.catch(() => undefined);
    return await run;
  }
}
