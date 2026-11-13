import type { StatePort } from '@ferretry/kernel/contract';
import { AutoResumeFile, AutoResumeSummaryFile } from '../../../../contract/index.ts';
import { type AutoResumeSummary, AutoResumeSummarySchema } from '../../../lib/protocol/auto-resume.ts';
import {
  type AutoResumeCandidate,
  type AutoResumeLedgerPort,
  AutoResumeLedgerSchema,
} from '../../../lib/session/auto-resume/types.ts';

type LedgerState = Pick<StatePort, 'read' | 'write' | 'remove'>;

/**
 * The ferrets still owed an auto-resume, kept in Ferrets' own state (`state/ferrets/auto-resume.json`, F-0109) so a
 * second power cut mid-pass does not forget them.
 *
 * AN UNREADABLE DOCUMENT READS AS EMPTY, which is the safe direction here: forgetting a candidate costs a ferret
 * staying down until a person resumes it, while believing a torn or foreign document could resume ferrets nobody
 * asked to bring back, and spend on them. An empty list is written as no document at all (today's ledger).
 */
export class StateAutoResumeLedger implements AutoResumeLedgerPort {
  constructor(private readonly state: LedgerState) {}

  async read(): Promise<readonly AutoResumeCandidate[]> {
    const read = await this.state.read(AutoResumeFile).catch(() => undefined);
    if (read === undefined || !read.ok || read.value === undefined) return [];
    const parsed = AutoResumeLedgerSchema.safeParse(read.value);
    return parsed.success ? parsed.data.candidates : [];
  }

  async write(candidates: readonly AutoResumeCandidate[]): Promise<void> {
    if (candidates.length === 0) {
      await this.state.remove(AutoResumeFile);
      return;
    }
    await this.state.write(AutoResumeFile, { candidates: [...candidates] });
  }
}

/** What the last auto-resume pass did (`state/ferrets/auto-resume-summary.json`, F-0108), kept across a restart. */
export class StateAutoResumeSummaryStore {
  constructor(private readonly state: Pick<StatePort, 'read' | 'write'>) {}

  /** `null` when no pass has run, or its document cannot be read: never a summary that does not parse. */
  async read(): Promise<AutoResumeSummary | null> {
    const read = await this.state.read(AutoResumeSummaryFile).catch(() => undefined);
    if (read === undefined || !read.ok || read.value === undefined) return null;
    const parsed = AutoResumeSummarySchema.safeParse(read.value);
    return parsed.success ? parsed.data : null;
  }

  async write(summary: AutoResumeSummary): Promise<void> {
    await this.state.write(AutoResumeSummaryFile, summary);
  }
}
