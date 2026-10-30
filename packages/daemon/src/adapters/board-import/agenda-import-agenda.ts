import {
  type AskLink,
  type ImportAgenda,
  linkAsksIn,
  type UnlinkedAsk,
  unlinkedAsksOf,
} from '../../lib/board-import/index.ts';
import type { AgendaLedgerRepository } from '../../lib/agenda/service.ts';
import { agendaSnapshot } from '../../lib/agenda/state-machine.ts';

/** The agenda ledgers the import points at cards, edited in place through the ledger repository's own transaction. */
export class AgendaImportAgenda implements ImportAgenda {
  constructor(
    private readonly ledgers: AgendaLedgerRepository,
    private readonly now: () => string,
  ) {}

  async unlinked(sessionId: string): Promise<readonly UnlinkedAsk[]> {
    return unlinkedAsksOf(await this.ledgers.read(sessionId));
  }

  async link(sessionId: string, links: readonly AskLink[]): Promise<number> {
    let linked = 0;
    const outcome = await this.ledgers.transact(sessionId, current => {
      if (current === null) return { ok: false, error: { code: 'not-found', message: 'the session has no agenda' } };
      const edit = linkAsksIn(current, links, this.now());
      linked = edit.linked;
      return {
        ok: true,
        changed: edit.linked > 0,
        change: edit.linked > 0 ? 'refreshed' : 'unchanged',
        ledger: edit.ledger,
        snapshot: agendaSnapshot(edit.ledger),
      };
    });
    if (!outcome.ok && outcome.error.code !== 'not-found') throw new Error(outcome.error.message);
    return linked;
  }
}
