import type { AskItem, AsksApi } from '@ferretry/core-asks/contract';
import {
  AGENDA_OPEN_DEFAULT_LIMIT,
  type AgendaOpenSession,
  type AgendaOpenPage,
  type AgendaOpenQuery,
} from '../../contract/index.ts';

/**
 * EVERY FERRET'S OPEN ASKS, ONE PAGE AT A TIME (docs/agenda.md § The roll-up).
 *
 * The agenda lists what waits on the owner and what the owner put aside, from every ferret on the machine. This reads the
 * asks Asks holds as open and answers in ferret-id order, so a page names where it stopped and the next one starts after
 * it. A ferret is never split across pages: a board holds at most a few dozen asks, so a page is at most one ferret past
 * the limit. Only reads; changes nothing.
 */
export class AgendaRollup {
  constructor(private readonly asks: Pick<AsksApi, 'snapshots'>) {}

  async page(query: AgendaOpenQuery): Promise<AgendaOpenPage> {
    const limit = query.limit ?? AGENDA_OPEN_DEFAULT_LIMIT;
    const after = query.after;
    const byFerret = new Map<string, AskItem[]>();
    for (const board of await this.asks.snapshots()) {
      if (board.items.length > 0) byFerret.set(board.sessionId, board.items);
    }
    const ids = [...byFerret.keys()].sort().filter(id => after === undefined || id > after);
    const sessions: AgendaOpenSession[] = [];
    let carried = 0;
    let last: string | undefined;
    for (const id of ids) {
      if (carried >= limit) return { sessions, next: last as string };
      last = id;
      const asks = byFerret.get(id) ?? [];
      if (asks.length === 0) continue;
      sessions.push({ sessionId: id, items: asks });
      carried += asks.length;
    }
    return { sessions };
  }
}
