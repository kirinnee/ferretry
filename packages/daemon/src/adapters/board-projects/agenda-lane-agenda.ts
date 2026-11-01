import {
  LANE_PROPOSAL_SOURCE,
  type LaneProposalAgenda,
  type LaneProposalCard,
} from '../../lib/board-projects/index.ts';
import type { AgendaMutation } from '../../lib/agenda/state-machine.ts';
import type { RaiseAgendaRequest } from '../../lib/agenda/state-machine.ts';

/** The two operations of the agenda service this adapter needs. */
export interface AgendaRaiser {
  raise(
    sessionId: string,
    request: RaiseAgendaRequest,
    actor: { readonly kind: 'daemon'; readonly cause: 'system' },
  ): Promise<AgendaMutation>;
  resolveSource(
    sessionId: string,
    source: 'task',
    sourceRef: string,
    actor: { readonly kind: 'daemon'; readonly cause: 'system' },
    note?: string | null,
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
        source: LANE_PROPOSAL_SOURCE,
        sourceRef: reference,
        subject: card.subject,
        title: card.title,
        kind: card.kind,
        ask: card.ask,
        answers: card.answers,
        why: card.why,
        ...(card.context === undefined ? {} : { context: card.context }),
        ...(card.recommendation === undefined ? {} : { recommendation: card.recommendation }),
        howToResolve: card.howToResolve,
      },
      { kind: 'daemon', cause: 'system' },
    );
    if (!mutation.ok) throw new Error(`the lane proposal could not be raised: ${mutation.error.message}`);
  }

  /** Closes the card for a proposal that is gone, with the owner-facing reason. A card already closed stays closed. */
  async withdraw(sessionId: string, reference: string, note: string): Promise<void> {
    const mutation = await this.attention.resolveSource(
      sessionId,
      'task',
      reference,
      { kind: 'daemon', cause: 'system' },
      note,
    );
    if (!mutation.ok) throw new Error(`the lane proposal card could not be withdrawn: ${mutation.error.message}`);
  }
}
