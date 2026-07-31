import { SessionCommandError } from './errors.ts';
import type { ISessionApi } from './ports.ts';
import type { SessionPresenter } from './presenter.ts';

export interface NameFlags {
  readonly count?: number;
  readonly json?: boolean;
}

/**
 * Suggests free teammate callsigns: `fy name`.
 *
 * A suggestion, not a reservation — `fy start --teammate <name>` may still collide, in which case
 * the next suggestion works.
 */
export class SuggestNamesController {
  constructor(
    private readonly api: ISessionApi,
    private readonly presenter: SessionPresenter,
  ) {}

  async execute(flags: NameFlags = {}): Promise<void> {
    // The source silently turned `-n banana` into 1. A count that was asked for and ignored is
    // worse than a refusal, because the caller believes it got what it wanted.
    if (flags.count !== undefined && (!Number.isInteger(flags.count) || flags.count < 1))
      throw new SessionCommandError('--count must be an integer of at least 1');

    const names = await this.api.suggestNames(flags.count ?? 1);
    if (flags.json === true) {
      this.presenter.json(names);
      return;
    }
    this.presenter.lines(names);
  }
}
