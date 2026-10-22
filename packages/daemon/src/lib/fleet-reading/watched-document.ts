import type { FileSubscription } from '../file-events/hub.ts';

export interface WatchedDocumentPorts<T> {
  /** Hear when the file may have changed (`FileEventHub.subscribe`). */
  watch(path: string, listener: () => void): FileSubscription;
  /** Read and parse the file. */
  load(): Promise<T>;
}

/**
 * ONE FILE, READ AGAIN ONLY WHEN IT CHANGED — the fleet manifest, which the usage feed joined to every
 * credential's reading on every refresh, re-reading and re-parsing a file that changes only when a fleet
 * is applied.
 *
 * The answer is kept while a live watch has seen no change since it was read. A change seen while a read
 * is in flight discards that read's answer for the next caller, and a watch that is not live (a polled
 * directory) keeps nothing: every read goes to the file, as before. A failed read is the caller's to
 * handle, and is never kept.
 */
export class WatchedDocument<T> {
  readonly #subscription: FileSubscription;
  #generation = 0;
  #kept: { readonly generation: number; readonly value: T } | undefined;

  constructor(
    path: string,
    private readonly ports: WatchedDocumentPorts<T>,
  ) {
    this.#subscription = ports.watch(path, () => {
      this.#generation += 1;
      this.#kept = undefined;
    });
  }

  async read(): Promise<T> {
    const kept = this.#kept;
    if (kept !== undefined && kept.generation === this.#generation && this.#subscription.live()) return kept.value;
    const generation = this.#generation;
    const value = await this.ports.load();
    if (this.#subscription.live() && generation === this.#generation) this.#kept = { generation, value };
    return value;
  }

  close(): void {
    this.#subscription.close();
  }
}
