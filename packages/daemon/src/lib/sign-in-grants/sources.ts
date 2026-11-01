import type { AccountId, AccountKey, GrantMissReason } from '@ferretry/protocol';
import type { SignInGrantLedger } from './ledger.ts';
import type { ScriptedOriginsView, SignInGrant } from './matcher.ts';
import type { GrantFillAt, GrantVerdict, SignInGrantSource } from './plans.ts';

/**
 * EVERY GRANT SOURCE AS ONE (docs/input-requests.md, "Standing rule fills"): the owner's task-plan lines and standing
 * rules, read through one matcher, one ledger, one clear and one reason list. Each source answers only for its own
 * grants: `used`, `stopped`, `verify` and `holds` go to the source the grant came from, so a plan line can never be
 * suspended as a rule nor a rule spent as a plan line.
 *
 * - **One ledger.** Both sources must hold the very instance given here (refused at construction otherwise), so the
 *   hourly rate counts plan and rule fills of a sign-in together, and neither source's `retain` forgets the other's
 *   attempts or pins.
 * - **Each behind its own feature.** A source that is not enabled contributes no grant, so with `sign-in-rules.1`
 *   unadvertised every sign-in a rule would cover is a normal card.
 * - **The soonest to expire first.** A plan line usually ends before a rule, so it spends before one.
 */
export class CombinedSignInGrants implements SignInGrantSource {
  constructor(
    private readonly plans: SignInGrantSource,
    private readonly rules: SignInGrantSource,
    readonly ledger: SignInGrantLedger,
  ) {
    if (plans.ledger !== ledger || rules.ledger !== ledger)
      throw new Error('every sign-in grant source must share the one ledger');
  }

  enabled(): boolean {
    return this.plans.enabled() || this.rules.enabled();
  }

  of(sessionId: string): readonly SignInGrant[] {
    return [
      ...(this.plans.enabled() ? this.plans.of(sessionId) : []),
      ...(this.rules.enabled() ? this.rules.of(sessionId) : []),
    ].toSorted((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id));
  }

  async keyOf(account: AccountId): Promise<AccountKey | undefined> {
    return await this.plans.keyOf(account);
  }

  used(grant: SignInGrant, at: number, sessionId: string): void {
    this.#sourceOf(grant).used(grant, at, sessionId);
  }

  async stopped(grant: SignInGrant, because: GrantMissReason): Promise<void> {
    await this.#sourceOf(grant).stopped(grant, because);
  }

  async verify(grant: SignInGrant): Promise<GrantVerdict> {
    return await this.#sourceOf(grant).verify(grant);
  }

  holds(grant: SignInGrant, at: GrantFillAt): boolean {
    return this.#sourceOf(grant).holds(grant, at);
  }

  async projectOf(sessionId: string): Promise<string | undefined> {
    return await this.rules.projectOf(sessionId);
  }

  scriptedOrigins(): ScriptedOriginsView {
    return this.rules.scriptedOrigins();
  }

  #sourceOf(grant: SignInGrant): SignInGrantSource {
    return grant.source === 'rule' ? this.rules : this.plans;
  }
}
