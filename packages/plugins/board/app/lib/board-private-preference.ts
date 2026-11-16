/**
 * SOLE OWNER of the `fy-board-private-v1` browser-storage key: whether this device shows private cards on the
 * Board (the "Show private" toggle). Off until the reader turns it on, then remembered.
 *
 * One device-wide choice, not per machine: it is a property of the reader's screen. A Board link that names
 * the choice (`agents=1` or `agents=0`) wins over it without changing it. Its shape is
 * `board-side-view.ts`'s: an injected storage, a defensive parse, a denied storage treated as an ordinary
 * browser condition, one identity-stable snapshot.
 */

/** The sole browser-storage key for "Show private". */
export const BOARD_PRIVATE_KEY = 'fy-board-private-v1';

/** Anything but `'1'` is off: a stale or hand-edited value resets cleanly. */
export const parseShowPrivate = (raw: string | null | undefined): boolean => raw === '1';

export interface BoardPrivateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const browserStorage = (): BoardPrivateStorage | undefined => {
  try {
    const candidate = (globalThis as { localStorage?: BoardPrivateStorage }).localStorage;
    return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

/** The device's "Show private", shaped for `useSyncExternalStore`. */
export class BoardPrivateStore {
  readonly #storage: BoardPrivateStorage | undefined;
  readonly #listeners = new Set<() => void>();
  #show: boolean | null = null;

  constructor(storage: BoardPrivateStorage | undefined = browserStorage()) {
    this.#storage = storage;
  }

  /** Whether private cards show; the first read hydrates from storage. */
  snapshot = (): boolean => {
    this.#show ??= this.#load();
    return this.#show;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** A failed write still changes the choice for the rest of the tab. */
  set(show: boolean): void {
    if (this.snapshot() === show) return;
    this.#show = show;
    try {
      this.#storage?.setItem(BOARD_PRIVATE_KEY, show ? '1' : '0');
    } catch {
      // Storage denied (private mode, quota): the in-memory choice still applies.
    }
    for (const listener of this.#listeners) listener();
  }

  #load(): boolean {
    try {
      return parseShowPrivate(this.#storage?.getItem(BOARD_PRIVATE_KEY));
    } catch {
      return false;
    }
  }
}

/** The one store the app shares. */
export const boardPrivate = new BoardPrivateStore();
