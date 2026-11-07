import type { SubtreeView } from '@ferretry/protocol';
import { SessionCommandError } from './errors.ts';
import type { ICellColour, IClock, SessionEnvironment } from './ports.ts';
import type { SessionPresenter } from './presenter.ts';
import { renderSubtreeTable } from './subtree-table.ts';

/** The one daemon read `fy status --subtree` makes. */
export interface ISessionSubtree {
  subtree(id: string): Promise<SubtreeView>;
}

/**
 * Shows a lead its descendants as one table: `fy status --subtree [<id>]` (docs/pack-mode.md § Checking on your
 * sub-ferrets). It defaults to the calling session; the owner, outside any pane, names one.
 */
export class SessionSubtreeController {
  constructor(
    private readonly api: ISessionSubtree,
    private readonly presenter: SessionPresenter,
    private readonly environment: SessionEnvironment,
    private readonly clock: IClock,
    private readonly colour: ICellColour,
  ) {}

  async execute(id: string | undefined, flags: { json?: boolean } = {}): Promise<void> {
    const root = id?.trim() || this.environment.callerSessionId?.trim();
    if (root === undefined || root === '')
      throw new SessionCommandError(
        'name the session whose descendants to show: status --subtree <id> (it defaults to the calling session only inside a ferret)',
      );
    const view = await this.api.subtree(root);
    if (flags.json === true) {
      this.presenter.json(view);
      return;
    }
    this.presenter.report(renderSubtreeTable(view, this.clock.nowMs(), this.colour));
  }
}
