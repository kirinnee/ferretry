import { type SessionView } from '../../../lib/protocol/session.ts';
import type { BoardTask } from '@ferretry/protocol';
import type { LaneSets } from '../../../lib/board/graph.ts';
import { createSessionPaths } from '../../../lib/paths.ts';
import type { FoundationPaths } from '../../../lib/paths.ts';
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
  /** Every card as stored, with its board's lanes. */
  board(): Promise<{ readonly cards: readonly BoardTask[]; readonly laneSets: LaneSets }>;
  /** Whether a session's agenda board holds an item that is still open. */
  hasOpenAgendaItem(sessionId: string): Promise<boolean>;
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
  readonly paths: FoundationPaths;
  readonly storage: DaemonStorage;
  readonly clock: { nowMs(): number };
  readonly afterMs: number | undefined;
  readonly passLimit: number;
  readonly sources: SessionArchiveSources;
  readonly yieldToLoop: () => Promise<void>;
}): SessionArchive {
  const { storage, paths, sources } = input;
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
        directory: id => createSessionPaths(paths, id).directory,
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
      const { cards, laneSets } = await sources.board();
      return sessionsOnOpenCards(cards, laneSets);
    },
    hasOpenAgendaItem: sources.hasOpenAgendaItem,
  };
  const reads = new StorageArchiveSessions(
    storage,
    input.clock,
    input.afterMs,
    input.yieldToLoop,
    async ids => await sessionKeeps(keeps, ids),
  );
  const service = new SessionArchiveService(
    {
      clock: input.clock,
      sessions: async () => await reads.sessions(),
      kept: async ids => await sessionKeeps(keeps, ids),
      archive: async (ids, roster) => await reads.archive(ids, roster),
    },
    { afterMs: input.afterMs, passLimit: input.passLimit },
  );
  subsystem.run = async () => await service.runPass();
  return { subsystem, enabled: true };
}
