import type { AskSummary, AsksApi } from '@ferretry/core-asks/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import {
  AGENDA_OPEN_DEFAULT_LIMIT,
  type AgendaOpenFerret,
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
  constructor(private readonly asks: Pick<AsksApi, 'open'>) {}

  async page(query: AgendaOpenQuery): Promise<AgendaOpenPage> {
    const limit = query.limit ?? AGENDA_OPEN_DEFAULT_LIMIT;
    const after = query.after;
    const byFerret = new Map<string, AskSummary[]>();
    for (const ask of await this.asks.open({ state: 'open' })) {
      if (ask.ferret === undefined) continue;
      byFerret.set(ask.ferret, [...(byFerret.get(ask.ferret) ?? []), ask]);
    }
    const ids = [...byFerret.keys()].sort().filter(id => after === undefined || id > after);
    const ferrets: AgendaOpenFerret[] = [];
    let carried = 0;
    let last: string | undefined;
    for (const id of ids) {
      if (carried >= limit) return { ferrets, next: last as string };
      last = id;
      const asks = byFerret.get(id) ?? [];
      if (asks.length === 0) continue;
      ferrets.push({ ferret: id as FerretId, asks });
      carried += asks.length;
    }
    return { ferrets };
  }
}
