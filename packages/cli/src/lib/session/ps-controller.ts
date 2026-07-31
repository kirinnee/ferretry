import { renderSessionTable } from './display.ts';
import type { ISessionApi } from './ports.ts';
import type { SessionPresenter } from './presenter.ts';
import { selectSessions, type SessionFilter } from './selection.ts';

export interface PsFlags extends SessionFilter {
  readonly json?: boolean;
}

/** Lists sessions: `fy ps`. */
export class ListSessionsController {
  constructor(
    private readonly api: ISessionApi,
    private readonly presenter: SessionPresenter,
  ) {}

  async execute(flags: PsFlags = {}): Promise<void> {
    const selection = selectSessions(await this.api.list(), flags);
    // `--json` reports the selected set — including the empty one, so a script never has to parse
    // the human-facing "nothing here" sentence.
    if (flags.json === true) {
      this.presenter.json(selection.sessions);
      return;
    }
    this.presenter.lines(
      selection.emptyMessage === undefined ? renderSessionTable(selection.sessions) : [selection.emptyMessage],
    );
  }
}
