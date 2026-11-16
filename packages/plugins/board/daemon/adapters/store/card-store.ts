import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import {
  type BoardQuarantinedCard,
  type Card,
  CARD_ID_PATTERN,
  CardSchema,
  type CardId,
  type CardKind,
  type CountersFileSchema,
  MAX_BOARD_REASON_LENGTH,
} from '../../../contract/index.ts';
import type { z } from 'zod';
import { CARD_KIND_PREFIX } from '../../../contract/index.ts';
import {
  type BoardDiagnostics,
  type BoardSnapshot,
  type BoardStore,
  BoardUnavailableError,
  type BoardWrite,
} from '../../lib/board/index.ts';
import type { SerialRun } from '../../lib/lanes/serial.ts';

type Counters = z.infer<typeof CountersFileSchema>;

/** The card files and the id counter, as the manifest declares them. */
export interface CardStoreFiles {
  readonly cards: StateFileDef<string, Card>;
  readonly counters: StateFileDef<string, Counters>;
}

const COUNTER_SECTION = 'board:counters';
const MAX_COUNTER = 999_999_999;

const clip = (text: string): string =>
  text.length <= MAX_BOARD_REASON_LENGTH ? text : `${text.slice(0, MAX_BOARD_REASON_LENGTH - 1)}…`;

interface Loaded {
  readonly cards: Map<CardId, Card>;
  readonly quarantined: Map<CardId, string>;
}

/**
 * The board's source of truth: ONE FILE PER CARD (`state/board/cards/<id>.json`, the card and its whole history) and
 * the machine-wide id counter (`counters.json`), both through the kernel's state port (atomic, format-first).
 *
 * - **Writes are serialized per card**, so two writes to one card never interleave and writes to different cards never
 *   wait on each other.
 * - **A damaged card is quarantined, never fatal.** A file the state port calls damaged is left exactly where it is,
 *   excluded from every read, reported in each read's `quarantined` and to the diagnostics once, and refused by
 *   {@link write}: overwriting it would replace the evidence with a card rebuilt from nothing.
 * - **Ids are never reused.** The counter is the floor, and the highest id already on disk (quarantined files included)
 *   is too, so a lost or damaged counter skips numbers instead of handing one out twice.
 *
 * The cards are read once, on first use, and kept in memory: every write goes through this store, so memory and disk
 * agree. That copy is the board's query projection and is rebuilt from the files at every start.
 */
export class KernelCardStore implements BoardStore {
  private loading: Promise<Loaded> | undefined;

  constructor(
    private readonly state: StatePort,
    private readonly files: CardStoreFiles,
    private readonly serial: SerialRun,
    private readonly diagnostics: BoardDiagnostics,
  ) {}

  async read(): Promise<BoardSnapshot> {
    const loaded = await this.load();
    return {
      cards: [...loaded.cards.values()],
      quarantined: [...loaded.quarantined].map(([id, reason]): BoardQuarantinedCard => ({ id, reason })),
    };
  }

  async allocateId(kind: CardKind): Promise<CardId> {
    const prefix = CARD_KIND_PREFIX[kind];
    return await this.serial.run(COUNTER_SECTION, async () => {
      const loaded = await this.load();
      const onDisk = [...loaded.cards.keys(), ...loaded.quarantined.keys()]
        .filter(id => id.startsWith(prefix))
        .map(id => Number(id.slice(1)));
      let allocated = 0;
      const result = await this.state.update(this.files.counters, current => {
        const next = Math.max(current?.next[kind] ?? 1, ...onDisk.map(number => number + 1));
        allocated = next;
        return { format: 1 as const, next: { ...fresh(), ...current?.next, [kind]: next + 1 } };
      });
      // A damaged counter file is replaced from the highest id on disk: it holds no card, only a floor.
      if (!result.ok) {
        const next = Math.max(...onDisk, 0) + 1;
        allocated = next;
        await this.state.write(this.files.counters, { format: 1, next: { ...fresh(), [kind]: next + 1 } });
        this.diagnostics.warn('the board id counter was damaged; it was started again above the highest card on disk');
      }
      if (allocated > MAX_COUNTER) throw new BoardUnavailableError(`the ${prefix} id counter is exhausted`);
      return `${prefix}${allocated}` as CardId;
    });
  }

  async write<T>(id: CardId, decide: (current: Card | undefined) => Promise<BoardWrite<T>>): Promise<T> {
    return await this.serial.run(`board:card:${id}`, async () => {
      const loaded = await this.load();
      if (loaded.quarantined.has(id))
        throw new BoardUnavailableError(`card ${id} is quarantined; refusing to overwrite the damaged file`);
      const decision = await decide(loaded.cards.get(id));
      if (decision.task === null) return decision.result;
      if (decision.task.id !== id)
        throw new BoardUnavailableError(`a write to ${id} tried to store ${decision.task.id}`);
      const card = CardSchema.parse(decision.task);
      await this.state.write(this.files.cards, card, id);
      loaded.cards.set(id, card);
      return decision.result;
    });
  }

  private async load(): Promise<Loaded> {
    this.loading ??= this.readAll().catch((error: unknown) => {
      this.loading = undefined;
      throw error;
    });
    return await this.loading;
  }

  private async readAll(): Promise<Loaded> {
    const loaded: Loaded = { cards: new Map(), quarantined: new Map() };
    for (const name of await this.state.list(this.files.cards)) {
      if (!CARD_ID_PATTERN.test(name)) continue;
      const id = name as CardId;
      const read = await this.state.read(this.files.cards, name);
      if (read.ok && read.value !== undefined && read.value.id === id) loaded.cards.set(id, read.value);
      else if (read.ok && read.value === undefined) continue;
      else {
        const why = read.ok ? 'the card file names another card' : read.error.sentence;
        loaded.quarantined.set(id, clip(why));
        this.diagnostics.warn(`board card ${id} is quarantined: ${why}`);
      }
    }
    return loaded;
  }
}

const fresh = (): Counters['next'] => ({ bug: 1, feature: 1, infra: 1, chore: 1 });
