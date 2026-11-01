/**
 * SOLE OWNER of the `fy-board-side-view-v1` browser-storage key: how a ferret's Tasks tab draws its cards,
 * as Cards (one at a time, what needs the owner first), as a Kanban (one column per lane) or as a List (focus,
 * owned, sub-ferrets).
 *
 * One device-wide choice, not per ferret and not per machine: it is a property of the reader's screen. Its
 * shape is `table-view-preference.ts`'s: an injected storage, a defensive parse, a denied storage treated
 * as an ordinary browser condition, one identity-stable snapshot.
 */

/** The sole browser-storage key for the Tasks tab's view. */
export const BOARD_SIDE_VIEW_KEY = 'fy-board-side-view-v1';

export type BoardSideView = 'cards' | 'kanban' | 'list';

/** A device that has never chosen opens on the Cards: the owner's verdicts first. */
export const DEFAULT_BOARD_SIDE_VIEW: BoardSideView = 'cards';

/** Anything but the three known words is the default: a stale or hand-edited value resets cleanly. */
export const parseBoardSideView = (raw: string | null | undefined): BoardSideView =>
  raw === 'list' || raw === 'kanban' || raw === 'cards' ? raw : DEFAULT_BOARD_SIDE_VIEW;

export interface BoardSideViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const browserStorage = (): BoardSideViewStorage | undefined => {
  try {
    const candidate = (globalThis as { localStorage?: BoardSideViewStorage }).localStorage;
    return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

/** The device's Tasks-tab view, shaped for `useSyncExternalStore`. */
export class BoardSideViewStore {
  readonly #storage: BoardSideViewStorage | undefined;
  readonly #listeners = new Set<() => void>();
  #view: BoardSideView | null = null;

  constructor(storage: BoardSideViewStorage | undefined = browserStorage()) {
    this.#storage = storage;
  }

  /** The view in force; the first read hydrates from storage. */
  snapshot = (): BoardSideView => {
    this.#view ??= this.#load();
    return this.#view;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Every Tasks tab on screen follows; a failed write still changes the view for the rest of the tab. */
  set(view: BoardSideView): void {
    if (this.snapshot() === view) return;
    this.#view = view;
    try {
      this.#storage?.setItem(BOARD_SIDE_VIEW_KEY, view);
    } catch {
      // Storage denied (private mode, quota): the in-memory choice still applies.
    }
    for (const listener of this.#listeners) listener();
  }

  #load(): BoardSideView {
    try {
      return parseBoardSideView(this.#storage?.getItem(BOARD_SIDE_VIEW_KEY));
    } catch {
      return DEFAULT_BOARD_SIDE_VIEW;
    }
  }
}

/** The one store a page without an injected one reads. */
export const boardSideView = new BoardSideViewStore();
