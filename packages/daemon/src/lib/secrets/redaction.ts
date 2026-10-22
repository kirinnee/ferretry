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
 *
 * ONE OPEN PER READ, NOT PER STRING. Opening the vault reads the key file and the ciphertext from
 * disk, and a page of a session's journal or transcript is up to hundreds of strings. Opening it once
 * per string made one page cost hundreds of key-file reads. `batch` opens it once and hands the work
 * two pure functions over the values it opened; they are revoked when the work returns, so the
 * plaintext lives exactly as long as that one call and nothing outlives it — no cache across
 * requests and no state on this object.
 */

import type { SecretName } from '@ferretry/protocol';
import { redactJsonValue, redactSecretValues } from './policy.ts';
import type { SecretVault } from './vault.ts';

/**
 * The values of one vault open, as two pure functions.
 *
 * Valid ONLY while the `batch` that handed it over is running: a scrub kept past that throws rather
 * than masking with values the daemon has since let go of. So the work given to `batch` is
 * synchronous by design — an `await` inside it would end the batch before the scrubbing after it.
 */
export interface Scrub {
  text(text: string): string;
  data(value: unknown): unknown;
}

/**
 * What the operator read surface asks of redaction, expressed where that surface can depend on it
 * without depending on the secret subsystem at all.
 */
export interface TextRedactor {
  redact(text: string): Promise<string>;
  redactData(value: unknown): Promise<unknown>;
  /** Many strings under ONE vault open. A vault that cannot be opened rejects before `work` runs. */
  batch<T>(work: (scrub: Scrub) => T): Promise<T>;
}

/** The scrub of a daemon with nothing to hide. */
const IDENTITY_SCRUB: Scrub = {
  text: text => text,
  data: value => value,
};

/** A redactor for a daemon with no secret store wired: it has nothing to scrub and says so by
 *  returning its input. It exists so the read surface has one shape to depend on. */
export const NO_REDACTION: TextRedactor = {
  redact: async text => text,
  redactData: async value => value,
  batch: async work => work(IDENTITY_SCRUB),
};

/** Masks every known value. See `policy.redactSecretValues` for exactly what that does and does not
 *  catch — in particular that a value an agent deliberately transformed is not recognisable. */
export class SecretRedactor implements TextRedactor {
  constructor(private readonly vault: SecretVault) {}

  async redact(text: string): Promise<string> {
    return await this.batch(scrub => scrub.text(text));
  }

  async redactData(value: unknown): Promise<unknown> {
    return await this.batch(scrub => scrub.data(value));
  }

  async batch<T>(work: (scrub: Scrub) => T): Promise<T> {
    let opened: ReadonlyMap<SecretName, string> | undefined = await this.vault.values();
    const values = (): ReadonlyMap<SecretName, string> => {
      if (opened === undefined) throw new Error('a scrub was used after the batch that opened its values ended');
      return opened;
    };
    try {
      return work({
        text: text => redactSecretValues(text, values()),
        data: value => redactJsonValue(value, values()),
      });
    } finally {
      // Revoked, so a scrub that escaped its work holds nothing.
      opened = undefined;
    }
  }
}
