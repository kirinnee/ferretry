import type { AsksApi, AskId } from '@ferretry/core-asks/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import type { AgendaClearAgentsResult } from '../../contract/index.ts';

/** The note each dismissal carries, so the ferret and the audit say who cleared it and why. */
const CLEARED_NOTE = 'cleared by the owner (agenda clear --agents)';

/** Which ferrets on this machine are agent ferrets: the ones the agenda's "Agents" filter lists. */
export interface AgentFerretDirectory {
  agentFerrets(): Promise<readonly FerretId[]>;
}

/**
 * THE OWNER'S "CLEAR ALL FROM AGENT FERRETS" (docs/agenda.md § Clearing the agent ferrets' backlog): every open ask on the
 * board of every non-interactive ferret on this machine is DISMISSED, as the owner. An interactive ferret's board is never
 * read. One ask at a time through the owner's own dismissal (`ownerDismiss`: the human actor, not the daemon's close, which may dismiss only what the daemon raised), so each leaves the same trail and tells its ferret as any dismiss
 * does; a board that cannot be read, or an ask that cannot be closed, is skipped and not counted — the number is what
 * actually went.
 */
export class AgendaAgentClearer {
  constructor(
    private readonly agents: AgentFerretDirectory,
    private readonly asks: Pick<AsksApi, 'open' | 'ownerDismiss'>,
  ) {}

  /** What a clear would dismiss now; changes nothing. */
  async preview(): Promise<AgendaClearAgentsResult> {
    let cleared = 0;
    let ferrets = 0;
    for (const ferret of await this.agents.agentFerrets()) {
      const open = await this.openIds(ferret);
      cleared += open.length;
      if (open.length > 0) ferrets += 1;
    }
    return { cleared, ferrets };
  }

  /** Dismisses every open ask on the agent ferrets' boards. */
  async clear(): Promise<AgendaClearAgentsResult> {
    let cleared = 0;
    let ferrets = 0;
    for (const ferret of await this.agents.agentFerrets()) {
      let here = 0;
      for (const id of await this.openIds(ferret)) {
        // The owner's own dismissal, whoever raised the ask: the daemon's close would dismiss only what the daemon raised.
        const closed = await this.asks.ownerDismiss({ ferret, id }, CLEARED_NOTE).then(
          () => true,
          () => false,
        );
        if (closed) here += 1;
      }
      cleared += here;
      if (here > 0) ferrets += 1;
    }
    return { cleared, ferrets };
  }

  private async openIds(ferret: FerretId): Promise<readonly AskId[]> {
    const open = await this.asks.open({ ferret, state: 'open' }).catch(() => []);
    // A card's ask is the owner's question about a card, not a ferret's backlog: clearing never touches one.
    return open.filter(ask => ask.source !== 'card').map(ask => ask.id);
  }
}
