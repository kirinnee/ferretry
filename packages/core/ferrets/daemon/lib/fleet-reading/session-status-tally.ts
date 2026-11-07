/**
 * EVERY SESSION'S STATUS, READ ONCE AND THEN HEARD — NOT RE-READ FOR EVERY CATALOGUE.
 *
 * The fleet's runtime catalogue says how many sessions are running, and it used to find out by reading,
 * path-walking and schema-parsing every session's `state.json` on every catalogue it built — and the
 * catalogue is built for every runtimes and machine view, every Pack routing line, every staged change. A
 * fleet of ~600 sessions read ~600 documents per catalogue, several catalogues a second, and that held the
 * main thread.
 *
 * The tally reads every status once, then keeps itself current from what the storage tells it: this daemon
 * is the only writer of `state.json`, and it reports every state it writes ({@link SessionStatusTally.heard}),
 * so a status that moves is known the moment it lands, with no read. A write heard while a read runs is newer
 * than whatever that read found, so it wins.
 *
 * A TALLY IS NEVER TRUSTED FOREVER. What no write reports — a document edited by hand, a session removed — is
 * read at the latest {@link SessionStatusTallyPorts.maxAgeMs} after the last read, so correctness never
 * depends on hearing every write; only how often every document is read does.
 */
import type { SessionStatus } from '@ferretry/protocol';

export interface SessionStatusTallyPorts {
  /** Every session's status by id, from its documents: the costly read the tally exists to avoid repeating. */
  read(): Promise<ReadonlyMap<string, SessionStatus>>;
  now(): number;
  /** The longest the tally answers without a read, however much it has heard. */
  readonly maxAgeMs: number;
}

/** How long the tally answers from what it heard before every document is read again, at most. */
export const SESSION_STATUS_TALLY_MAX_AGE_MS = 60_000;

export class SessionStatusTally {
  #statuses: Map<string, SessionStatus> | undefined;
  #readAt = 0;
  #reading: Promise<void> | undefined;
  /** What was heard while the read in flight runs: newer than what it finds. `undefined` is no status. */
  #heardDuringRead = new Map<string, SessionStatus | undefined>();

  constructor(private readonly ports: SessionStatusTallyPorts) {}

  /** A state was written for `id`, with this status — or with none a reader could count. */
  heard(id: string, status: SessionStatus | undefined): void {
    if (this.#reading !== undefined) this.#heardDuringRead.set(id, status);
    if (this.#statuses === undefined) return;
    if (status === undefined) this.#statuses.delete(id);
    else this.#statuses.set(id, status);
  }

  /**
   * Every session's status: from what was heard while the last read is young enough, after a new read
   * otherwise — one read shared by every caller that asks while it runs. A read that fails leaves the last
   * tally in place (none at all, before the first), and the next caller reads again.
   */
  async statuses(): Promise<readonly SessionStatus[]> {
    if (this.#statuses === undefined || this.ports.now() - this.#readAt >= this.ports.maxAgeMs) await this.#read();
    return [...(this.#statuses?.values() ?? [])];
  }

  async #read(): Promise<void> {
    this.#reading ??= (async () => {
      const startedAt = this.ports.now();
      this.#heardDuringRead = new Map();
      try {
        const read = new Map(await this.ports.read());
        for (const [id, status] of this.#heardDuringRead) {
          if (status === undefined) read.delete(id);
          else read.set(id, status);
        }
        this.#statuses = read;
        this.#readAt = startedAt;
      } catch {
        // The last tally stands; the next caller reads again.
      } finally {
        this.#heardDuringRead = new Map();
        this.#reading = undefined;
      }
    })();
    await this.#reading;
  }
}
