import { ApiError } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import type { LaunchInstructionSectionId } from '../protocol/session.ts';
import {
  type FerretId,
  type FerretState,
  type FerretWaiting,
  type LaunchOrigin,
  type StartFailure,
  type RestartCancelResult,
  type RestartQueueEntry,
  type RestartRequest,
  type RestartResult,
  type RestartStatus,
} from '../../../contract/index.ts';
import type { SessionRestartSubsystem } from '../runtime/mounts/session-restart.ts';
import { type RestartPorts, RestartService, type RestartSubject } from '../session/restart/service.ts';

/**
 * Restarting ferrets (docs/launch-settings.md): today's `RestartService` over Ferrets' own records.
 *
 * A restart is a same-login resume with the conversation kept: the ferret is stopped and resumed through its own
 * `FerretsApi`, so the harness, the runner and the login are the ones it already had. It is never forced: a ferret
 * is restarted only at a your-turn or in a declared wait, and every other one is queued in `restarts.json` for the
 * drain to try again.
 */

/** What the restart ports need of the daemon half. */
export interface FerretRestartHost {
  ready(): Promise<void>;
  /** Every ferret the registry holds. */
  ferrets(): readonly {
    readonly id: FerretId;
    readonly name: string;
    readonly state: FerretState;
    readonly stateAt: string;
  }[];
  waitingOf(ferret: FerretId): FerretWaiting | undefined;
  /**
   * The instruction sections a launch now would change for this ferret, read fresh: empty when it is current, when it
   * never recorded what it was told, or when it cannot be read (a restart is advice taken on proof, never on a guess).
   */
  outdated(ferret: FerretId): Promise<readonly LaunchInstructionSectionId[]>;
  stop(ferret: FerretId, reason: string): Promise<void>;
  /** Resumes the ferret FOR `origin`: the one the restart was admitted for, never one the host makes up. */
  resume(ferret: FerretId, origin: LaunchOrigin): Promise<Result<FerretId, StartFailure>>;
  history(ferret: FerretId, type: string, data: Readonly<Record<string, unknown>>): Promise<void>;
  loadQueue(): Promise<readonly RestartQueueEntry[]>;
  saveQueue(entries: readonly RestartQueueEntry[]): Promise<void>;
  now(): string;
}

/** The ports of today's restart domain, over the host. */
function restartPorts(host: FerretRestartHost): RestartPorts {
  const subjectOf = (ferret: ReturnType<FerretRestartHost['ferrets']>[number]): RestartSubject => ({
    id: ferret.id,
    name: ferret.name,
    running: ferret.state !== 'stopped',
    // Your turn, or parked on a declared wait: the only moments a restart is attempted.
    idle: ferret.state === 'idle' || host.waitingOf(ferret.id) !== undefined,
    revision: `${ferret.state}@${ferret.stateAt}`,
  });
  return {
    subjects: async () => {
      await host.ready();
      return host.ferrets().map(subjectOf);
    },
    subject: async id => {
      await host.ready();
      const found = host.ferrets().find(ferret => ferret.id === id);
      return found === undefined ? undefined : subjectOf(found);
    },
    outdated: async id => await host.outdated(id as FerretId),
    restart: async (id, origin, requestedBy) => {
      const ferret = id as FerretId;
      await host.stop(ferret, 'restart');
      const resumed = await host.resume(ferret, origin);
      if (!resumed.ok) throw new Error(resumed.error.reason);
      await host.history(ferret, 'session.restarted', requestedBy === undefined ? {} : { requestedBy });
    },
    gaveUp: async (id, reason) => await host.history(id as FerretId, 'session.restart_gave_up', { reason }),
    queue: { load: async () => await host.loadQueue(), save: async entries => await host.saveQueue(entries) },
    now: () => host.now(),
  };
}

/** What the subsystem asks of the registry to decide who may restart whom. */
export interface FerretRestartAuthority {
  /** The ferret an id or a name addresses. */
  resolve(reference: string): FerretId | undefined;
  /** Whether `caller` is the ferret `target`, or a lead of it. */
  mayTouch(caller: FerretId, target: FerretId): boolean;
}

/** The `requestedBy` words the mount derives from the caller's standing. */
const calledBy = (requestedBy: string | undefined): FerretId | undefined =>
  requestedBy?.startsWith('session:') === true ? (requestedBy.slice('session:'.length) as FerretId) : undefined;

export class FerretRestarts implements SessionRestartSubsystem {
  constructor(
    private readonly service: RestartService,
    private readonly authority: FerretRestartAuthority,
  ) {}

  async restart(
    request: RestartRequest,
    origin: LaunchOrigin,
    requestId?: string,
    requestedBy?: string,
  ): Promise<RestartResult> {
    const caller = calledBy(requestedBy);
    if (caller === undefined) return await this.service.restart(request, origin, requestId, requestedBy);
    // A ferret restarts itself and its helpers; the whole fleet is a person's. The ferret it says it is, is the ferret
    // its credential names, never the one the body claims.
    if (request.scope !== 'ids')
      throw new ApiError(403, 'a ferret restarts only itself and its helpers, not every ferret', 'forbidden');
    // One resolution for both the check and the service: each reference must name exactly one ferret (a name two hold on
    // one footing names none), and the service is handed the resolved ids, never the raw words, so it cannot pick a
    // different holder than the one the caller was cleared for.
    const resolved: FerretId[] = [];
    for (const reference of request.ids ?? []) {
      const target = this.authority.resolve(reference);
      if (target === undefined)
        throw new ApiError(
          403,
          `a ferret restarts only itself and its helpers, and ${reference} is not exactly one ferret`,
          'forbidden',
        );
      if (!this.authority.mayTouch(caller, target))
        throw new ApiError(
          403,
          `a ferret restarts only itself and its helpers, and ${reference} is neither`,
          'forbidden',
        );
      resolved.push(target);
    }
    return await this.service.restart({ ...request, ids: resolved, caller }, origin, requestId, requestedBy);
  }

  async status(): Promise<RestartStatus> {
    return await this.service.status();
  }

  async cancel(): Promise<RestartCancelResult> {
    return await this.service.cancel();
  }

  async drain(): Promise<void> {
    await this.service.drain();
  }
}

export const restartService = (host: FerretRestartHost): RestartService => new RestartService(restartPorts(host));
