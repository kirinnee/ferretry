import {
  type ArchiveFacts,
  type ArchiveSession,
  childrenStaying,
  selfKeepReason,
  type SessionArchivePorts,
  unknownLineageBlocks,
} from '../../../lib/session/archive/index.ts';
import { jsonObject } from '@ferretry/std';
import { parseSessionId, type SessionId } from '../../../lib/session-id.ts';
import type { ArchiveVerdict, DaemonStorage } from '../../storage/session-storage.ts';

type ArchiveStorage = Pick<
  DaemonStorage,
  'listSessions' | 'readConfig' | 'readState' | 'archiveSessions' | 'retainSession'
>;

/** Sessions read together before the loop is handed back. */
const READ_BATCH = 25;

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/**
 * The session half of the archive: which sessions are live and what the rule needs to know of each, and the act of
 * archiving the ones it chose.
 *
 * READ RAW, like the agenda's agent roster, so a document a newer field made unparseable elsewhere still answers.
 * A session whose documents cannot be read at all is handed to the rule as one that is NOT archivable (no mode, no
 * end) and whose lineage is UNKNOWN: it is kept itself, and since whose child it is cannot be said, the rule archives
 * no lead while it is unaccounted for. Unknown is never read as "no parent".
 *
 * PACED: documents are read {@link READ_BATCH} at a time with the loop handed back between batches, and `heard`
 * freshness is used so a document the watchers already hold costs no system call.
 */
export class StorageArchiveSessions implements Pick<SessionArchivePorts, 'sessions' | 'archive'> {
  constructor(
    private readonly storage: ArchiveStorage,
    private readonly clock: { nowMs(): number },
    private readonly afterMs: number,
    private readonly yieldToLoop: () => Promise<void>,
    /** The keep signals asked again at the commit boundary: a pin, a card or an agenda item may have appeared since. */
    private readonly keepsNow: (ids: readonly string[], signal?: AbortSignal) => Promise<ReadonlyMap<string, string>>,
  ) {}

  async sessions(): Promise<readonly ArchiveSession[]> {
    const listed = this.storage.listSessions();
    const out: ArchiveSession[] = [];
    for (let at = 0; at < listed.length; at += READ_BATCH) {
      if (at > 0) await this.yieldToLoop();
      const batch = listed.slice(at, at + READ_BATCH);
      out.push(...(await Promise.all(batch.map(async ({ id }) => await this.read(id, 'heard')))));
    }
    return out;
  }

  /** One session as the rule sees it, and the name it answers to; unreadable documents read as a session that is kept. */
  private async readSession(
    id: SessionId,
    freshness: 'heard' | 'proved',
  ): Promise<{ readonly session: ArchiveSession; readonly verdict: ArchiveVerdict }> {
    const [config, state] = await Promise.all([
      this.storage.readConfig(id, freshness).catch(() => undefined),
      this.storage.readState(id, freshness).catch(() => undefined),
    ]);
    const settings = jsonObject(config);
    const document = jsonObject(state);
    const createdAt = text(settings?.createdAt);
    const updatedAt = text(settings?.updatedAt);
    const name = text(settings?.teammate);
    const parent = text(settings?.parent);
    // No readable config, or a `parent` that is there but means nothing: whose child this is is not known.
    const parentUnknown = settings === undefined || (settings.parent !== undefined && parent === undefined);
    return {
      verdict: {
        ...(name === undefined ? {} : { name }),
        ...(createdAt === undefined || updatedAt === undefined ? {} : { configTimes: { createdAt, updatedAt } }),
      },
      session: {
        id,
        mode: text(settings?.mode),
        status: text(document?.status) ?? 'unknown',
        finishedAt: text(document?.finishedAt),
        parent,
        ...(parentUnknown ? { parentUnknown } : {}),
      },
    };
  }

  private async read(id: SessionId, freshness: 'heard' | 'proved'): Promise<ArchiveSession> {
    return (await this.readSession(id, freshness)).session;
  }

  /**
   * Archives `ids`, every one of them checked again at the commit boundary and against the WHOLE group.
   *
   * With the lineage gates and sessions' lanes held, the first check rebuilds the
   * roster as it is now (every current id read afresh, including existing ids) and asks the keep signals
   * again; each session is then re-read and must still qualify on its own, and its lead may leave only when every
   * session that names it as lead has left before it (`ids` come children first) or already left earlier. A child that
   * revived, or was started, between the decision and the locks therefore keeps its lead live, and so does any session
   * whose lineage is unknown.
   */
  async archive(ids: readonly string[], _roster: readonly ArchiveSession[], signal?: AbortSignal): Promise<number> {
    const nowMs = this.clock.nowMs();
    const facts: ArchiveFacts = { nowMs, afterMs: this.afterMs, kept: new Map<string, string>(), limit: ids.length };
    const leaving = new Set<string>();
    let boundary:
      | Promise<{ live: readonly ArchiveSession[]; kept: ReadonlyMap<string, string>; blocked: boolean }>
      | undefined;
    const settle = (): NonNullable<typeof boundary> => (boundary ??= this.boundary(ids, signal));
    const left = await this.storage.archiveSessions(
      ids.map(parseSessionId),
      // Re-read as it is NOW, with the session's lane held: a session that was revived since the decision stays.
      async id => {
        const { live, kept, blocked } = await settle();
        if (blocked) return undefined;
        const { session, verdict } = await this.readSession(id, 'proved');
        if (selfKeepReason(session, { ...facts, kept }) !== undefined) return undefined;
        if (childrenStaying(id, live, leaving).length > 0) return undefined;
        leaving.add(id);
        return verdict;
      },
    );
    // Reconcile a signal published during the registry IO, including an outside file edit without a publication hook.
    // No session lane is held here: agenda and card writers can finish before these reads and revivals.
    const late = await this.keepsNow(left, signal);
    const restored = new Set(late.keys());
    const live = (await boundary)?.live ?? [];
    const parents = new Map(live.map(session => [session.id, session.parent]));
    for (const id of restored) {
      const parent = parents.get(id);
      if (parent !== undefined) restored.add(parent);
    }
    for (const id of left) if (restored.has(id)) await this.storage.retainSession(id);
    return left.filter(id => !restored.has(id)).length;
  }

  /** The roster, the keep signals and the lineage verdict as they are at the commit boundary. */
  private async boundary(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ live: readonly ArchiveSession[]; kept: ReadonlyMap<string, string>; blocked: boolean }> {
    const kept = await this.keepsNow(ids, signal);
    const listed = this.storage.listSessions();
    const live: ArchiveSession[] = [];
    for (let at = 0; at < listed.length; at += READ_BATCH) {
      if (at > 0) await this.yieldToLoop();
      live.push(
        ...(await Promise.all(listed.slice(at, at + READ_BATCH).map(async ({ id }) => await this.read(id, 'proved')))),
      );
    }
    return { live, kept, blocked: unknownLineageBlocks(live) };
  }
}
