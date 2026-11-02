import { AGENDA_OPEN_DEFAULT_LIMIT, type AgendaOpenPage, type AgendaOpenQuery } from '@ferretry/protocol';
import type { AgendaLedgerRepository } from './service.ts';
import { agendaSnapshot } from './state-machine.ts';

/**
 * EVERY CONVERSATION'S OPEN AND PARKED ITEMS, ONE PAGE AT A TIME (docs/agenda.md § The roll-up).
 *
 * The Inbox lists what waits on the owner and what the owner put aside, from every conversation on the machine — not
 * from the few it happened to read a board for. This reads the boards the way the wake sweep does (one session at a
 * time, a board that cannot be read is skipped) and answers in session-id order, so a page names where it stopped
 * and the next one starts after it. A conversation is never split across pages: a board holds at most
 * `MAX_AGENDA_PER_SESSION` items, so a page is at most one board past the limit. Only reads; changes nothing.
 */
export class AgendaRollup {
  constructor(
    private readonly boards: Pick<AgendaLedgerRepository, 'read'>,
    private readonly sessionIds: () => readonly string[],
  ) {}

  async page(query: AgendaOpenQuery): Promise<AgendaOpenPage> {
    const limit = query.limit ?? AGENDA_OPEN_DEFAULT_LIMIT;
    const after = query.after;
    const ids = [...new Set(this.sessionIds())].sort().filter(id => after === undefined || id > after);
    const sessions: AgendaOpenPage['sessions'][number][] = [];
    let carried = 0;
    let last: string | undefined;
    for (const sessionId of ids) {
      if (carried >= limit) return { sessions, next: last as string };
      const ledger = await this.boards.read(sessionId).catch(() => null);
      last = sessionId;
      if (ledger === null) continue;
      const items = agendaSnapshot(ledger).items;
      if (items.length === 0) continue;
      sessions.push({ sessionId, items });
      carried += items.length;
    }
    return { sessions };
  }
}
