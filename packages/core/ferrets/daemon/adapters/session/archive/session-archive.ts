import type { SessionView } from '../../../lib/protocol/session.ts';
import type { OpenCardStanding } from '../../../lib/session/peers/board.ts';
import type { SessionId } from '../../../lib/session-id.ts';
import type { SessionArchiveSubsystem } from '../../../lib/runtime/mounts/session-archive.ts';
import { createSessionDirectory } from '../../../lib/session/directory/index.ts';
import {
  type ArchiveKeepSources,
  SessionArchiveService,
  sessionKeeps,
  sessionsOnOpenCards,
} from '../../../lib/session/archive/index.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';
import { StorageArchiveSessions } from './storage-archive-sessions.ts';

/** What the archive reads of the other subsystems that own its keep signals. */
export interface SessionArchiveSources {
  /** The ferrets the owner pinned. */
  pinned(): Promise<ReadonlyMap<string, string>>;
  /**
   * Every card as stored, each with its lane's category as Board resolved it. INJECTED by the Board plugin; until it
   * is wired the archive cannot prove a ferret is off every open card, so it keeps every one live.
   */
  board?(): Promise<readonly OpenCardStanding[]>;
  /** Whether a session's agenda board holds an item that is still open. */
  hasOpenAgendaItem(sessionId: string): Promise<boolean>;
  /**
   * Whether the daemon still holds this ferret as running. The session document's status is a copy that follows the
   * registry; a ferret the registry holds live is never archived, whatever the copy says (never archive what runs).
   */
  isLive?(sessionId: string): boolean;
}

export interface SessionArchive {
  /** The routes' view of the archive: how many, and the newest ones in full. */
  readonly subsystem: SessionArchiveSubsystem;
  /** Whether archiving is on. */
  readonly enabled: boolean;
}

/**
 * Builds the archive for this daemon: the rule's ports over the storage, and the read side the routes serve.
 *
 * `afterMs` of `undefined` is "off": the archive reads what is already archived (so nothing that was archived is lost
 * from view) but never archives anything more.
 */
export function createSessionArchive(input: {
  /** What an archived session's view names as its directory (read only; nothing is created or touched there). */
  readonly directory: (id: SessionId) => string;
  readonly storage: DaemonStorage;
  readonly clock: { nowMs(): number };
  readonly afterMs: number | undefined;
  readonly passLimit: number;
  readonly sources: SessionArchiveSources;
  readonly yieldToLoop: () => Promise<void>;
}): SessionArchive {
  const { storage, sources } = input;
  const subsystem: { -readonly [K in keyof SessionArchiveSubsystem]: SessionArchiveSubsystem[K] } = {
    count: () => storage.archivedCount(),
    list: async limit => {
      // Newest first by the instant each last changed; a directory per request, because what it keeps is bounded by the request.
      const rows = [...storage.listArchivedSessions()]
        .sort(
          (left, right) =>
            (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '') || left.id.localeCompare(right.id),
        )
        .slice(0, limit);
      const directory = createSessionDirectory({
        sessions: () => rows,
        find: id => storage.findSession(id),
        readConfig: async id => await storage.readConfig(id),
        readState: async id => await storage.readState(id),
        directory: input.directory,
        // An archived session is shown as it was left: nothing here may write into it.
        project: undefined,
        ended: () => true,
        yieldToLoop: input.yieldToLoop,
      });
      const views: SessionView[] = [...(await directory.list())];
      const position = new Map<string, number>(rows.map((row, at) => [row.id, at]));
      return views.sort((left, right) => (position.get(left.config.id) ?? 0) - (position.get(right.config.id) ?? 0));
    },
  };
  if (input.afterMs === undefined) return { subsystem, enabled: false };

  const keeps: ArchiveKeepSources = {
    pinned: async () => new Set((await sources.pinned()).keys()),
    onOpenCards: async () => {
      // Unwired, this rejects: `sessionKeeps` reads a rejection as "board unreadable" and keeps every session.
      if (sources.board === undefined) throw new Error('no board is wired to say which sessions are on an open card');
      return sessionsOnOpenCards(await sources.board());
    },
    hasOpenAgendaItem: sources.hasOpenAgendaItem,
  };
  // A ferret the daemon still holds running is kept as well, besides what Board, Agenda and the pins say.
  const kept = async (ids: readonly string[]): Promise<ReadonlyMap<string, string>> => {
    const answers = new Map(await sessionKeeps(keeps, ids));
    for (const id of ids) if (sources.isLive?.(id) === true && !answers.has(id)) answers.set(id, 'still running');
    return answers;
  };
  const reads = new StorageArchiveSessions(storage, input.clock, input.afterMs, input.yieldToLoop, kept);
  const service = new SessionArchiveService(
    {
      clock: input.clock,
      sessions: async () => await reads.sessions(),
      kept,
      archive: async (ids, roster) => await reads.archive(ids, roster),
    },
    { afterMs: input.afterMs, passLimit: input.passLimit },
  );
  subsystem.run = async () => await service.runPass();
  return { subsystem, enabled: true };
}
