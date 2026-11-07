import { type AskId, AskIdSchema, type AsksApi, type EntryId, type SourceKey } from '@ferretry/core-asks/contract';
import type { TwoFactorSeedAgendaPort, TwoFactorSeedCard } from './two-factor-seeds.ts';

/** The ask source every Accounts card is raised under (the manifest's `ask.sources:sign-in-approval`). */
export const SIGN_IN_APPROVAL_SOURCE = 'sign-in-approval' as SourceKey;

/**
 * A staged 2FA seed's card on the owner's agenda (docs/secrets.md, "2FA keys"). Every word is the daemon's: which
 * account, who asked, from where and when. The card saves nothing by itself: its Allow runs the `add-2fa-key` passkey
 * ceremony bound to the stage and then the commit, and an agenda answer is refused (S101).
 *
 * The ref names the stage alone: the account's handle is often its label and username, and every ferret reads the
 * agenda. (Its `two-factor-seed` arm is pending in the contract's `SignInApprovalRefSchema`; lead asked 2026-11-07.)
 */
export class TwoFactorSeedAgendaAdapter implements TwoFactorSeedAgendaPort {
  constructor(private readonly asks: Pick<AsksApi, 'raise' | 'close'>) {}

  async raise(sessionId: string, card: TwoFactorSeedCard): Promise<AskId> {
    return await this.asks.raise({
      source: SIGN_IN_APPROVAL_SOURCE,
      ref: { kind: 'two-factor-seed', stage: card.stage },
      entry: `two-factor-seed:${card.stage}` as EntryId,
      kind: 'permission',
      subject: card.subject,
      why: card.why,
      context: card.context,
      howToResolve:
        'Allow on this card in the Ferretry app, then confirm with your passkey; Deny drops it. Nothing is saved without your passkey.',
      raisedBy: { kind: 'daemon' },
      ferret: sessionId,
    });
  }

  async close(_sessionId: string, id: AskId, _note: string): Promise<void> {
    const parsed = AskIdSchema.safeParse(id);
    if (!parsed.success) return;
    await this.asks.close(parsed.data, 'withdrawn').catch(() => undefined);
  }
}
