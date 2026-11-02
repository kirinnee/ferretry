import { CloseFinishedTerminalsResponseSchema, TerminalHoldersViewSchema } from '@ferretry/protocol';
import { SessionCommandError } from '../session/errors.ts';
import type { SessionPresenter } from '../session/presenter.ts';
import type { ITerminalSlotsGateway } from './ports.ts';
import { renderCloseFinished, renderTerminalHolders } from './render.ts';

export interface TerminalSlotsOptions {
  readonly json?: boolean;
}

/**
 * The owner's view of the terminal limit: who holds the slots, and closing what finished ferrets left
 * behind. Closing only ever touches terminals whose owner has completed, stopped or been removed.
 */
export class TerminalSlotsController {
  constructor(
    private readonly gateway: ITerminalSlotsGateway,
    private readonly presenter: SessionPresenter,
  ) {}

  async slots(options: TerminalSlotsOptions): Promise<void> {
    const view = await this.gateway.request('/v1/terminals', TerminalHoldersViewSchema);
    if (options.json === true) this.presenter.json(view);
    else this.presenter.lines(renderTerminalHolders(view));
  }

  async closeFinished(options: TerminalSlotsOptions): Promise<void> {
    const result = await this.gateway.request('/v1/terminals/close-finished', CloseFinishedTerminalsResponseSchema, {
      method: 'POST',
    });
    if (options.json === true) this.presenter.json(result);
    else this.presenter.lines(renderCloseFinished(result));
    if (result.failed > 0) throw new SessionCommandError(`${result.failed} terminal(s) could not be closed`, 1);
  }
}
