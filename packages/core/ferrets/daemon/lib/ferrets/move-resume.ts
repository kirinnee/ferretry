import type { FerretId, FerretRecord, StartFailure } from '../../../contract/index.ts';
import type { Result } from '@ferretry/std';
import { ResumeRefused } from '../session/resume/types.ts';
import type { ResumeOutcome, ResumeRequest } from '../session/resume/service.ts';
import type { ResumeOptions } from '../../../contract/index.ts';

/** What the move's relaunch needs of Ferrets: its own resume, and the record to describe the outcome with. */
interface ResumingService {
  resume(ferret: FerretId, message?: string, options?: ResumeOptions): Promise<Result<FerretId, StartFailure>>;
}

/**
 * The move's `resume` need, bound to {@link ResumingService}: a move relaunches by resuming through Ferrets' own launch
 * (`FerretsService.resume` → `launchAttempt`: home, canonical and shared-home check, token, prepareHome, environment,
 * start or resume), so it has no launch spec or home of its own (row S42).
 *
 * The policy is today's, copied: it states `automatic` and `replaceLiveTerminal` itself, and a request that states neither
 * is an explicit person’s resume (not automatic, no replacement). A refusal is a {@link ResumeRefused}, which the move
 * restates in its own words; anything else the launch throws reaches the move unchanged.
 */
export function ferretsMoveResume(
  service: ResumingService,
  recordOf: (ferret: FerretId) => FerretRecord | undefined,
): { resume(request: ResumeRequest): Promise<ResumeOutcome> } {
  return {
    resume: async request => {
      const ferret = request.id as unknown as FerretId;
      const resumed = await service.resume(ferret, request.message, {
        automatic: request.policy?.automatic ?? false,
        replaceLiveTerminal: request.policy?.replaceLiveTerminal ?? false,
      });
      if (!resumed.ok) throw new ResumeRefused(resumed.error.reason);
      const record = recordOf(ferret);
      return {
        target: {
          id: request.id,
          status: 'running',
          mode: record?.mode ?? 'auto',
          cwd: record?.folder ?? '',
          turn: 0,
        },
        disposition: 'revived',
      };
    },
  };
}
