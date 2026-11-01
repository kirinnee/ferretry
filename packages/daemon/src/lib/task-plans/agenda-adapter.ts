import { AgendaIdSchema } from '@ferretry/protocol';
import type { AgendaService } from '../agenda/service.ts';
import type { AgendaActor } from '../agenda/state-machine.ts';
import type { TaskPlanAgendaPort, TaskPlanCard } from './service.ts';

const PLAN_CARD_ACTOR: AgendaActor = { kind: 'daemon', cause: 'secure-copy' };

/**
 * A task plan's card on the owner's agenda, raised by the DAEMON only: the `taskPlan` ref is set here and nowhere a
 * ferret's body reaches (an agenda add is a strict schema with no field for it). The daemon words the ask and every
 * line; the ferret's reason rides in the context after "The ferret says". The card itself approves nothing: the agenda
 * refuses a plain answer to it, and approving is the owner's plan routes (ticks, picks, and a passkey for a sign-in).
 * A plan with paste lines also carries the paste-plan ref, so an app from before task plans answers those as it always
 * did, through the paste-plan route.
 */
export class TaskPlanAgendaAdapter implements TaskPlanAgendaPort {
  constructor(private readonly agenda: Pick<AgendaService, 'raise' | 'resolve'>) {}

  async raise(
    sessionId: string,
    card: TaskPlanCard,
  ): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
    const outcome = await this.agenda.raise(
      sessionId,
      {
        source: 'question',
        sourceRef: card.planId,
        kind: 'permission',
        taskPlan: { planId: card.planId },
        ...(card.pastes ? { copyPlan: { planId: card.planId } } : {}),
        subject: card.ask,
        why: card.ask,
        context: card.context,
        howToResolve: card.howToResolve,
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
