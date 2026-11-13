import { z } from 'zod';
import { type FerretId, type FerretRecord, LaunchOriginSchema, type StartFailure } from '../../../contract/index.ts';
import type { Result } from '@ferretry/std';
import { ResumeRefused } from '../session/resume/types.ts';
import type { ResumeOutcome, ResumeRequest } from '../session/resume/service.ts';
import type { ResumeTarget, ServiceResumeOptions } from './service.ts';

/** What the move's relaunch needs of Ferrets: its own resume, and the record to describe the outcome with. */
interface ResumingService {
  resume(
    ferret: FerretId,
    message: string | undefined,
    options: ServiceResumeOptions,
  ): Promise<Result<FerretId, StartFailure>>;
}

/** What a move restamps on the session's `config.json` that names where it relaunches (the moves module's own record). */
const MovedConfigSchema = z.object({
  /** The runtime the move named (the account's `agent`). */
  agent: z.string().min(1),
  /** The harness family of that runtime, in the session record's spelling. */
  harness: z.enum(['claude', 'codex']),
  /** The model the move planned on the target. */
  model: z.string().min(1).optional(),
  /** The reasoning effort the move recorded; gone when the move crosses harnesses (their vocabularies differ). */
  launchReasoningEffort: z.string().min(1).optional(),
  /** The conversation the relaunch resumes: gone for a fresh start, the converted or earlier one otherwise. */
  transcript: z.looseObject({ harnessSessionId: z.string().min(1).optional() }).optional(),
});

/**
 * Reads the target a move just recorded: the runtime, harness, model, effort and conversation its relaunch is on (a harness is
 * spelled as Ferrets keys it; no conversation means a fresh start). It reads exactly the keys the moves module restamps
 * and no others — it records no login, so none is read. `read` is the moves module's config document.
 */
export async function movedTarget(read: () => Promise<unknown>): Promise<ResumeTarget> {
  const config = MovedConfigSchema.safeParse(await read().catch(() => undefined));
  if (!config.success) throw new ResumeRefused('the runtime this ferret is moving onto could not be read back');
  return {
    runtime: config.data.agent,
    harness: config.data.harness === 'codex' ? 'codex' : 'claude-code',
    ...(config.data.model === undefined ? {} : { model: config.data.model }),
    ...(config.data.launchReasoningEffort === undefined ? {} : { effort: config.data.launchReasoningEffort }),
    ...(config.data.transcript?.harnessSessionId === undefined
      ? {}
      : { conversation: config.data.transcript.harnessSessionId }),
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
      const stated = LaunchOriginSchema.safeParse(request.origin);
      if (!stated.success)
        throw new ResumeRefused('the move did not say who it is relaunching for, so nothing was launched');
      const origin = stated.data;
      const replaceLiveTerminal = request.policy?.replaceLiveTerminal ?? false;
      const resumed = await service.resume(ferret, request.message, {
        // Who the relaunch is FOR, carried from the route that admitted the move. A request with no origin (an unbound or
        // hand-built caller) is refused before anything launches: the move never launches as nobody.
        origin,
        automatic: request.policy?.automatic ?? false,
        replaceLiveTerminal,
        ...(replaceLiveTerminal ? { target: await targetOf(ferret) } : {}),
        // Who asked, for the author beside the relaunch's turn (the Warden's move is drawn as the Warden's).
        ...(request.actor === undefined ? {} : { actor: request.actor }),
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
