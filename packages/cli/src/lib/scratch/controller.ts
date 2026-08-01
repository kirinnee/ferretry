import type { IScratchGateway, IScratchOutput } from './ports.ts';
import { renderScratchPlan, renderScratchSweep } from './render.ts';

/** Flags accepted by `fy gc`. */
export interface ScratchCommandOptions {
  readonly dryRun?: boolean;
  readonly limit?: number;
  readonly force?: boolean;
  readonly json?: boolean;
}

/** Drives scratch planning and reclamation through the daemon. */
export class ScratchController {
  constructor(
    private readonly gateway: IScratchGateway,
    private readonly out: IScratchOutput,
  ) {}

  async execute(options: ScratchCommandOptions): Promise<void> {
    if (options.dryRun === true) {
      const limit = options.limit ?? 20;
      if (!Number.isInteger(limit) || limit <= 0) throw new Error('--limit must be a positive integer');
      const plan = await this.gateway.scratchPlan(limit);
      this.out.success(options.json === true ? JSON.stringify(plan, null, 2) : renderScratchPlan(plan));
      return;
    }

    const result = await this.gateway.scratchSweep(options.force === true);
    this.out.success(options.json === true ? JSON.stringify(result, null, 2) : renderScratchSweep(result));
  }
}
