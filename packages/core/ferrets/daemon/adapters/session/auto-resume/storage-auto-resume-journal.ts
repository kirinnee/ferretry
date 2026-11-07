import { couldNotAutoResume } from '../../../lib/session/auto-resume/policy.ts';
import type { AutoResumeJournalPort, AutoResumeOutcome } from '../../../lib/session/auto-resume/types.ts';
import { tryParseSessionId } from '../../../lib/session-id.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';

/** Each outcome is one event on the session's own journal, so its history says why it came back or did not. */
export class StorageAutoResumeJournal implements AutoResumeJournalPort {
  constructor(private readonly storage: Pick<DaemonStorage, 'append'>) {}

  async record(id: string, outcome: AutoResumeOutcome): Promise<void> {
    const parsed = tryParseSessionId(id);
    if (parsed === undefined) return;
    if (outcome.kind === 'resumed') {
      await this.storage.append(parsed, 'session.auto_resumed', {
        reason: 'resumed automatically after the machine restarted',
        notified: outcome.notified,
      });
      return;
    }
    await this.storage.append(parsed, 'session.auto_resume_skipped', { reason: couldNotAutoResume(outcome.reason) });
  }
}
