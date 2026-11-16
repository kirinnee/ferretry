import type { FerretId, FerretSummary } from '../../../contract/index.ts';
import type { SignalSessionRequest } from '../protocol/session.ts';
import { SessionSignalError, type SessionSignalSubsystem } from '../runtime/mounts/session-signal.ts';
import { InvalidDeadlineRefused } from '../session/signal/policy.ts';
import type { SessionSignalService } from '../session/signal/service.ts';
import { SignalRefused, UnknownPeerRefused } from '../session/signal/types.ts';
import { tryParseSessionId } from '../session-id.ts';

/**
 * What `POST /v1/ferrets/:ferretId/signal` answers: the ferret as everyone reads it, with its declared wait while it
 * has one (the wire shape of a signal is the summary, so a client sees the state and the wait the signal changed).
 */
export type FerretSignalView = FerretSummary;

/** What the subsystem reads of the daemon half. */
export interface FerretSignalDirectory {
  /** The ferret an id or a name addresses; a name two ferrets hold on one footing addresses none. */
  resolve(reference: string): FerretId | undefined;
  /** The ferret as the registry holds it now. */
  view(ferret: FerretId): Promise<FerretSummary | undefined>;
}

/**
 * The signal route's subsystem: today's `SessionSignalService` behind the route's refusals. A refusal the domain
 * raises is said in the route's own taxonomy; anything else (a stop the harness could not do, a record that could not
 * be written) goes up as it is, so a signal that failed to act is never reported as a ferret that finished.
 */
export class FerretSignals implements SessionSignalSubsystem {
  constructor(
    private readonly service: Pick<SessionSignalService, 'signal'>,
    private readonly directory: FerretSignalDirectory,
  ) {}

  async signal(reference: string, request: SignalSessionRequest): Promise<FerretSignalView> {
    const ferret = this.directory.resolve(reference);
    const id = ferret === undefined ? undefined : tryParseSessionId(ferret);
    if (ferret === undefined || id === undefined) throw new SessionSignalError('not_found', `no ferret ${reference}`);
    try {
      await this.service.signal({
        id,
        kind: request.kind,
        ...(request.message === undefined ? {} : { message: request.message }),
        ...(request.kind === 'waiting'
          ? {
              ...(request.until === undefined ? {} : { until: request.until }),
              ...(request.condition === undefined ? {} : { condition: request.condition }),
              ...(request.peer === undefined ? {} : { peer: request.peer }),
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof InvalidDeadlineRefused) throw new SessionSignalError('invalid', error.message);
      if (error instanceof UnknownPeerRefused) throw new SessionSignalError('unknown_peer', error.message);
      if (error instanceof SignalRefused) throw new SessionSignalError('refused', error.message);
      throw error;
    }
    const view = await this.directory.view(ferret);
    if (view === undefined) throw new SessionSignalError('not_found', `no ferret ${reference}`);
    return view;
  }
}
