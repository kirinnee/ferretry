import { type FerretId, type FerretRecord, LaunchOriginSchema, type StartFailure } from '../../../contract/index.ts';
import type { Result } from '@ferretry/std';
import { launchMode } from '../session/peers/fleet.ts';
import { ResumeRefused } from '../session/resume/types.ts';
import type { ResumeOutcome } from '../session/resume/service.ts';
import type { RestartRelaunch } from '../../modules/restart-in-place.ts';
import type { ResumeTarget, ServiceResumeOptions } from './service.ts';

/** What a relaunch needs of Ferrets: its own resume, and the record to describe the outcome with. */
interface ResumingService {
  resume(
    ferret: FerretId,
    message: string | undefined,
    options: ServiceResumeOptions,
  ): Promise<Result<FerretId, StartFailure>>;
}

/**
 * A RESTART's or a MOVE's relaunch (c58-37): the ferret's pane replaced by a resume of THIS service.
 *
 * A Restart names no target unless the person chose another conversation, so the record's own runtime, login, model and
 * effort stand and the conversation it is bound to is resumed (a target without one would start a new conversation, which
 * is what a Restart must never do unasked). A MOVE onto another login names its target (`onto`): the runtime (the service
 * resolves its login with the SAME resolution a start uses, before the live pane is released), the model and effort the
 * move planned, and the conversation to resume. The harness is always the record's own: the service refuses a runtime of
 * another one.
 *
 * The pane the gate looked at is judged under the ferret's own queue (`expect`), so a pane replaced or stopped between the
 * gate and the kill refuses with nothing written. The caller's `committed` step runs once the service's own refusals have
 * passed, before the pane is released. A refusal is a {@link ResumeRefused}, which the caller restates in its own words.
 */
export function ferretsRestartResume(
  service: ResumingService,
  recordOf: (ferret: FerretId) => FerretRecord | undefined,
): (request: RestartRelaunch) => Promise<ResumeOutcome> {
  return async request => {
    const ferret = request.id as unknown as FerretId;
    const stated = LaunchOriginSchema.safeParse(request.origin);
    if (!stated.success)
      throw new ResumeRefused('the Restart did not say who it is relaunching for, so nothing was launched');
    const record = recordOf(ferret);
    if (record === undefined) throw new ResumeRefused(`no ferret ${ferret}`);
    let target: ResumeTarget | undefined;
    if (request.onto !== undefined)
      target = {
        runtime: request.onto.runtime,
        harness: record.harness,
        ...(request.onto.model === undefined ? {} : { model: request.onto.model }),
        ...(request.onto.effort === undefined ? {} : { effort: request.onto.effort }),
        ...(request.conversation.kind === 'resume' && request.onto.conversation !== undefined
          ? { conversation: request.onto.conversation }
          : {}),
      };
    else if (request.conversation.kind !== 'resume') {
      if (record.runtime === undefined)
        throw new ResumeRefused('this ferret has no runtime recorded, so it cannot open another conversation on it');
      target = { runtime: record.runtime, harness: record.harness };
    }
    const resumed = await service.resume(ferret, request.message, {
      origin: stated.data,
      automatic: false,
      replaceLiveTerminal: true,
      expect: current => current.handle === request.expectHandle,
      committed: request.committed,
      ...(target === undefined ? {} : { target }),
      ...(request.actor === undefined ? {} : { actor: request.actor }),
    });
    if (!resumed.ok) throw new ResumeRefused(resumed.error.reason);
    const after = recordOf(ferret);
    return {
      target: {
        id: request.id,
        status: 'running',
        mode: launchMode(after?.mode),
        cwd: after?.folder ?? '',
        turn: 0,
      },
      disposition: 'revived',
    };
  };
}
