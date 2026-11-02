import { type AgendaId, AgendaIdSchema } from '@ferretry/protocol';
import type { AgendaService } from '../agenda/service.ts';
import type { AgendaActor } from '../agenda/state-machine.ts';
import type { TwoFactorSeedAgendaPort, TwoFactorSeedCard } from './two-factor-seeds.ts';

const SEED_CARD_ACTOR: AgendaActor = { kind: 'daemon', cause: 'system' };

/**
 * A staged 2FA seed's card on the owner's agenda (docs/secrets.md, "2FA keys"). Every word is the daemon's: which
 * account, who asked, from where and when. The card saves nothing by itself: its Allow runs the `add-2fa-key` passkey
 * ceremony bound to the stage and then the commit, and an agenda answer is refused, so an app from before these cards
 * shows the words and cannot save.
 */
export class TwoFactorSeedAgendaAdapter implements TwoFactorSeedAgendaPort {
  constructor(private readonly agenda: Pick<AgendaService, 'raise' | 'resolve'>) {}

  async raise(sessionId: string, card: TwoFactorSeedCard): Promise<AgendaId> {
    const outcome = await this.agenda.raise(
      sessionId,
      {
        source: 'question',
        sourceRef: card.stage,
        kind: 'permission',
        title: 'Save automatic codes?',
        // The stage alone: the account's handle is often its label and username, and every ferret reads the agenda.
        twoFactorSeed: { stage: card.stage },
        subject: card.subject,
        why: card.why,
        context: card.context,
        howToResolve:
          'Allow on this card in the Ferretry app, then confirm with your passkey; Deny drops it. Nothing is saved without your passkey.',
        neededBy: card.expiresAt,
      },
      SEED_CARD_ACTOR,
    );
    if (!outcome.ok) throw new Error(outcome.error.message);
    if (outcome.item === undefined) throw new Error('the agenda kept no card for this 2FA key');
    return outcome.item.id;
  }

  async close(sessionId: string, id: AgendaId, note: string): Promise<void> {
    const parsed = AgendaIdSchema.safeParse(id);
    if (!parsed.success) return;
    await this.agenda.resolve(sessionId, parsed.data, SEED_CARD_ACTOR, note).catch(() => undefined);
  }
}
