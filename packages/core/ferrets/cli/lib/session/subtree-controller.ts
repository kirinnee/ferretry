import { SessionCommandError } from './errors.ts';
import type { IClock, ISessionApi, SessionEnvironment } from './ports.ts';
import type { SessionPresenter } from './presenter.ts';
import { buildSubtree, renderSubtreeTable } from './subtree-table.ts';

/**
 * Shows a lead its descendants as one table: `fy status --subtree [<id>]`. It defaults to the calling ferret when the
 * shell knows it; the owner, outside any pane, names one. Lineage is the registry's `parent` links from the fleet list.
 */
export class SessionSubtreeController {
  constructor(
    private readonly api: Pick<ISessionApi, 'list' | 'get'>,
    private readonly presenter: SessionPresenter,
    private readonly environment: SessionEnvironment,
    private readonly clock?: IClock,
  ) {}

  async execute(id: string | undefined, flags: { json?: boolean } = {}): Promise<void> {
    const reference = id?.trim() || this.environment.callerSessionId?.trim();
    if (reference === undefined || reference === '')
      throw new SessionCommandError('name the ferret whose descendants to show: status --subtree <id>');
    const root = await this.api.get(reference);
    const nowMs = this.clock?.nowMs();
    const view = buildSubtree(await this.api.list(), root, nowMs);
    if (flags.json === true) {
      this.presenter.json(view);
      return;
    }
    this.presenter.report(renderSubtreeTable(view, nowMs));
  }
}
