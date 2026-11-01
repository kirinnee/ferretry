import { AgendaIdSchema } from '@ferretry/protocol';
import type { AgendaService } from '../agenda/service.ts';
import type { AgendaActor } from '../agenda/state-machine.ts';
import type { SignInRuleSuggestionAgendaPort, SignInRuleSuggestionCard } from './suggestions.ts';

const SUGGESTION_CARD_ACTOR: AgendaActor = { kind: 'daemon', cause: 'secure-copy' };

/**
 * A ferret's standing-rule suggestion on the owner's agenda, raised by the DAEMON only: the `signInRuleSuggestion` ref is
 * set here and nowhere a ferret's body reaches (an agenda add is a strict schema with no field for it). The daemon words
 * the whole card; the ferret's reason is not in it. The agenda refuses a plain answer to it, so it can never read as an
 * approval: it opens the owner's create sheet with nothing ticked.
 */
export class SignInRuleSuggestionAgendaAdapter implements SignInRuleSuggestionAgendaPort {
  constructor(private readonly agenda: Pick<AgendaService, 'raise' | 'resolve' | 'list'>) {}

  async raise(
    sessionId: string,
    card: SignInRuleSuggestionCard,
  ): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
    const outcome = await this.agenda.raise(
      sessionId,
      {
        source: 'question',
        sourceRef: card.suggestionId,
        kind: 'permission',
        signInRuleSuggestion: { suggestion: card.suggestionId },
        subject: card.ask,
        why: card.ask,
        context: card.context,
        howToResolve: card.howToResolve,
        neededBy: card.expiresAt,
      },
      SUGGESTION_CARD_ACTOR,
    );
    if (!outcome.ok) return { ok: false, message: outcome.error.message };
    return outcome.item === undefined
      ? { ok: false, message: 'the agenda kept no card for this suggestion' }
      : { ok: true, id: outcome.item.id };
  }

  async isOpen(sessionId: string, id: string): Promise<boolean> {
    const listed = await this.agenda.list(sessionId);
    return listed.ok ? listed.value.items.some(item => item.id === id) : true;
  }

  async close(sessionId: string, id: string, note: string): Promise<void> {
    const parsed = AgendaIdSchema.safeParse(id);
    if (!parsed.success) return;
    await this.agenda.resolve(sessionId, parsed.data, SUGGESTION_CARD_ACTOR, note).catch(() => undefined);
  }
}
