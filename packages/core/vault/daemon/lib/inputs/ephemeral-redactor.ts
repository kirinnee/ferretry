import type { Scrub, TextRedactor } from '../secrets/redaction.ts';
import type { EphemeralValues } from './ephemeral-values.ts';

/**
 * Vault, contributed and just-typed values share ONE pass over the original text, including cut
 * prefixes. No replacement runs before the other sources can find their matches. The inner read
 * still owns the vault lifetime and refuses before calling the reader if it cannot open.
 */
export class EphemeralAwareRedactor implements TextRedactor {
  constructor(
    private readonly inner: TextRedactor,
    private readonly values: EphemeralValues,
  ) {}

  async redact(text: string): Promise<string> {
    return await this.batch(scrub => scrub.text(text));
  }

  async redactData(value: unknown): Promise<unknown> {
    return await this.batch(scrub => scrub.data(value));
  }

  async batch<T>(work: (scrub: Scrub) => T): Promise<T> {
    return await this.inner.batch(scrub => work(this.scope(scrub)));
  }

  async scoped<T>(work: (scrub: Scrub) => Promise<T>): Promise<T> {
    return await this.inner.scoped(scrub => work(this.scope(scrub)));
  }

  /** Compose into a kernel read without opening a second vault or retaining plaintext in a scope. */
  scope(scrub: Scrub): Scrub {
    return this.values.compose(scrub);
  }
}
