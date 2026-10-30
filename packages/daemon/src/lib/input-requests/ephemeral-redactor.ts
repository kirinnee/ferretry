import type { Scrub, TextRedactor } from '../secrets/redaction.ts';
import type { EphemeralValues } from './ephemeral-values.ts';

/**
 * THE VAULT'S REDACTOR AND THE JUST-TYPED VALUES, as ONE redactor. Every operator read of a screen, a
 * transcript or a journal page, and every other place the daemon masks a secret, goes through a
 * {@link TextRedactor}; wiring this one in front of the vault's puts a value the owner just typed behind the
 * same boundary as a vault secret, in all of them at once. A read has no session to name, so it masks the
 * values of every session: over-masking a coincidence is the safe side. If the vault cannot be opened the
 * read fails, exactly as it does without this wrapper.
 */
export class EphemeralAwareRedactor implements TextRedactor {
  constructor(
    private readonly inner: TextRedactor,
    private readonly values: EphemeralValues,
  ) {}

  async redact(text: string): Promise<string> {
    return await this.inner.redact(this.values.scrubAll(text));
  }

  async redactData(value: unknown): Promise<unknown> {
    return await this.inner.redactData(this.maskStrings(value));
  }

  async batch<T>(work: (scrub: Scrub) => T): Promise<T> {
    return await this.inner.batch(scrub =>
      work({
        text: text => scrub.text(this.values.scrubAll(text)),
        data: value => scrub.data(this.maskStrings(value)),
      }),
    );
  }

  private maskStrings(value: unknown): unknown {
    if (typeof value === 'string') return this.values.scrubAll(value);
    if (Array.isArray(value)) return value.map(entry => this.maskStrings(entry));
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
          this.values.scrubAll(key),
          this.maskStrings(entry),
        ]),
      );
    return value;
  }
}
