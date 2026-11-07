/**
 * THE SESSION INDEX'S WRITES, AS DATA — so they can be queued, merged and carried to the thread that
 * owns the file on disk.
 *
 * The daemon answers every index read from memory and persists the same writes behind it, off the event
 * loop: a commit to a saturated disk ends in an `fsync` (SQLite's checkpoint) that measured over a second
 * on a busy machine and 38 s on the owner's, and while it ran nothing else did. Each write here is one
 * call the index already had, and each touches exactly one session's rows — except `replace-all`, which
 * touches every row. That is the whole basis of {@link coalesceIndexWrites}: writes to different sessions
 * commute, so only the order of one session's writes, and their order around a `replace-all`, matters.
 */
import type { SessionId } from './session-id.ts';
import type { EventPointer, IndexedSession } from './storage-types.ts';

export type IndexWrite =
  /** Every row replaced: the rebuild. */
  | {
      readonly kind: 'replace-all';
      readonly sessions: readonly IndexedSession[];
      readonly events: readonly EventPointer[];
    }
  /** One session's metadata and exactly these pointers, and no others. */
  | {
      readonly kind: 'replace-session';
      readonly session: IndexedSession;
      readonly events: readonly EventPointer[];
    }
  /** One session's metadata upserted; its pointers kept as they are. */
  | { readonly kind: 'refresh-session'; readonly session: IndexedSession }
  /** One session's metadata upserted, and these pointers added to the ones it has. */
  | {
      readonly kind: 'append-events';
      readonly session: IndexedSession;
      readonly events: readonly EventPointer[];
    }
  /** One session's row and every pointer it had, gone. */
  | { readonly kind: 'remove-session'; readonly id: SessionId };

type SessionWrite = Exclude<IndexWrite, { readonly kind: 'replace-all' }>;

function sessionOf(write: SessionWrite): SessionId {
  return write.kind === 'remove-session' ? write.id : write.session.id;
}

/** `previous` followed by `next` — two writes to one session — as the one write that says both. */
function merged(previous: SessionWrite, next: SessionWrite): SessionWrite {
  // Superseding writes: what the session holds afterwards does not depend on anything queued before.
  if (next.kind === 'replace-session' || next.kind === 'remove-session') return next;
  // After a removal the session has no row and no pointer, so whatever follows creates exactly that.
  if (previous.kind === 'remove-session') {
    return { kind: 'replace-session', session: next.session, events: next.kind === 'append-events' ? next.events : [] };
  }
  if (next.kind === 'refresh-session') {
    // The metadata is replaced; whatever pointers the earlier write carried still land.
    return previous.kind === 'refresh-session' ? next : { ...previous, session: next.session };
  }
  if (previous.kind === 'refresh-session') return next;
  return { ...previous, session: next.session, events: [...previous.events, ...next.events] };
}

/**
 * `pending` with `next` queued after it, merged into the session's last write.
 *
 * Applying the result in order leaves exactly the rows applying `pending` and then `next` would. A
 * `replace-all` drops everything before it, and nothing queued before one is merged into a write after
 * it. A session's write merges only with that session's latest write when no `replace-all` sits between
 * them, so the queue holds at most one write per session for every `replace-all` in it — however many
 * times a busy session was written while the disk was slow.
 */
export function coalesceIndexWrites(pending: readonly IndexWrite[], next: IndexWrite): readonly IndexWrite[] {
  if (next.kind === 'replace-all') return [next];
  const id = sessionOf(next);
  for (let position = pending.length - 1; position >= 0; position -= 1) {
    const previous = pending[position] as IndexWrite;
    if (previous.kind === 'replace-all') break;
    if (sessionOf(previous) !== id) continue;
    // Moved to the end: every write it now passes is another session's, and those commute with it.
    return [...pending.slice(0, position), ...pending.slice(position + 1), merged(previous, next)];
  }
  return [...pending, next];
}

/** `writes` folded one by one into `pending`: a failed batch put back in front of what queued behind it. */
export function coalesceAll(pending: readonly IndexWrite[], writes: readonly IndexWrite[]): readonly IndexWrite[] {
  return writes.reduce<readonly IndexWrite[]>(coalesceIndexWrites, pending);
}
