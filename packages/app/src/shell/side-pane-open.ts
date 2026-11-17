/**
 * WHETHER THE FERRET PAGE'S SIDE COLUMN (`ferret.side`) IS OPEN, wide. v4 opened a ferret on its chat and the composer and
 * kept the rest (agenda, queue, tasks, terminals, files…) behind one click, so the column starts closed. What the reader
 * chose lasts for the visit: a column opened on one ferret stays open on the next, and one closed stays closed. It is
 * not saved, so a fresh load is the clean page again. Shaped for `useSyncExternalStore`.
 */
class SidePaneOpen {
  readonly #listeners = new Set<() => void>();
  #open = false;

  readonly get = (): boolean => this.#open;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  set(open: boolean): void {
    if (open === this.#open) return;
    this.#open = open;
    for (const listener of this.#listeners) listener();
  }
}

/** The one the shell's ferret pages share. */
export const sidePaneOpen = new SidePaneOpen();
