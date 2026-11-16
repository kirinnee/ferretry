/**
 * WHETHER A PROJECT USES THE BOARD (`docs/board.md` § The board is opt-in). The owner's decision (2026-11-01):
 * "board is overkill — most ferrets should not use cards or boards — ask before doing that". So a board is OFF
 * unless the owner switched it on, and while it is off a start makes no card and the turn-end check is silent.
 * A card a ferret holds anyway (the owner asked, or its lead handed it one) works as it always did.
 *
 * - **No switch stored means off**, the Unfiled board included.
 * - **Only the owner switches it.** The route refuses a ferret; this service only records what it is told.
 *
 * Pure except {@link BoardSwitchService}, which reads and writes through its store.
 */
import type { BoardProjectId, BoardSwitch } from '../../../contract/index.ts';
import type { BoardSwitchStore } from './ports.ts';

/** Whether a board is on, as the turn-end check and a start ask it. */
export interface BoardSwitchReader {
  isOn(projectId: BoardProjectId): Promise<boolean>;
}

/** One board's switch as the wire reads it; a board nobody switched is off by default. Pure. */
export function switchOf(stored: BoardSwitch | null, projectId: BoardProjectId): BoardSwitch {
  return stored === null ? { projectId, on: false, setBy: 'default', setAt: null } : stored;
}

export class BoardSwitchService implements BoardSwitchReader {
  constructor(
    private readonly store: BoardSwitchStore,
    private readonly clock: { now(): string },
  ) {}

  async read(projectId: BoardProjectId): Promise<BoardSwitch> {
    return switchOf(await this.store.read(projectId), projectId);
  }

  async isOn(projectId: BoardProjectId): Promise<boolean> {
    return (await this.read(projectId)).on;
  }

  /** The owner's switch. The caller has already refused anybody else. */
  async set(projectId: BoardProjectId, on: boolean): Promise<BoardSwitch> {
    return await this.store.set(projectId, on, this.clock.now());
  }
}
