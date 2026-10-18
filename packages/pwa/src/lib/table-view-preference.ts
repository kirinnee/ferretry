/**
 * SOLE OWNER of the `fy-md-table-view-v1` browser-storage key: how a phone shows a Markdown table in
 * the conversation.
 *
 * A phone stacks each row of a table into a labelled card by default — a 4-5 column table cannot show
 * its header and its cells side by side at 390px. The owner likes the cards and also wants the real
 * table one tap away, remembered on this device. So there are two views, `cards` and `table`, one
 * device-wide choice, and every table on screen follows it: flipping one flips them all, because a
 * reader comparing two tables wants them in the same shape.
 *
 * Deliberately NOT daemon-scoped: it is a property of the reader's screen, like the side pane's width
 * (`side-pane-preferences.ts`, whose shape this follows — an injected storage, a defensive parse, a
 * denied storage treated as an ordinary browser condition, one identity-stable snapshot).
 */

/** The sole browser-storage key for the Markdown table view. */
export const TABLE_VIEW_KEY = 'fy-md-table-view-v1';

export type TableView = 'cards' | 'table';

export const DEFAULT_TABLE_VIEW: TableView = 'cards';

/** Anything but the two known words is the default: a stale or hand-edited value resets cleanly. */
export const parseTableView = (raw: string | null | undefined): TableView => (raw === 'table' ? 'table' : 'cards');

export interface TableViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const browserStorage = (): TableViewStorage | undefined => {
  try {
    const candidate = (globalThis as { localStorage?: TableViewStorage }).localStorage;
    return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

/** The device's table view, shaped for `useSyncExternalStore`. */
export class TableViewPreferenceStore {
  readonly #storage: TableViewStorage | undefined;
  readonly #listeners = new Set<() => void>();
  #view: TableView | null = null;

  constructor(storage: TableViewStorage | undefined = browserStorage()) {
    this.#storage = storage;
  }

  /** The view in force; the first read hydrates from storage. */
  snapshot = (): TableView => {
    this.#view ??= this.#load();
    return this.#view;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Every table on screen follows; a failed write still changes the view for the rest of the tab. */
  set(view: TableView): void {
    if (this.snapshot() === view) return;
    this.#view = view;
    try {
      this.#storage?.setItem(TABLE_VIEW_KEY, view);
    } catch {
      // Storage denied (private mode, quota): the in-memory choice still applies.
    }
    for (const listener of this.#listeners) listener();
  }

  #load(): TableView {
    try {
      return parseTableView(this.#storage?.getItem(TABLE_VIEW_KEY));
    } catch {
      return DEFAULT_TABLE_VIEW;
    }
  }
}
