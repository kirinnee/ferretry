/**
 * Scrubbing known secret values out of anything this daemon is about to store or render.
 *
 * THIS IS THE PIECE THAT MAKES THE CLAIM TRUE. "A secret never appears in your transcripts" rests on
 * the daemon knowing the values and removing them; without it the promise is only "we did not put it
 * there on purpose", which is not a property anyone can rely on.
 *
 * IT FAILS CLOSED. A vault that cannot be opened means this daemon does not know what to scrub, and
 * text it cannot scrub is text it must not serve — so the failure travels to the caller, which turns
 * it into a refusal. Serving the raw text with a warning would be the leak; serving a blank would be
 * the "damaged state read as empty state" defect. A store that has simply never been written is a
 * different fact: there is nothing to mask and the text passes through unchanged.
 */

import type { SecretName } from '@ferretry/protocol';
import { redactJsonValue, redactSecretValues } from './policy.ts';
import type { SecretVault } from './vault.ts';

/**
 * What the operator read surface asks of redaction, expressed where that surface can depend on it
 * without depending on the secret subsystem at all.
 */
export interface TextRedactor {
  redact(text: string): Promise<string>;
  redactData(value: unknown): Promise<unknown>;
}

/** A redactor for a daemon with no secret store wired: it has nothing to scrub and says so by
 *  returning its input. It exists so the read surface has one shape to depend on. */
export const NO_REDACTION: TextRedactor = {
  redact: async text => text,
  redactData: async value => value,
};

/** Masks every known value. See `policy.redactSecretValues` for exactly what that does and does not
 *  catch — in particular that a value an agent deliberately transformed is not recognisable. */
export class SecretRedactor implements TextRedactor {
  constructor(private readonly vault: SecretVault) {}

  async redact(text: string): Promise<string> {
    return redactSecretValues(text, await this.values());
  }

  async redactData(value: unknown): Promise<unknown> {
    return redactJsonValue(value, await this.values());
  }

  private async values(): Promise<ReadonlyMap<SecretName, string>> {
    return await this.vault.values();
  }
}
