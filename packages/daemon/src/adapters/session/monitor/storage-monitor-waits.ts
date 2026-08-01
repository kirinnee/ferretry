import { waitDeadline } from '../../../lib/session/monitor/policy.ts';
import type { SessionMonitorSettings } from '../../../lib/session/monitor/settings.ts';
import type { MonitorWaits, ParkedSession, WaitExpiry } from '../../../lib/session/monitor/types.ts';
import type { SessionSignalService } from '../../../lib/session/signal/service.ts';
import {
  PROTECTED_SIGNAL_STATUSES,
  type DeclaredWait,
  type SignalRepository,
} from '../../../lib/session/signal/types.ts';
import type { SessionId } from '../../../lib/session-id.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';

/**
 * The parks THIS daemon holds, and the two writes a tick makes to one.
 *
 * ONE DAEMON CANNOT SEE ANOTHER'S SESSIONS THROUGH THIS PORT. The roster is the session index of the
 * storage this process opened, and there is no other way in — no id arrives from a caller, no path is
 * composed from a parameter. A second daemon on this host has its own state home, its own index and
 * its own instance of this class, and neither can name a session belonging to the other.
 *
 * THE ROSTER READS STATE DOCUMENTS RATHER THAN FILTERING THE INDEX BY STATUS, which costs one read
 * per live session per tick. The status is exactly the field a park drifts out of — that drift is
 * what `hold` exists to correct — so filtering the index on `status = waiting` would hide precisely
 * the sessions that need the tick most.
 *
 * A SETTLED SESSION IS LEFT ALONE, matching the warden detector, which only reports a declared wait
 * overdue while the session is unsettled. A park recorded on a session that has since been stopped or
 * completed has nothing to wake: the pane is gone, so the nudge would go nowhere, and restoring the
 * status would resurrect a verdict another path reached. Such a record keeps its stale `waiting`
 * field, which is a known and declared cosmetic gap rather than a park nothing will end.
 */
export class StorageMonitorWaits implements MonitorWaits {
  constructor(
    private readonly storage: DaemonStorage,
    private readonly repository: SignalRepository,
    private readonly signals: SessionSignalService,
    private readonly settings: SessionMonitorSettings,
  ) {}

  async parked(): Promise<readonly ParkedSession[]> {
    const sessions: ParkedSession[] = [];
    for (const indexed of this.storage.listSessions()) {
      // A record this daemon cannot read is not a park it can service. It is already reported by the
      // consistency pass, and guessing at its status here would be the same benign reading of missing
      // evidence that the signal repository refuses to make.
      const target = await this.repository.read(indexed.id).catch(() => undefined);
      if (target?.waiting === undefined || PROTECTED_SIGNAL_STATUSES.has(target.status)) continue;
      sessions.push({ id: target.id, status: target.status, waiting: target.waiting });
    }
    return sessions;
  }

  /**
   * Ends the park, re-deciding the deadline from the document under the signal slice's own lock.
   *
   * The deadline function is passed rather than the instant, so the wait the LOCK found is the one
   * measured — a park replaced between the plan and this call is measured on its new deadline and
   * survives, instead of being woken on the old one.
   */
  async expire(id: SessionId, nowMs: number, expiry: WaitExpiry): Promise<DeclaredWait | undefined> {
    return await this.signals.expireWait(
      id,
      nowMs,
      (wait: DeclaredWait) => waitDeadline(wait, this.settings).atMs,
      expiry.reason,
    );
  }

  async hold(id: SessionId): Promise<boolean> {
    return await this.signals.holdWait(id);
  }
}
