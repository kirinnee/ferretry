import { type ArchiveSession, selfKeepReason, type SessionArchivePorts } from '../../../lib/session/archive/index.ts';
import { jsonObject } from '../../../lib/json.ts';
import { parseSessionId, type SessionId } from '../../../lib/session-id.ts';
import type { ArchiveVerdict, DaemonStorage } from '../../storage/session-storage.ts';

type ArchiveStorage = Pick<DaemonStorage, 'listSessions' | 'readConfig' | 'readState' | 'archiveSessions'>;

/** Sessions read together before the loop is handed back. */
const READ_BATCH = 25;

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/**
 * The session half of the archive: which sessions are live and what the rule needs to know of each, and the act of
 * archiving the ones it chose.
 *
 * READ RAW, like the agenda's agent roster, so a document a newer field made unparseable elsewhere still answers.
 * A session whose documents cannot be read at all is handed to the rule as one that is NOT archivable (no mode, no
 * end), so it is kept and, being present, keeps its lead live too.
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
        parent: text(settings?.parent),
      },
    };
  }

  private async read(id: SessionId, freshness: 'heard' | 'proved'): Promise<ArchiveSession> {
    return (await this.readSession(id, freshness)).session;
  }

  async archive(ids: readonly string[]): Promise<number> {
    const nowMs = this.clock.nowMs();
    const facts = { nowMs, afterMs: this.afterMs, kept: new Map<string, string>(), limit: ids.length };
    const left = await this.storage.archiveSessions(
      ids.map(parseSessionId),
      // Re-read as it is NOW, with the session's lane held: a session that was revived since the decision stays.
      async id => {
        const { session, verdict } = await this.readSession(id, 'proved');
        return selfKeepReason(session, facts) === undefined ? verdict : undefined;
      },
    );
    return left.length;
  }
}
