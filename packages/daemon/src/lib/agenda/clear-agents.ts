import { AGENDA_CLEAR_AGENTS_NOTE, type AgendaClearAgentsResult } from '@ferretry/protocol';
import type { AgendaLedgerRepository, AgendaService } from './service.ts';
import { type AgendaActor, agendaSnapshot } from './state-machine.ts';

/** Which sessions on this machine are agent ferrets: the ones the Inbox's "Agents" filter lists (`config.mode` `auto`). */
export interface AgentSessionDirectory {
  agentSessionIds(): Promise<readonly string[]>;
}

/**
 * THE OWNER'S "CLEAR ALL FROM AGENT FERRETS" (docs/agenda.md § Clearing the agent ferrets' backlog): every open
 * item on the board of every non-interactive session on this machine is DISMISSED, as the owner, with one
 * resolution note. An interactive ferret's board is never read. One item at a time through the ordinary dismiss,
 * so each leaves the same trail and tells its ferret as any dismiss does; a board that cannot be read, or an
 * item that cannot be dismissed, is skipped and not counted — the number is what actually went.
 */
export class AgendaAgentClearer {
  constructor(
    private readonly agents: AgentSessionDirectory,
    private readonly boards: Pick<AgendaLedgerRepository, 'read'>,
    private readonly agenda: Pick<AgendaService, 'dismiss'>,
  ) {}

  /** What a clear would dismiss now; changes nothing. */
  async preview(): Promise<AgendaClearAgentsResult> {
    let cleared = 0;
    let sessions = 0;
    for (const sessionId of await this.agents.agentSessionIds()) {
      const open = await this.openIds(sessionId);
      cleared += open.length;
      if (open.length > 0) sessions += 1;
    }
    return { cleared, sessions };
  }

  /** Dismisses every open item on the agent ferrets' boards, as `actor` (the owner). */
  async clear(actor: AgendaActor): Promise<AgendaClearAgentsResult> {
    let cleared = 0;
    let sessions = 0;
    for (const sessionId of await this.agents.agentSessionIds()) {
      let here = 0;
      for (const id of await this.openIds(sessionId)) {
        const dismissed = await this.agenda.dismiss(sessionId, id, actor, AGENDA_CLEAR_AGENTS_NOTE).catch(() => null);
        if (dismissed?.ok === true && dismissed.changed) here += 1;
      }
      cleared += here;
      if (here > 0) sessions += 1;
    }
    return { cleared, sessions };
  }

  private async openIds(sessionId: string): Promise<readonly string[]> {
    const ledger = await this.boards.read(sessionId).catch(() => null);
    // A card's gate item is the owner's ask about a card, not a ferret's backlog: clearing never touches one.
    return ledger === null
      ? []
      : agendaSnapshot(ledger)
          .items.filter(item => item.gate === undefined)
          .map(item => item.id);
  }
}
