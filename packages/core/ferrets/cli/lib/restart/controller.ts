import type { RestartRequest } from '../../../contract/index.ts';
import { SessionCommandError } from '../session/errors.ts';
import type { SessionPresenter } from '../session/presenter.ts';
import type { IRestartGateway } from './ports.ts';
import { plural, renderRestartResult, renderRestartStatus } from './render.ts';

/** Flags accepted by `fy restart`. */
export interface RestartCommandOptions {
  readonly outdated?: boolean;
  readonly all?: boolean;
  readonly cancel?: boolean;
  /** `--request-id`: the idempotency key of an explicit retry; the daemon answers a repeat from memory. */
  readonly requestId?: string;
  readonly json?: boolean;
}

/**
 * Restarts ferrets on their current conversation, never past the in-flight inventory: a busy ferret is queued and
 * the daemon restarts it at its next idle moment. The ferret that typed the command is queued too, rather than
 * restarted in the middle of its own turn.
 */
export class RestartController {
  constructor(
    private readonly gateway: IRestartGateway,
    private readonly presenter: SessionPresenter,
    private readonly callerSessionId?: string,
  ) {}

  async execute(references: readonly string[], options: RestartCommandOptions): Promise<void> {
    const json = options.json === true;
    const ids = references.map(reference => reference.trim()).filter(reference => reference !== '');
    if (references.length !== ids.length) throw new SessionCommandError('a ferret id or callsign must not be blank', 2);
    const modes = [options.outdated === true, options.all === true, options.cancel === true, ids.length > 0].filter(
      Boolean,
    ).length;
    if (modes > 1)
      throw new SessionCommandError('pass one of: ferret ids, --outdated, --all or --cancel (not a mix)', 2);

    if (options.cancel === true) {
      const cancelled = await this.gateway.cancelRestarts();
      if (json) this.presenter.json(cancelled);
      else this.presenter.lines([`Cleared ${plural(cancelled.cancelled, 'waiting restart')}.`]);
      return;
    }
    if (modes === 0) {
      const status = await this.gateway.restartStatus();
      if (json) this.presenter.json(status);
      else this.presenter.lines(renderRestartStatus(status));
      return;
    }

    const request: RestartRequest = {
      scope: options.all === true ? 'all' : options.outdated === true ? 'outdated' : 'ids',
      ...(ids.length > 0 ? { ids } : {}),
      ...(this.callerSessionId === undefined ? {} : { caller: this.callerSessionId }),
    };
    const result = await this.gateway.restart(request, options.requestId);
    if (json) this.presenter.json(result);
    else this.presenter.lines(renderRestartResult(result));
    if (result.failed.length > 0) throw new SessionCommandError(`${plural(result.failed.length, 'restart')} failed`, 1);
  }
}
