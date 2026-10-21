import type { AutoResumeRosterPort, AutoResumeSubject } from '../../../lib/session/auto-resume/types.ts';
import type { ResumeRepository } from '../../../lib/session/resume/types.ts';
import { tryParseSessionId } from '../../../lib/session-id.ts';

/** A session as the auto-resume reads it: through the same repository the revive itself reads. */
export class RepositoryAutoResumeRoster implements AutoResumeRosterPort {
  constructor(private readonly repository: Pick<ResumeRepository, 'read'>) {}

  async subject(id: string): Promise<AutoResumeSubject | undefined> {
    const parsed = tryParseSessionId(id);
    if (parsed === undefined) return undefined;
    const target = await this.repository.read(parsed);
    return target === undefined ? undefined : { status: target.status, mode: target.mode };
  }
}
