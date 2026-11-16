import type { ConsistencyPassPort } from '../../../lib/session/health/service.ts';
import type { SessionHealthSettings } from '../../../lib/session/health/settings.ts';
import {
  type IncoherencePass,
  type SelfCheckActivityPort,
  type SurveyedSession,
  UNNAMED_SELF_CHECK_STAGES,
} from '../../../lib/session/health/types.ts';
import { detectZombies, type TerminalSessionActivity } from '../../../lib/session/health/zombie.ts';
import type { SessionId } from '../../../lib/session-id.ts';
import { instantMs } from '../../../lib/time.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';
import { TERMINAL_STATUSES } from './storage-health-inventory.ts';

/** What the pass asks of the session store. */
type ConsistencyStorage = Pick<
  DaemonStorage,
  'listSessions' | 'surveySessionDirectories' | 'reconcile' | 'sessionIdsOnDisk' | 'readState' | 'lastEventAt'
>;

/**
 * Reconciles the disposable session index against the session directories, which are authoritative.
 *
 * The verification is the point. Reindexing and then reporting success is what let an index stay broken while every
 * pass claimed to have fixed it — so membership is re-read AFTER the repair, and only what is still missing then is
 * reported as unhealable. That set, not the set of problems found, is what can eventually escalate to a restart.
 *
 * When a finished session's journal last grew is the stamp of its newest event, read from the index (the state port
 * reads no file's modified time): a session with no events is a journal nobody can age.
 */
export class StorageConsistencyPass implements ConsistencyPassPort {
  constructor(
    private readonly storage: ConsistencyStorage,
    private readonly settings: SessionHealthSettings,
    /** Names the deep pass's own stages — the zombie scan, the reindex and its verification. */
    private readonly stages: SelfCheckActivityPort = UNNAMED_SELF_CHECK_STAGES,
  ) {}

  /** `survey` is the check's own walk of the directories; without one, the pass takes its own. */
  async run(deep: boolean, surveyed?: readonly SurveyedSession[]): Promise<IncoherencePass> {
    const survey = surveyed ?? (await this.storage.surveySessionDirectories());
    const onDisk = survey.map(session => session.id);
    // Journal existence is established BEFORE the membership early return. Nothing a reconcile can do brings a deleted
    // file back, so this is the one finding a normal tick must never miss: reporting it as unhealable is what stops the
    // restart streak being reset by healthy ticks.
    const lostJournals = survey.filter(session => session.journalLost).map(session => session.id);
    const lost = new Set<string>(lostJournals);
    const indexed = new Set(this.storage.listSessions().map(session => session.id));
    // A quarantined session is deliberately absent from the index. Counting it as missing would make the early return
    // unreachable and run a full reconcile every minute, forever.
    const missingFromIndex = onDisk.filter(id => !indexed.has(id) && !lost.has(id));
    const staleRows = [...indexed].filter(id => !onDisk.includes(id));
    const zombies = deep
      ? detectZombies(await this.stages.run('zombies', async () => await this.terminalActivity()), this.settings)
      : [];
    // A pass that found nothing and was not asked to verify deeply has nothing to reconcile, and reindexing a healthy
    // fleet once a minute is the steady file IO this check exists to avoid.
    if (!deep && missingFromIndex.length === 0 && staleRows.length === 0)
      return { missingFromIndex, staleRows, zombies, repaired: [], unhealable: lostJournals };
    // `reindex` includes the wait for the storage's exclusive lock, which is part of what it costs.
    const reconciliation = await this.stages.run('reindex', async () => await this.storage.reconcile());
    const failed = new Set(reconciliation.failedSessionIds ?? []);
    const afterDisk = await this.stages.run('verify', async () => await this.storage.sessionIdsOnDisk());
    const afterIndex = new Set(this.storage.listSessions().map(session => session.id));
    const unhealable = [
      ...new Set([...afterDisk.filter(id => !afterIndex.has(id) || failed.has(id)), ...lostJournals]),
    ];
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
        ...this.journalModified(session.id),
      });
    }
    return activity;
  }

  private journalModified(id: SessionId): { journalModifiedMs?: number } {
    const at = instantMs(this.storage.lastEventAt(id));
    return at === undefined ? {} : { journalModifiedMs: at };
  }

  private async finishedAt(id: SessionId): Promise<{ finishedAt?: string }> {
    const state = await this.storage.readState(id).catch(() => undefined);
    const value =
      typeof state === 'object' && state !== null && !Array.isArray(state)
        ? (state as Record<string, unknown>).finishedAt
        : undefined;
    return typeof value === 'string' ? { finishedAt: value } : {};
  }
}
