import type { EventPointer, IndexedSession, RebuildPlan } from '../../lib/storage-types.ts';
import type { SessionId } from '../../lib/session-id.ts';
import type { SessionIndex } from '../../lib/ports.ts';

/**
 * The session index with `listSessions` answered from a snapshot the index's own writes keep current.
 *
 * WHY. Fifty-odd jobs — sweeps, watchers, the session list route, every reconcile — ask for EVERY session,
 * and each ask was a full `SELECT … ORDER BY` over the copy in memory with one new object per row: ~2,400 rows
 * on the owner's fleet, most of them sessions that ended weeks ago. On 2026-11-05 `listSessions` was the
 * hottest frame of 36 event-loop stalls (90 s in two hours, one of 24 s). Those were under memory pressure,
 * where every fresh object costs most, which is exactly the case this removes: an unchanged session is the
 * SAME object from one list to the next, and nothing is allocated for it again.
 *
 * HOW IT STAYS TRUE. Every write goes to the wrapped index FIRST; only once it has been accepted is the
 * snapshot touched, so a write the index refuses (a conflicting pointer rolls the whole write back) leaves
 * the snapshot as it was. A write names its session, and the row the index now holds for it is read back
 * by id — a point lookup — rather than predicted from what was written, so the snapshot holds exactly what a
 * full listing would have. `replaceAll` reloads the whole snapshot. The sorted array is rebuilt lazily, on
 * the next list after a write, from objects already held: a sort, no SQL.
 *
 * THE ORDER IS THE INDEX'S OWN — `COALESCE(updated_at, created_at, id) DESC, id ASC` — spelled once more in
 * {@link compareListed}. SQLite compares that text bytewise and JavaScript by UTF-16 unit; the two agree for
 * every timestamp and session id the layout accepts (both ASCII), and a test pins the equivalence against the
 * real index.
 *
 * The array handed out is frozen: a caller that sorted or spliced it would corrupt every later answer.
 *
 * REBUILT ON BOOT. The rows live in the kernel's `sqlite-cache` (`index.sqlite`), which the kernel drops on a format
 * mismatch and which the conversion from the previous version does not carry. A cache that came back empty listed no
 * session at all until the boot job `ferrets.index-rebuild` ran: it gives the index a row for every session its
 * survey finds and the index lacks, ~50 sessions per slice with the loop handed back between slices, so ~2,400 rows
 * never cost one stall (`DaemonStorage.rebuildIndexYielding`). Until it has run the list is simply short, and an empty
 * list is a valid roster for every reader.
 */
export class ListedSessionIndex implements SessionIndex {
  #byId: Map<string, IndexedSession> | undefined;
  #listed: readonly IndexedSession[] | undefined;

  constructor(private readonly inner: SessionIndex) {}

  replaceAll(plan: RebuildPlan): void {
    this.inner.replaceAll(plan);
    this.#byId = undefined;
    this.#listed = undefined;
  }

  replaceSession(session: IndexedSession, events: readonly EventPointer[]): void {
    this.inner.replaceSession(session, events);
    this.#reread(session.id);
  }

  refreshSession(session: IndexedSession): void {
    this.inner.refreshSession(session);
    this.#reread(session.id);
  }

  appendEvent(session: IndexedSession, event: EventPointer): void {
    this.inner.appendEvent(session, event);
    this.#reread(session.id);
  }

  appendEvents(session: IndexedSession, events: readonly EventPointer[]): void {
    this.inner.appendEvents(session, events);
    this.#reread(session.id);
  }

  removeSession(id: SessionId): void {
    this.inner.removeSession(id);
    this.#reread(id);
  }

  findSession(id: SessionId): IndexedSession | undefined {
    return this.#byId === undefined ? this.inner.findSession(id) : this.#byId.get(id);
  }

  listSessions(): readonly IndexedSession[] {
    if (this.#listed !== undefined) return this.#listed;
    if (this.#byId === undefined) {
      const loaded = this.inner.listSessions();
      this.#byId = new Map(loaded.map(session => [session.id, session]));
      this.#listed = Object.freeze([...loaded]);
      return this.#listed;
    }
    this.#listed = Object.freeze([...this.#byId.values()].sort(compareListed));
    return this.#listed;
  }

  eventPointers(id: SessionId, afterSequence: number, limit: number): readonly EventPointer[] {
    return this.inner.eventPointers(id, afterSequence, limit);
  }

  fleetEventPointers(limit: number): readonly EventPointer[] {
    return this.inner.fleetEventPointers(limit);
  }

  countEvents(id: SessionId): number {
    return this.inner.countEvents(id);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  /** The row the index now holds for `id` — or its absence — replaces whatever the snapshot had. */
  #reread(id: SessionId): void {
    if (this.#byId === undefined) return;
    const current = this.inner.findSession(id);
    if (current === undefined) this.#byId.delete(id);
    else this.#byId.set(id, current);
    this.#listed = undefined;
  }
}

/** The index's listing order: most recently touched first, then by id. */
function compareListed(left: IndexedSession, right: IndexedSession): number {
  const leftKey = left.updatedAt ?? left.createdAt ?? left.id;
  const rightKey = right.updatedAt ?? right.createdAt ?? right.id;
  if (leftKey !== rightKey) return leftKey < rightKey ? 1 : -1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}
