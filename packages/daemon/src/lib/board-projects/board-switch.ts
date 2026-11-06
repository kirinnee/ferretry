/**
 * WHETHER A PROJECT USES THE BOARD (`docs/board.md` § The board is opt-in). The owner's decision (2026-11-01):
 * "board is overkill — most ferrets should not use tasks or boards — ask before doing that". So a board is OFF
 * unless the owner switched it on, and while it is off a start makes no card and the turn-end check is silent.
 * A card a ferret holds anyway (the owner asked, or its lead handed it one) works as it always did.
 *
 * - **One document** for every board (`<home>/board/switch.json`). A home with no document reads every board
 *   OFF, Unfiled included; a board with no entry is OFF too. Its `migratedAt` and an entry's `setBy: 'migration'`
 *   stay readable because documents written earlier carry them.
 * - **Only the owner switches it.** The route refuses a ferret; this service only records what it is told.
 *
 * Pure except {@link BoardSwitchService}, which reads and writes through its ports.
 */
import { type BoardProjectId, type BoardSwitch, InstantSchema } from '@ferretry/protocol';
import { z } from 'zod';

const BoardSwitchEntrySchema = z.strictObject({
  on: z.boolean(),
  setBy: z.enum(['migration', 'owner']),
  setAt: InstantSchema,
});

export const BoardSwitchDocumentSchema = z.strictObject({
  v: z.literal(1),
  /** A timestamp the document keeps: set at the first switch write on a home that had none. */
  migratedAt: InstantSchema,
  boards: z.record(z.string(), BoardSwitchEntrySchema),
});
export type BoardSwitchDocument = z.infer<typeof BoardSwitchDocumentSchema>;

/** What a transaction on the switch document decided: the document to keep (or `undefined`) and its answer. */
export interface BoardSwitchMutation<T> {
  readonly next?: BoardSwitchDocument;
  readonly result: T;
}

/** The one switch document. A damaged one is refused, never overwritten. */
export interface BoardSwitchStore {
  read(): Promise<BoardSwitchDocument | null>;
  transact<T>(decide: (current: BoardSwitchDocument | null) => BoardSwitchMutation<T>): Promise<T>;
}

/** Whether a board is on, as the turn-end check and a start ask it. */
export interface BoardSwitchReader {
  isOn(projectId: BoardProjectId): Promise<boolean>;
}

/** One board's switch as the wire reads it; a board with no entry is off by default. Pure. */
export function switchOf(document: BoardSwitchDocument, projectId: BoardProjectId): BoardSwitch {
  const entry = document.boards[projectId];
  return entry === undefined
    ? { projectId, on: false, setBy: 'default', setAt: null }
    : { projectId, on: entry.on, setBy: entry.setBy, setAt: entry.setAt };
}

export class BoardSwitchService implements BoardSwitchReader {
  constructor(
    private readonly store: BoardSwitchStore,
    private readonly clock: { now(): string },
  ) {}

  async read(projectId: BoardProjectId): Promise<BoardSwitch> {
    return switchOf(await this.document(), projectId);
  }

  async isOn(projectId: BoardProjectId): Promise<boolean> {
    return (await this.read(projectId)).on;
  }

  /** The owner's switch. The caller has already refused anybody else. */
  async set(projectId: BoardProjectId, on: boolean): Promise<BoardSwitch> {
    const at = this.clock.now();
    return await this.store.transact<BoardSwitch>(current => {
      const base = current ?? { v: 1 as const, migratedAt: at, boards: {} };
      const next: BoardSwitchDocument = {
        ...base,
        boards: { ...base.boards, [projectId]: { on, setBy: 'owner', setAt: at } },
      };
      return { next, result: switchOf(next, projectId) };
    });
  }

  private async document(): Promise<BoardSwitchDocument> {
    const stored = await this.store.read();
    return stored ?? { v: 1, migratedAt: this.clock.now(), boards: {} };
  }
}
