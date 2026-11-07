import type { TerminalIo } from '@ferretry/kernel/manifest';
import { CloseFinishedTerminalsResponseSchema, TerminalHoldersViewSchema } from '../../../contract/index.ts';
import type { ITerminalSlotsGateway } from './ports.ts';
import { renderCloseFinished, renderTerminalHolders } from './render.ts';

export interface TerminalSlotsOptions {
  readonly json?: boolean;
}

export const SLOT_ROUTES = {
  holders: 'GET /v1/terminals',
  closeFinished: 'POST /v1/terminals/close-finished',
} as const;

/**
 * The owner's view of the terminal limit: who holds the slots, and closing what finished ferrets left
 * behind. Closing only ever touches terminals whose owner has completed, stopped or been removed.
 * Each answers its exit code.
 */
export class TerminalSlotsController {
  constructor(
    private readonly gateway: ITerminalSlotsGateway,
    private readonly io: TerminalIo,
  ) {}

  async slots(options: TerminalSlotsOptions): Promise<number> {
    return await this.guard(async () => {
      const view = TerminalHoldersViewSchema.parse(await this.gateway.call(SLOT_ROUTES.holders));
      this.print(options, view, renderTerminalHolders(view));
      return 0;
    });
  }

  async closeFinished(options: TerminalSlotsOptions): Promise<number> {
    return await this.guard(async () => {
      const result = CloseFinishedTerminalsResponseSchema.parse(await this.gateway.call(SLOT_ROUTES.closeFinished));
      this.print(options, result, renderCloseFinished(result));
      if (result.failed === 0) return 0;
      this.io.err(`${result.failed} terminal(s) could not be closed\n`);
      return 1;
    });
  }

  private async guard(run: () => Promise<number>): Promise<number> {
    try {
      return await run();
    } catch (error) {
      this.io.err(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  private print(options: TerminalSlotsOptions, value: unknown, lines: readonly string[]): void {
    this.io.out(`${options.json === true ? JSON.stringify(value, null, 2) : lines.join('\n')}\n`);
  }
}
