import { endHasLastWords, lastWordsOf } from '../../../contract/index.ts';
import type { ISessionApi } from './ports.ts';
import type { SessionPresenter } from './presenter.ts';

/** Shows one ferret in detail: `fy status <id>`. */
export class SessionStatusController {
  constructor(
    private readonly api: ISessionApi,
    private readonly presenter: SessionPresenter,
  ) {}

  async execute(id: string, flags: { json?: boolean } = {}): Promise<void> {
    const view = await this.api.get(id);
    if (flags.json === true) return this.presenter.view(view, true);
    // A ferret that ended on its own says what its pane showed last, read through the stored last screen (gated and
    // masked again on this read), never from the record. `--json` is the record as the daemon answers it.
    const screen =
      view.state === 'stopped' && endHasLastWords(view.cause) ? await this.api.lastScreen?.(view.id) : undefined;
    this.presenter.view(view, false, screen === undefined ? undefined : lastWordsOf(screen));
  }
}
