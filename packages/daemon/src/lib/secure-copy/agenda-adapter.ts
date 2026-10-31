import { AgendaIdSchema } from '@ferretry/protocol';
import type { AgendaService } from '../agenda/service.ts';
import type { AgendaActor } from '../agenda/state-machine.ts';
import type { CopyPlanAgendaPort, CopyPlanCard } from './plans.ts';

const PLAN_CARD_ACTOR: AgendaActor = { kind: 'daemon', cause: 'secure-copy' };

/**
 * A paste plan's card on the owner's agenda. The daemon words the ask and lists the routes; the agent's own reason
 * for each rides in the context after "The agent says". The card itself approves nothing: approving is the
 * owner-only plan route (`fy copy plan approve`), so answering the card's text can never allow a paste.
 */
export class CopyPlanAgendaAdapter implements CopyPlanAgendaPort {
  constructor(private readonly agenda: Pick<AgendaService, 'raise' | 'resolve'>) {}

  async raise(
    sessionId: string,
    card: CopyPlanCard,
  ): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
    const outcome = await this.agenda.raise(
      sessionId,
      {
        source: 'question',
        sourceRef: card.planId,
        kind: 'permission',
        copyPlan: { planId: card.planId },
        subject: card.ask,
        why: card.ask,
        context: card.context,
        howToResolve: `Tick the pastes you allow on the card, or at the machine: \`fy copy plan approve ${card.planId} <numbers>\`.`,
        neededBy: card.expiresAt,
      },
      PLAN_CARD_ACTOR,
    );
    if (!outcome.ok) return { ok: false, message: outcome.error.message };
    return outcome.item === undefined
      ? { ok: false, message: 'the agenda kept no card for this plan' }
      : { ok: true, id: outcome.item.id };
  }

  async close(sessionId: string, id: string, note: string): Promise<void> {
    const parsed = AgendaIdSchema.safeParse(id);
    if (!parsed.success) return;
    await this.agenda.resolve(sessionId, parsed.data, PLAN_CARD_ACTOR, note).catch(() => undefined);
  }
}
