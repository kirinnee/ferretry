/**
 * EVERY CONVERSATION'S OPEN AND PARKED ITEMS, read once per machine (docs/agenda.md § The roll-up).
 *
 * The Inbox used to list a parked (snoozed or replied) item only from a board it happened to hold, and it held the
 * boards of the 30 most recent conversations, so an older conversation's snoozed item was neither listed nor
 * counted-for. `GET /v1/agenda/open` answers every session's items in pages; this reads all the pages of a machine
 * into one map the Inbox lists from.
 *
 * A read that fails keeps what the last good read said and says nothing is complete, so the page never claims more
 * than it read.
 */

import {
  AGENDA_CHANNEL_HEADER,
  AGENDA_CHANNEL_VERSION,
  type AgendaItem,
  AgendaOpenPageSchema,
  type AgendaOpenPage,
} from '@ferretry/protocol';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';
import { daemonRequest } from './daemon-transport.ts';
import { type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

/** More pages than a machine could hold: a daemon that never stops saying `next` is not read forever. */
export const ROLLUP_MAX_PAGES = 200;

/** The items each session holds on one machine. */
export type RollupBoards = ReadonlyMap<string, readonly AgendaItem[]>;

/** Reads every page of the machine's roll-up. */
export const fetchAgendaRollup = async (daemon: DaemonConnection, fetcher: DaemonFetch): Promise<RollupBoards> => {
  const boards = new Map<string, readonly AgendaItem[]>();
  let after: string | undefined;
  for (let page = 0; page < ROLLUP_MAX_PAGES; page += 1) {
    const request = daemonRequest(
      daemon,
      after === undefined ? '/v1/agenda/open' : `/v1/agenda/open?after=${encodeURIComponent(after)}`,
      { headers: { [AGENDA_CHANNEL_HEADER]: AGENDA_CHANNEL_VERSION } },
    );
    const response = await fetcher(request.url, request.init);
    if (!response.ok) throw new DaemonResponseError(response.status, `HTTP ${response.status}`, undefined);
    const read: AgendaOpenPage = AgendaOpenPageSchema.parse(await response.json());
    for (const session of read.sessions) boards.set(session.sessionId, session.items);
    if (read.next === undefined) return boards;
    after = read.next;
  }
  throw new DaemonResponseError(502, 'the roll-up did not end', undefined);
};

/** What the Inbox holds of the roll-ups: each machine's boards, and which machines have been read to the end. */
export interface RollupSnapshot {
  readonly boards: ReadonlyMap<DaemonId, RollupBoards>;
  readonly complete: ReadonlySet<DaemonId>;
}

const NOTHING: RollupSnapshot = { boards: new Map(), complete: new Set() };

/** The roll-ups of every machine the Inbox has read, behind the store shape `useSyncExternalStore` wants. */
export class AgendaRollupStore {
  #snapshot: RollupSnapshot = NOTHING;
  readonly #listeners = new Set<() => void>();
  readonly #inFlight = new Map<DaemonId, Promise<void>>();
  readonly #generations = new Map<DaemonId, number>();

  constructor(private readonly fetcher: DaemonFetch) {}

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): RollupSnapshot => this.#snapshot;

  /** Reads the machine's roll-up, once at a time per machine; a failed read keeps the last good one and settles. */
  read(daemon: DaemonConnection): Promise<void> {
    const existing = this.#inFlight.get(daemon.daemonId);
    if (existing !== undefined) return existing;
    const generation = this.#generations.get(daemon.daemonId) ?? 0;
    const promise = fetchAgendaRollup(daemon, this.fetcher)
      .then(
        boards => {
          if ((this.#generations.get(daemon.daemonId) ?? 0) === generation) this.#hold(daemon.daemonId, boards, true);
        },
        () => {
          if ((this.#generations.get(daemon.daemonId) ?? 0) === generation) this.#fail(daemon.daemonId);
        },
      )
      .finally(() => {
        if (this.#inFlight.get(daemon.daemonId) === promise) this.#inFlight.delete(daemon.daemonId);
      });
    this.#inFlight.set(daemon.daemonId, promise);
    return promise;
  }

  /** Forgets one machine (unpaired or re-paired): a read still in flight for it lands nowhere. */
  clearDaemon(daemonId: DaemonId): void {
    this.#generations.set(daemonId, (this.#generations.get(daemonId) ?? 0) + 1);
    this.#inFlight.delete(daemonId);
    if (!this.#snapshot.boards.has(daemonId) && !this.#snapshot.complete.has(daemonId)) return;
    const boards = new Map(this.#snapshot.boards);
    const complete = new Set(this.#snapshot.complete);
    boards.delete(daemonId);
    complete.delete(daemonId);
    this.#publish({ boards, complete });
  }

  #hold(daemonId: DaemonId, held: RollupBoards, whole: boolean): void {
    const boards = new Map(this.#snapshot.boards).set(daemonId, held);
    const complete = new Set(this.#snapshot.complete);
    if (whole) complete.add(daemonId);
    this.#publish({ boards, complete });
  }

  #fail(daemonId: DaemonId): void {
    if (!this.#snapshot.complete.has(daemonId)) return;
    const complete = new Set(this.#snapshot.complete);
    complete.delete(daemonId);
    this.#publish({ boards: this.#snapshot.boards, complete });
  }

  #publish(snapshot: RollupSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}
