import type { FerretId, FerretRecord } from '../../../../contract/index.ts';
import type { AutoResumeRosterPort, AutoResumeSubject } from '../../../lib/session/auto-resume/types.ts';

/**
 * Whether a ferret is still exactly what the boot exit pass left it as: stopped because its terminal was PROVEN gone
 * (`terminal_gone`, the settle's own cause). Anything else is somebody's decision or a later end, and it stands: an
 * owner's stop (`stopped`), a `signal done` (`completed`), a resume that brought it back, an archive (no record).
 */
export function owedAutoResume(record: FerretRecord | undefined): boolean {
  return record !== undefined && record.state === 'stopped' && record.cause?.kind === 'terminal_gone';
}

/**
 * A ferret as the auto-resume reads it, from the registry (5.0's one owner of a ferret's state; today read the session
 * document's status). `failed` is today's word for "still owed" ({@link owedAutoResume}); any other answer is not owed.
 */
export class RegistryAutoResumeRoster implements AutoResumeRosterPort {
  constructor(private readonly record: (ferret: FerretId) => FerretRecord | undefined) {}

  async subject(id: string): Promise<AutoResumeSubject | undefined> {
    const record = this.record(id as FerretId);
    if (record === undefined) return undefined;
    return { status: owedAutoResume(record) ? 'failed' : record.state, mode: record.mode ?? 'auto' };
  }
}
