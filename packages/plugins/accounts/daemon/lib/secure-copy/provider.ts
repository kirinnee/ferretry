import type { BrowsersApi } from '@ferretry/plugin-browsers/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import type { InputTarget, InputTargetFacts, SecureCopyProvider } from '@ferretry/core-vault/contract';
import { CopyNameSchema, CopyOriginSchema } from '../../../contract/routes/index.ts';
import type { PasteRuleService } from './rules.ts';
import type { SecureCopyService } from './service.ts';

/** What a paste into a page is told when nobody can say whether a person holds it. */
const CANNOT_CHECK =
  'Ferretry could not check that nobody has taken the page over, so nothing was pasted. Try again shortly.';

/** What a paste into a page is told while a person holds it. */
export const TAKEN_OVER_PASTE =
  'A person has taken over that page, so nothing is pasted into it: wait for them to hand it back, or ask them.';

/**
 * WHAT ACCOUNTS GIVES THE VAULT'S INPUT BRIDGE (`input.secure-copy:copy`): the copies a paste draws from, the owner's
 * pre-approval rules, and the check that a person has not taken the page over. The one place a value leaves the copy
 * service is {@link open}, called by the Vault once per write, after every check that can refuse without typing.
 *
 * A name or an origin the Vault hands in is parsed against the contract before it is looked up, so a malformed one is
 * "no copy" and "no rule", never a guess.
 */
export class SecureCopyHook implements SecureCopyProvider {
  constructor(
    private readonly copies: SecureCopyService,
    private readonly rules: PasteRuleService,
    private readonly browsers: () => BrowsersApi | undefined,
  ) {}

  describe(sessionId: string, name: string): unknown {
    const parsed = CopyNameSchema.safeParse(name);
    return parsed.success ? this.copies.describe(sessionId, parsed.data) : undefined;
  }

  open(sessionId: string, name: string, capturedAt?: string): string | undefined {
    const parsed = CopyNameSchema.safeParse(name);
    return parsed.success ? this.copies.open(sessionId, parsed.data, capturedAt) : undefined;
  }

  used(sessionId: string, name: string, _target: InputTarget): void {
    const parsed = CopyNameSchema.safeParse(name);
    if (!parsed.success) return;
    this.copies.used(sessionId, parsed.data);
  }

  protect(sessionId: string, name: string, target: InputTarget, where: { readonly origins: readonly string[] }): void {
    const parsed = CopyNameSchema.safeParse(name);
    if (!parsed.success)
      throw new Error('Ferretry could not protect this paste (the copy has no usable name), so nothing was typed.');
    this.copies.protectPaste(sessionId, parsed.data, { kind: target.kind }, where);
  }

  async refusal(sessionId: string, name: string, target: InputTarget): Promise<string | undefined> {
    // A terminal's scrollback mask must have somewhere to live (a mask is never dropped while its value is readable).
    const parsed = CopyNameSchema.safeParse(name);
    if (target.kind === 'terminal' && parsed.success)
      return this.copies.scrollbackRefusal(sessionId, parsed.data, target);
    // Only a page can be held by a person: a terminal's takeover is the terminal tools' own check at their write.
    if (target.kind !== 'page') return undefined;
    const copy = this.browsers()?.copy;
    if (copy === undefined) return CANNOT_CHECK;
    return (await copy.takenOver(sessionId as FerretId, target.key)) ? TAKEN_OVER_PASTE : undefined;
  }

  reserve(sessionId: string, from: unknown, facts: InputTargetFacts, profile?: string): string | undefined {
    const origin = CopyOriginSchema.safeParse(from);
    return origin.success ? this.rules.reserve(sessionId, origin.data, facts, profile) : undefined;
  }

  release(ruleId: string): void {
    this.rules.release(ruleId);
  }

  spent(ruleId: string): void {
    this.rules.spent(ruleId);
  }
}
