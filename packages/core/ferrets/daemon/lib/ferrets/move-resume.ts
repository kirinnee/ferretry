import { z } from 'zod';
import type { FerretId, FerretRecord, StartFailure } from '../../../contract/index.ts';
import type { Result } from '@ferretry/std';
import { ResumeRefused } from '../session/resume/types.ts';
import type { ResumeOutcome, ResumeRequest } from '../session/resume/service.ts';
import type { ResumeTarget, ServiceResumeOptions } from './service.ts';

/** What the move's relaunch needs of Ferrets: its own resume, and the record to describe the outcome with. */
interface ResumingService {
  resume(ferret: FerretId, message?: string, options?: ServiceResumeOptions): Promise<Result<FerretId, StartFailure>>;
}

/** What a move restamps on the session's `config.json` that names where it relaunches (the moves module's own record). */
const MovedConfigSchema = z.object({
  /** The runtime the move named (the account's `agent`). */
  agent: z.string().min(1),
  /** The harness family of that runtime, in the session record's spelling. */
  harness: z.enum(['claude', 'codex']),
  login: z.string().min(1).optional(),
});

/**
 * Reads the target a move just recorded: the runtime, harness and login its relaunch is on (a harness is spelled as
 * Ferrets keys it). `read` is the moves module's config document.
 */
export async function movedTarget(read: () => Promise<unknown>): Promise<ResumeTarget> {
  const config = MovedConfigSchema.safeParse(await read().catch(() => undefined));
  if (!config.success) throw new ResumeRefused('the runtime this ferret is moving onto could not be read back');
  return {
    runtime: config.data.agent,
    harness: config.data.harness === 'codex' ? 'codex' : 'claude-code',
    ...(config.data.login === undefined ? {} : { login: config.data.login }),
  };
}

/**
 * The move's `resume` need, bound to {@link ResumingService}: a move relaunches by resuming through Ferrets' own launch
 * (`FerretsService.resume` → `launchAttempt`: home, canonical and shared-home check, token, prepareHome, environment,
 * start or resume), so it has no launch spec or home of its own (row S42).
 *
 * The policy is today's, copied: it states `automatic` and `replaceLiveTerminal` itself, and a request that states neither
 * is an explicit person’s resume (not automatic, no replacement). A move (`replaceLiveTerminal`) relaunches on the
 * runtime it recorded: `targetOf` reads it back, and the service writes it onto the ferret’s record before it launches,
 * so the start gate and the launch see the target rather than the previous runtime. A refusal is a {@link ResumeRefused},
 * which the move restates in its own words; anything else the launch throws reaches the move unchanged.
 */
export function ferretsMoveResume(
  service: ResumingService,
  recordOf: (ferret: FerretId) => FerretRecord | undefined,
  targetOf: (ferret: FerretId) => Promise<ResumeTarget>,
): { resume(request: ResumeRequest): Promise<ResumeOutcome> } {
  return {
    resume: async request => {
      const ferret = request.id as unknown as FerretId;
      const replaceLiveTerminal = request.policy?.replaceLiveTerminal ?? false;
      const resumed = await service.resume(ferret, request.message, {
        automatic: request.policy?.automatic ?? false,
        replaceLiveTerminal,
        ...(replaceLiveTerminal ? { target: await targetOf(ferret) } : {}),
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
