import type { LaneProposalAgenda, LaneProposalCard } from '../../lib/board-projects/index.ts';
import type { AgendaMutation } from '../../lib/agenda/state-machine.ts';
import type { RaiseAgendaRequest } from '../../lib/agenda/state-machine.ts';

/** The one operation of the agenda service this adapter needs. */
export interface AgendaRaiser {
  raise(
    sessionId: string,
    request: RaiseAgendaRequest,
    actor: { readonly kind: 'daemon'; readonly cause: 'system' },
  ): Promise<AgendaMutation>;
}

/**
 * Raises a lane proposal as a daemon-sourced `task` choice on the proposing session's agenda. The reference
 * is stable per project and version, so raising the same proposal twice is one card.
 */
export class AgendaLaneAgenda implements LaneProposalAgenda {
  constructor(private readonly attention: AgendaRaiser) {}

  async raise(sessionId: string, reference: string, card: LaneProposalCard): Promise<void> {
    const mutation = await this.attention.raise(
      sessionId,
      {
        source: 'task',
        sourceRef: reference,
        subject: card.subject,
        title: card.title,
        kind: card.kind,
        ask: card.ask,
        answers: card.answers,
        why: card.why,
        howToResolve: card.howToResolve,
      },
      { kind: 'daemon', cause: 'system' },
    );
    if (!mutation.ok) throw new Error(`the lane proposal could not be raised: ${mutation.error.message}`);
  }
}
