import type { InputTarget, InputTargetFacts, SecureCopyProvider } from '../../../contract/index.ts';
import {
  CopyMetaSchema,
  CopyOriginSchema,
  type CopyMeta,
  type CopyName,
  type CopyOrigin,
} from '../../lib/inputs/borrowed.ts';
import type { InputPasteRules, InputSealedPort } from '../../lib/inputs/ports.ts';

/** The `input.secure-copy:copy` provider in effect now, or nothing when Accounts is off (§4.7). */
export type SecureCopyProviderLookup = () => SecureCopyProvider | undefined;

/**
 * THE VAULT'S VIEW OF ACCOUNTS' SECURE COPIES, looked up on every call: an Accounts that was turned off since a card was
 * raised answers "no copy", so nothing is pasted and no rule matches (fail closed).
 *
 * What a provider says about a copy is PARSED here against the Vault's own strict schema: a field a ferret may not see
 * is refused, never shown. A provider that throws is the same as no copy.
 */
export class SecureCopiesThroughHook implements InputSealedPort, InputPasteRules {
  constructor(private readonly provider: SecureCopyProviderLookup) {}

  describe(sessionId: string, name: CopyName): CopyMeta | undefined {
    try {
      const told = this.provider()?.describe(sessionId, name);
      if (told === undefined) return undefined;
      const parsed = CopyMetaSchema.safeParse(told);
      return parsed.success && parsed.data.state === 'live' ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  open(sessionId: string, name: CopyName): string | undefined {
    try {
      return this.provider()?.open(sessionId, name);
    } catch {
      return undefined;
    }
  }

  used(sessionId: string, name: CopyName, target: InputTarget): void {
    try {
      this.provider()?.used(sessionId, name, target);
    } catch {
      // Told after the write: a count that could not be kept changes nothing that was typed.
    }
  }

  async refusal(sessionId: string, name: CopyName, target: InputTarget): Promise<string | undefined> {
    try {
      return await this.provider()?.refusal(sessionId, name, target);
    } catch {
      // A provider that cannot say whether the page is free is not trusted with the paste.
      return 'Ferretry could not check that nobody has taken the page over, so nothing was pasted.';
    }
  }

  reserve(sessionId: string, from: CopyOrigin, facts: InputTargetFacts, profile?: string): string | undefined {
    try {
      const origin = CopyOriginSchema.safeParse(from);
      if (!origin.success) return undefined;
      return this.provider()?.reserve(sessionId, origin.data, facts, profile);
    } catch {
      return undefined;
    }
  }

  release(ruleId: string): void {
    try {
      this.provider()?.release(ruleId);
    } catch {
      // A use that could not be given back stays spent: the stricter side.
    }
  }

  spent(ruleId: string): void {
    try {
      this.provider()?.spent(ruleId);
    } catch {
      // Told after the write.
    }
  }
}
