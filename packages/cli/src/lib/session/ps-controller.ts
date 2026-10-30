import { formatTaskRef, type SessionView } from '@ferretry/protocol';
import { renderSessionTable } from './display.ts';
import type { ICellColour, ISessionApi, ISessionBoard } from './ports.ts';
import type { SessionPresenter } from './presenter.ts';
import { type SessionFilter, selectSessions } from './selection.ts';

export interface PsFlags extends SessionFilter {
  readonly json?: boolean;
}

/**
 * The CARD facts a `--json` row carries that the wire shape does not: the focus card as it is cited
 * (`&F18`), and its lane name when the one board read resolved it. Every existing field is kept.
 */
function withCard(view: SessionView, lanes: ReadonlyMap<string, string>) {
  const focus = view.config.focusTask;
  if (focus === undefined) return view;
  const lane = lanes.get(focus.id);
  return { ...view, focusCard: formatTaskRef(focus), ...(lane === undefined ? {} : { focusLaneName: lane }) };
}

/** Lists sessions: `fy ps`, with each session's focus card and its lane in a CARD column. */
export class ListSessionsController {
  constructor(
    private readonly api: ISessionApi,
    private readonly presenter: SessionPresenter,
    private readonly board: ISessionBoard,
    private readonly colour: ICellColour,
  ) {}

  async execute(flags: PsFlags = {}): Promise<void> {
    const selection = selectSessions(await this.api.list(), flags);
    const lanes = await this.laneNames(selection.sessions);
    // `--json` reports the selected set — including the empty one, so a script never has to parse
    // the human-facing "nothing here" sentence.
    if (flags.json === true) {
      this.presenter.json(selection.sessions.map(view => withCard(view, lanes)));
      return;
    }
    // The table paints its own cells, so it goes out unpainted; the empty sentence keeps the
    // success paint it always had.
    if (selection.emptyMessage === undefined) {
      this.presenter.report(renderSessionTable(selection.sessions, lanes, this.colour));
    } else {
      this.presenter.lines([selection.emptyMessage]);
    }
  }

  /**
   * The lane names for the cards on screen, or an empty map when there is nothing to look up or the
   * board could not be read: `ps` is a session listing first and never fails because the board is
   * unavailable — the CARD column just shows ids without lanes.
   */
  private async laneNames(sessions: readonly SessionView[]): Promise<ReadonlyMap<string, string>> {
    if (sessions.every(view => view.config.focusTask === undefined)) return new Map();
    try {
      return await this.board.laneNames();
    } catch {
      return new Map();
    }
  }
}
