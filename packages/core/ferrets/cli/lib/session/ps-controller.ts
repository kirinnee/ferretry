import { type ListedFerret, renderSessionTable } from './display.ts';
import type { ICellColour } from './ports.ts';
import type { SessionPresenter } from './presenter.ts';
import { type SessionFilter, selectSessions } from './selection.ts';

export interface PsFlags extends SessionFilter {
  readonly json?: boolean;
}

/** The fleet read `ps` lists from: the one `GET /v1/ferrets` (R502: a held list per connection). */
export interface IFleetList {
  list(): Promise<readonly ListedFerret[]>;
}

/** Lists ferrets: `fy ps`. */
export class ListSessionsController {
  constructor(
    private readonly fleet: IFleetList,
    private readonly presenter: SessionPresenter,
    private readonly colour: ICellColour,
  ) {}

  async execute(flags: PsFlags = {}): Promise<void> {
    const selection = selectSessions(await this.fleet.list(), flags);
    // `--json` reports the selected set — including the empty one, so a script never has to parse the human-facing
    // "nothing here" sentence.
    if (flags.json === true) {
      this.presenter.json(selection.sessions);
      return;
    }
    // The table paints its own cells, so it goes out unpainted; the empty sentence keeps the success paint.
    if (selection.emptyMessage === undefined)
      this.presenter.report(renderSessionTable(selection.sessions, this.colour));
    else this.presenter.lines([selection.emptyMessage]);
  }
}
