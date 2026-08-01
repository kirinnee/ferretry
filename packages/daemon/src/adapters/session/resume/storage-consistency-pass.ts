import { createSessionPaths, type FoundationPaths } from '../../../lib/paths.ts';
import type { FileSystemPort } from '../../../lib/ports.ts';
import type { ConsistencyPassPort } from '../../../lib/session/health/service.ts';
import type { SessionHealthSettings } from '../../../lib/session/health/settings.ts';
import type { IncoherencePass } from '../../../lib/session/health/types.ts';
import { detectZombies, type TerminalSessionActivity } from '../../../lib/session/health/zombie.ts';
import type { SessionId } from '../../../lib/session-id.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';

/** Statuses from which a session will never run again; a journal still growing under one is a zombie. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['failed', 'stopped', 'completed', 'stalled']);

/**
 * Reconciles the disposable session index against the session directories, which are authoritative.
 *
 * The verification is the point. Reindexing and then reporting success is what let an index stay
 * broken while every pass claimed to have fixed it — so membership is re-read AFTER the repair, and
 * only what is still missing then is reported as unhealable. That set, not the set of problems
 * found, is what can eventually escalate to a restart.
 */
export class StorageConsistencyPass implements ConsistencyPassPort {
  constructor(
    private readonly storage: DaemonStorage,
    private readonly fileSystem: FileSystemPort,
    private readonly paths: FoundationPaths,
    private readonly settings: SessionHealthSettings,
  ) {}

  async run(deep: boolean): Promise<IncoherencePass> {
    const onDisk = await this.storage.sessionIdsOnDisk();
    const indexed = new Set(this.storage.listSessions().map(session => session.id));
    const missingFromIndex = onDisk.filter(id => !indexed.has(id));
    const staleRows = [...indexed].filter(id => !onDisk.includes(id));
    const zombies = deep ? detectZombies(await this.terminalActivity(), this.settings) : [];
    // A pass that found nothing and was not asked to verify deeply has nothing to reconcile, and
    // reindexing a healthy fleet once a minute is the steady file IO this check exists to avoid.
    if (!deep && missingFromIndex.length === 0 && staleRows.length === 0)
      return { missingFromIndex, staleRows, zombies, repaired: [], unhealable: [] };
    await this.storage.reconcile();
    const afterDisk = await this.storage.sessionIdsOnDisk();
    const afterIndex = new Set(this.storage.listSessions().map(session => session.id));
    const unhealable = afterDisk.filter(id => !afterIndex.has(id));
    const repaired = missingFromIndex.filter(id => afterIndex.has(id));
    return { missingFromIndex, staleRows, zombies, repaired, unhealable };
  }

  private async terminalActivity(): Promise<readonly TerminalSessionActivity[]> {
    const activity: TerminalSessionActivity[] = [];
    for (const session of this.storage.listSessions()) {
      if (session.status === undefined || !TERMINAL_STATUSES.has(session.status)) continue;
      activity.push({
        id: session.id,
        ...(await this.finishedAt(session.id)),
        ...(await this.journalModified(session.id)),
      });
    }
    return activity;
  }

  private async finishedAt(id: SessionId): Promise<{ finishedAt?: string }> {
    const state = await this.storage.readState(id).catch(() => undefined);
    const value =
      typeof state === 'object' && state !== null && !Array.isArray(state)
        ? (state as Record<string, unknown>).finishedAt
        : undefined;
    return typeof value === 'string' ? { finishedAt: value } : {};
  }

  private async journalModified(id: SessionId): Promise<{ journalModifiedMs?: number }> {
    const information = await this.fileSystem.information(createSessionPaths(this.paths, id).events);
    return information === undefined ? {} : { journalModifiedMs: information.modifiedAtMs };
  }
}
