import { join } from 'node:path';
import {
  type BoardQuarantinedCard,
  type BoardTask,
  type BoardTaskId,
  BoardTaskSchema,
  MAX_BOARD_REASON_LENGTH,
  type TaskKind,
  taskIdPrefix,
} from '@ferretry/protocol';
import { z } from 'zod';
import {
  type BoardDiagnostics,
  type BoardSnapshot,
  type BoardStore,
  BoardUnavailableError,
  type BoardWrite,
} from '../../lib/board/index.ts';
import type { FileSystemPort, SerialExecutor } from '../../lib/index.ts';

/** The serial key the id counter shares; card keys are `board:card:<id>`. */
const COUNTER_SECTION = 'board:counters';
const CARD_FILE = /^([BFIC][1-9][0-9]{0,8})\.json$/u;
const MAX_COUNTER = 999_999_999;

const CountersSchema = z
  .object({
    B: z.number().int().min(0).max(MAX_COUNTER),
    F: z.number().int().min(0).max(MAX_COUNTER),
    I: z.number().int().min(0).max(MAX_COUNTER),
    C: z.number().int().min(0).max(MAX_COUNTER),
  })
  .partial();
type Counters = z.infer<typeof CountersSchema>;

interface Loaded {
  readonly cards: Map<BoardTaskId, BoardTask>;
  readonly quarantined: Map<BoardTaskId, string>;
}

/** A short account of why a card file did not parse. Never a path: it goes to the API. */
const problemOf = (error: unknown): string => {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
    return `the card does not match the board schema (${where}${issue?.message ?? 'unknown problem'})`;
  }
  return 'the card file is not valid JSON';
};

const clip = (text: string): string =>
  text.length <= MAX_BOARD_REASON_LENGTH ? text : `${text.slice(0, MAX_BOARD_REASON_LENGTH - 1)}…`;

/**
 * The board's source of truth: ONE JSON FILE PER CARD, `<board>/tasks/<id>.json` (the card and its whole
 * history), plus the machine-wide id counter `<board>/counters.json`.
 *
 * - **Writes are atomic** (the state filesystem's write-then-rename) and **serialized per card**, so two
 *   writes to one card never interleave and writes to different cards never wait on each other.
 * - **A damaged card is quarantined, never fatal.** A file that does not parse is left exactly where it
 *   is, excluded from every read, reported in each read's `quarantined` and to the diagnostics once, and
 *   refused by {@link write}: overwriting it would replace the evidence with a card rebuilt from
 *   nothing. One bad card never takes the board down — the opposite of the v1 fleet read, on purpose.
 * - **Ids are never reused.** The counter is the floor, and the highest id already on disk (quarantined
 *   files included) is too, so a lost or damaged counter skips numbers instead of handing one out twice.
 *
 * The cards are read from disk once, on first use, and kept in memory: every write goes through this
 * store, so memory and disk agree. That copy is the board's query projection; it is rebuilt from the
 * files at every boot, so losing it loses nothing.
 *
 * **An edit made outside this daemon is noticed** ({@link noticeOutsideEdits}): the store remembers the
 * identity of every card file as it last read or wrote it, and a change to the directory re-reads only the
 * files whose identity moved — under that card's serial section, so it never races a write. A hand edit
 * that no longer parses is quarantined exactly as it would be at boot, and a file removed by hand leaves
 * the board as it would at the next boot.
 */
export class FileBoardStore implements BoardStore {
  private loading: Promise<Loaded> | undefined;
  /** Each card file's identity as this store last read or wrote it: what proves an outside edit. */
  private readonly identities = new Map<BoardTaskId, string>();
  /** A scan in flight, and whether another change arrived while it ran. */
  private scanning: Promise<readonly BoardTaskId[]> | undefined;
  private rescan = false;
  private readonly tasks: string;
  private readonly counters: string;

  constructor(
    directory: string,
    private readonly files: FileSystemPort,
    private readonly serial: SerialExecutor,
    private readonly diagnostics: BoardDiagnostics,
  ) {
    this.tasks = join(directory, 'tasks');
    this.counters = join(directory, 'counters.json');
  }

  async read(): Promise<BoardSnapshot> {
    const loaded = await this.load();
    return {
      cards: [...loaded.cards.values()],
      quarantined: [...loaded.quarantined].map(([id, reason]): BoardQuarantinedCard => ({ id, reason })),
    };
  }

  async allocateId(kind: TaskKind): Promise<BoardTaskId> {
    const prefix = taskIdPrefix(kind) as keyof Counters;
    return await this.serial.run(COUNTER_SECTION, async () => {
      const loaded = await this.load();
      const counters = await this.readCounters();
      const onDisk = [...loaded.cards.keys(), ...loaded.quarantined.keys()]
        .filter(id => id.startsWith(prefix))
        .map(id => Number(id.slice(1)));
      const next = Math.max(counters[prefix] ?? 0, ...onDisk) + 1;
      if (next > MAX_COUNTER) throw new BoardUnavailableError(`the ${prefix} id counter is exhausted`);
      await this.files.writeTextAtomic(this.counters, `${JSON.stringify({ ...counters, [prefix]: next })}\n`);
      return `${prefix}${next}`;
    });
  }

  async write<T>(id: BoardTaskId, decide: (current: BoardTask | undefined) => Promise<BoardWrite<T>>): Promise<T> {
    return await this.serial.run(`board:card:${id}`, async () => {
      const loaded = await this.load();
      if (loaded.quarantined.has(id)) {
        throw new BoardUnavailableError(`card ${id} is quarantined; refusing to overwrite the damaged file`);
      }
      const decision = await decide(loaded.cards.get(id));
      if (decision.task === null) return decision.result;
      if (decision.task.id !== id)
        throw new BoardUnavailableError(`a write to ${id} tried to store ${decision.task.id}`);
      const task = BoardTaskSchema.parse(decision.task);
      await this.files.writeTextAtomic(this.fileOf(id), `${JSON.stringify(task, null, 2)}\n`);
      loaded.cards.set(id, task);
      await this.remember(id);
      return decision.result;
    });
  }

  /**
   * Re-reads every card file changed since this store last read or wrote it, and drops a card whose file
   * is gone; returns the ids it changed. Nothing before the first read (the first read is current), and
   * nothing on a filesystem that cannot report identities. Calls that arrive during a scan coalesce into
   * one more scan after it, so a burst of edits costs two directory walks, not one per edit.
   */
  async noticeOutsideEdits(): Promise<readonly BoardTaskId[]> {
    if (this.scanning !== undefined) {
      this.rescan = true;
      return await this.scanning;
    }
    this.scanning = (async () => {
      const changed = new Set<BoardTaskId>();
      do {
        this.rescan = false;
        for (const id of await this.scan()) changed.add(id);
      } while (this.rescan);
      return [...changed];
    })().finally(() => {
      this.scanning = undefined;
    });
    return await this.scanning;
  }

  /**
   * Hears the card directory through `subscribe` and notices each outside edit as it lands. Returns the
   * unsubscribe. A scan that fails is reported and retried by the next change.
   */
  watch(subscribe: (directory: string, listener: () => void) => { close(): void }): () => void {
    const subscription = subscribe(this.tasks, () => {
      void this.noticeOutsideEdits().catch((error: unknown) =>
        this.diagnostics.warn(
          `the board could not re-read its card files: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });
    return () => subscription.close();
  }

  private async scan(): Promise<readonly BoardTaskId[]> {
    const identity = this.files.identity?.bind(this.files);
    if (this.loading === undefined || identity === undefined) return [];
    const loaded = await this.load();
    const entries = await this.files.listDirectory(this.tasks);
    const onDisk = new Set<BoardTaskId>();
    const changed: BoardTaskId[] = [];
    for (const entry of entries) {
      const id = CARD_FILE.exec(entry.name)?.[1];
      if (id === undefined || entry.regularFile !== true) continue;
      onDisk.add(id);
      if ((await identity(this.fileOf(id))) === this.identities.get(id)) continue;
      if (await this.reread(id, loaded)) changed.push(id);
    }
    for (const id of [...loaded.cards.keys(), ...loaded.quarantined.keys()]) {
      if (onDisk.has(id)) continue;
      await this.serial.run(`board:card:${id}`, async () => {
        if ((await identity(this.fileOf(id))) !== undefined) return;
        loaded.cards.delete(id);
        loaded.quarantined.delete(id);
        this.identities.delete(id);
        changed.push(id);
      });
    }
    return changed;
  }

  /** One card file read again after it changed under the store; whether the board's copy moved. */
  private async reread(id: BoardTaskId, loaded: Loaded): Promise<boolean> {
    return await this.serial.run(`board:card:${id}`, async () => {
      // Asked again inside the section: a write of our own that raced the watch has remembered its file by now.
      if ((await this.files.identity?.(this.fileOf(id))) === this.identities.get(id)) return false;
      const before = loaded.cards.get(id);
      const fresh = new Map<BoardTaskId, BoardTask>();
      const problem = await this.parseCard(id, fresh);
      const card = fresh.get(id);
      if (card !== undefined) {
        loaded.cards.set(id, card);
        loaded.quarantined.delete(id);
        return true;
      }
      if (problem === undefined) return false;
      loaded.cards.delete(id);
      loaded.quarantined.set(id, clip(problem));
      this.diagnostics.warn(`board card ${id} is quarantined: ${problem}`);
      return before !== undefined;
    });
  }

  /** Records the identity of the card file as it stands now. */
  private async remember(id: BoardTaskId): Promise<void> {
    const now = await this.files.identity?.(this.fileOf(id));
    if (now === undefined) this.identities.delete(id);
    else this.identities.set(id, now);
  }

  private fileOf(id: BoardTaskId): string {
    return join(this.tasks, `${id}.json`);
  }

  private load(): Promise<Loaded> {
    this.loading ??= this.loadFromDisk().catch((error: unknown) => {
      // A failed first read is retried by the next caller rather than cached as the board forever.
      this.loading = undefined;
      throw error;
    });
    return this.loading;
  }

  private async loadFromDisk(): Promise<Loaded> {
    const cards = new Map<BoardTaskId, BoardTask>();
    const quarantined = new Map<BoardTaskId, string>();
    const entries = await this.files.listDirectory(this.tasks);
    for (const entry of entries) {
      const id = CARD_FILE.exec(entry.name)?.[1];
      if (id === undefined || entry.regularFile !== true) continue;
      const problem = await this.parseCard(id, cards);
      if (problem !== undefined) {
        quarantined.set(id, clip(problem));
        this.diagnostics.warn(`board card ${id} is quarantined: ${problem}`);
      }
    }
    return { cards, quarantined };
  }

  /** Reads one card into `cards`, or says why it cannot. */
  private async parseCard(id: BoardTaskId, cards: Map<BoardTaskId, BoardTask>): Promise<string | undefined> {
    const read =
      this.files.readTextIdentified === undefined
        ? await this.files
            .readText(this.fileOf(id))
            .then(text => (text === undefined ? undefined : { text, identity: undefined }))
        : await this.files.readTextIdentified(this.fileOf(id));
    if (read === undefined) return undefined;
    // Remembered before parsing: a damaged file is not re-read until it changes again.
    if (read.identity === undefined) this.identities.delete(id);
    else this.identities.set(id, read.identity);
    const text = read.text;
    try {
      const task = BoardTaskSchema.parse(JSON.parse(text));
      if (task.id !== id) return `the file is named ${id} but holds card ${task.id}`;
      cards.set(id, task);
      return undefined;
    } catch (error) {
      return problemOf(error);
    }
  }

  /** The counter. Damage reads as zero: the ids already on disk are the floor that prevents reuse. */
  private async readCounters(): Promise<Counters> {
    const text = await this.files.readText(this.counters);
    if (text === undefined) return {};
    try {
      return CountersSchema.parse(JSON.parse(text));
    } catch {
      this.diagnostics.warn('the board id counter is damaged; continuing from the highest id on disk');
      return {};
    }
  }
}
