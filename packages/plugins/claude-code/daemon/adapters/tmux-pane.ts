/**
 * Which pane a ferret's Claude is in, as the runner named it (Terminals: the tmux pane id, `%12`). Filled by the
 * harness every time it is handed a handle — a start, a resume, a stop, a delivery — and emptied when the ferret
 * is stopped.
 *
 * This is the HARNESS's own bookkeeping for its startup checks. It is NOT how a person's answer reaches a pane: the
 * permission and dialog answers go through Ferrets' form seam (`./ferret-form-pane.ts`), which finds a ferret's pane from
 * its own record, so they work for either harness and for a pane already running before a daemon restart.
 */
export class PaneDirectory {
  readonly #handles = new Map<string, string>();

  remember(ferret: string, handle: string): void {
    this.#handles.set(ferret, handle);
  }

  forget(ferret: string): void {
    this.#handles.delete(ferret);
  }

  /** The pane id, or throws the sentence an answer route turns into a refusal. */
  require(ferret: string): string {
    const handle = this.#handles.get(ferret);
    if (handle === undefined) throw new PaneUnknown(ferret);
    return handle;
  }
}

/** The pane id is not known to this directory. */
class PaneUnknown extends Error {
  constructor(readonly ferret: string) {
    super(`this daemon does not know which pane ferret ${ferret} is in, so nothing was read or sent`);
    this.name = 'PaneUnknown';
  }
}
