import type { FerretId, FerretRecord, LaunchOrigin } from '../../../../contract/index.ts';
import type { ResumeTarget } from '../../../../daemon/lib/ferrets/service.ts';
import { ResumeRefused } from '../../../../daemon/lib/session/resume/types.ts';

/**
 * A move's relaunch as the Ferrets SERVICE sees it (`ServiceResumeOptions.target` with the live pane replaced), driven
 * directly: what these tests hold is the service's own contract — the target resolved like a start before the live pane is
 * released, the model and effort written with the record, a failed launch leaving the record on the target — whoever calls
 * it (the move's route reaches it through `ferretsRestartResume`, covered by `move-login.test.ts`).
 */
interface Resuming {
  resume(
    ferret: FerretId,
    message: string | undefined,
    options: {
      readonly origin: LaunchOrigin;
      readonly automatic: boolean;
      readonly replaceLiveTerminal: boolean;
      readonly target: ResumeTarget;
    },
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: { readonly reason: string } }>;
}

export function serviceMove(
  service: Resuming,
  recordOf: (ferret: FerretId) => FerretRecord | undefined,
  targetOf: (ferret: FerretId) => Promise<ResumeTarget>,
): {
  resume(request: {
    readonly origin: LaunchOrigin;
    readonly id: FerretId;
    readonly policy?: unknown;
  }): Promise<{ readonly disposition: 'revived'; readonly record: FerretRecord | undefined }>;
} {
  return {
    resume: async request => {
      const resumed = await service.resume(request.id, undefined, {
        origin: request.origin,
        automatic: false,
        replaceLiveTerminal: true,
        target: await targetOf(request.id),
      });
      if (!resumed.ok) throw new ResumeRefused(resumed.error.reason);
      return { disposition: 'revived', record: recordOf(request.id) };
    },
  };
}
