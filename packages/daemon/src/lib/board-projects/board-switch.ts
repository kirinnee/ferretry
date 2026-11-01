/**
 * WHETHER A PROJECT USES THE BOARD (`docs/board.md` § The board is opt-in). The owner's decision (2026-11-01):
 * "board is overkill — most ferrets should not use tasks or boards — ask before doing that". So a board is OFF
 * unless the owner switched it on, and while it is off a start makes no card and the turn-end check is silent.
 * A card a ferret holds anyway (the owner asked, or its lead handed it one) works as it always did.
 *
 * - **One document** for every board (`<home>/board/switch.json`): its `migratedAt` is the marker that the
 *   one-time pass below ran, so a board with no entry after it is simply off.
 * - **The one-time pass** switches ON exactly the boards where the owner sent a card back (Not good, a
 *   `reopened` event by the owner) in the last {@link MIGRATION_WINDOW_MS}. Everything else, Unfiled always, is
 *   OFF. Only Not good counts because it is the one act no ferret makes: a ferret that runs the CLI without
 *   `FY_SESSION_ID` is recorded as the owner, so "the owner made or moved a card" cannot tell a person from a
 *   ferret (docs/board.md § The board is opt-in, GAP). It runs on the first read, under the store's lock, so
 *   nothing ever reads a board before it is decided.
 * - **Only the owner switches it.** The route refuses a ferret; this service only records what it is told.
 *
 * Pure except {@link BoardSwitchService}, which reads and writes through its ports.
 */
import {
  type BoardProjectId,
  type BoardSwitch,
  type BoardTask,
  InstantSchema,
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';
import { z } from 'zod';

/** How far back the one-time pass looks for the owner's own work on a board. */
export const MIGRATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** The history event only a person makes: the owner's Not good, a reopen. */
const OWNER_WORK: ReadonlySet<string> = new Set(['reopened']);

const BoardSwitchEntrySchema = z.strictObject({
  on: z.boolean(),
  setBy: z.enum(['migration', 'owner']),
  setAt: InstantSchema,
});

export const BoardSwitchDocumentSchema = z.strictObject({
  v: z.literal(1),
  /** When the one-time pass ran: its marker. */
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

/** What the one-time pass reads: every card, and every board there is. */
export interface BoardSwitchEvidence {
  cards(): Promise<readonly Pick<BoardTask, 'projectId' | 'history'>[]>;
  projects(): Promise<readonly BoardProjectId[]>;
}

/** Whether a board is on, as the turn-end check and a start ask it. */
export interface BoardSwitchReader {
  isOn(projectId: BoardProjectId): Promise<boolean>;
}

/**
 * The boards the owner worked on since `since`: a card the owner sent back (Not good). Unfiled is never one of
 * them. Pure and total.
 */
export function ownerWorkedBoards(
  cards: readonly Pick<BoardTask, 'projectId' | 'history'>[],
  since: number,
): ReadonlySet<BoardProjectId> {
  const worked = new Set<BoardProjectId>();
  for (const card of cards) {
    if (card.projectId === UNFILED_PROJECT_ID || worked.has(card.projectId)) continue;
    const recent = card.history.some(
      event => event.actor.kind === 'owner' && OWNER_WORK.has(event.type) && Date.parse(event.at) >= since,
    );
    if (recent) worked.add(card.projectId);
  }
  return worked;
}

/** The one-time pass's document: an entry for every board, on exactly where the owner worked. Pure. */
export function migratedDocument(
  boards: readonly BoardProjectId[],
  worked: ReadonlySet<BoardProjectId>,
  at: string,
): BoardSwitchDocument {
  const entries: Record<string, z.infer<typeof BoardSwitchEntrySchema>> = {};
  for (const id of new Set([UNFILED_PROJECT_ID, ...boards]))
    entries[id] = { on: worked.has(id), setBy: 'migration', setAt: at };
  return { v: 1, migratedAt: at, boards: entries };
}

/** One board's switch as the wire reads it; a board with no entry is off by default. Pure. */
export function switchOf(document: BoardSwitchDocument, projectId: BoardProjectId): BoardSwitch {
  const entry = document.boards[projectId];
  return entry === undefined
    ? { projectId, on: false, setBy: 'default', setAt: null }
    : { projectId, on: entry.on, setBy: entry.setBy, setAt: entry.setAt };
}

/** What the one-time pass decided, for the boot log. */
export interface BoardSwitchMigration {
  readonly migratedAt: string;
  readonly on: readonly BoardProjectId[];
  readonly off: readonly BoardProjectId[];
}

export class BoardSwitchService implements BoardSwitchReader {
  constructor(
    private readonly store: BoardSwitchStore,
    private readonly evidence: BoardSwitchEvidence,
    private readonly clock: { now(): string },
  ) {}

  /** Runs the one-time pass if it has not run; `null` when it already had. */
  async migrate(): Promise<BoardSwitchMigration | null> {
    if ((await this.store.read()) !== null) return null;
    const now = this.clock.now();
    const since = Date.parse(now) - MIGRATION_WINDOW_MS;
    const worked = ownerWorkedBoards(await this.evidence.cards(), since);
    const boards = await this.evidence.projects();
    return await this.store.transact<BoardSwitchMigration | null>(current => {
      if (current !== null) return { result: null };
      const next = migratedDocument(boards, worked, now);
      const ids = Object.keys(next.boards);
      return {
        next,
        result: {
          migratedAt: now,
          on: ids.filter(id => next.boards[id]?.on === true),
          off: ids.filter(id => next.boards[id]?.on !== true),
        },
      };
    });
  }

  async read(projectId: BoardProjectId): Promise<BoardSwitch> {
    return switchOf(await this.document(), projectId);
  }

  async isOn(projectId: BoardProjectId): Promise<boolean> {
    return (await this.read(projectId)).on;
  }

  /** The owner's switch. The caller has already refused anybody else. */
  async set(projectId: BoardProjectId, on: boolean): Promise<BoardSwitch> {
    await this.migrate();
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
    if (stored !== null) return stored;
    await this.migrate();
    return (await this.store.read()) ?? { v: 1, migratedAt: this.clock.now(), boards: {} };
  }
}
