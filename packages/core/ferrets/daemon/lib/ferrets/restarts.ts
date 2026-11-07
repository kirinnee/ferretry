import { ApiError } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import type { FerretId, FerretState, FerretWaiting, StartFailure } from '../../../contract/index.ts';
import type {
  RestartCancelResult,
  RestartQueueEntry,
  RestartRequest,
  RestartResult,
  RestartStatus,
} from '../protocol/session-restart.ts';
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
  stop(ferret: FerretId, reason: string): Promise<void>;
  resume(ferret: FerretId): Promise<Result<FerretId, StartFailure>>;
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
    // Which instructions a launch would change is not read in this build; see `FerretRestarts.restart`.
    outdated: async () => [],
    restart: async (id, requestedBy) => {
      const ferret = id as FerretId;
      await host.stop(ferret, 'restart');
      const resumed = await host.resume(ferret);
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

  async restart(request: RestartRequest, requestId?: string, requestedBy?: string): Promise<RestartResult> {
    // Which ferrets have out-of-date instructions is not read in this build, and a restart that matched none
    // would say nothing was out of date. Say so instead.
    if (request.scope === 'outdated')
      throw new ApiError(
        503,
        'Finding ferrets with out-of-date instructions is not built yet in this version of Ferretry; name the ferrets or restart all of them.',
        'plugin_unavailable',
      );
    const caller = calledBy(requestedBy);
    if (caller === undefined) return await this.service.restart(request, requestId, requestedBy);
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
    return await this.service.restart({ ...request, ids: resolved, caller }, requestId, requestedBy);
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
