import { mergeRanges } from '../secrets/policy.ts';
import type { Scrub, TextRange, TextRedactor } from '../secrets/redaction.ts';
import type { EphemeralValues } from './ephemeral-values.ts';

/** The mask for text that holds a just-typed value AND a vault secret overlapping it: neither can be named. */
const BOTH_MASK = '[redacted]';

/**
 * THE VAULT'S REDACTOR AND THE JUST-TYPED VALUES, as ONE redactor. Every operator read of a screen, a
 * transcript or a journal page, and every other place the daemon masks a secret, goes through a
 * {@link TextRedactor}; wiring this one in front of the vault's puts a value the owner just typed behind the
 * same boundary as a vault secret, in all of them at once. A read has no session to name, so it masks the
 * values of every session: over-masking a coincidence is the safe side. If the vault cannot be opened the
 * read fails, exactly as it does without this wrapper.
 *
 * THE TWO STORES ARE MASKED AS A UNION, not one after the other. Masking one store first rewrites the text,
 * so a vault secret that overlaps a just-typed value no longer matches and its uncovered characters stay in
 * plain view. Both stores are asked WHERE they match in the original text, the matches are merged, and each
 * merged run is replaced once: by its own store's mask when one store covers it, by a plain
 * `[redacted]` when both do.
 */
export class EphemeralAwareRedactor implements TextRedactor {
  constructor(
    private readonly inner: TextRedactor,
    private readonly values: EphemeralValues,
  ) {}

  async redact(text: string): Promise<string> {
    return await this.inner.batch(scrub => this.mask(scrub, text));
  }

  async redactData(value: unknown): Promise<unknown> {
    return await this.inner.batch(scrub => this.maskStrings(scrub, value));
  }

  async batch<T>(work: (scrub: Scrub) => T): Promise<T> {
    return await this.inner.batch(scrub =>
      work({
        text: text => this.mask(scrub, text),
        data: value => this.maskStrings(scrub, value),
        cover: text => mergeRanges([...scrub.cover(text), ...this.values.coverAll(text)]),
      }),
    );
  }

  private mask(scrub: Scrub, text: string): string {
    const typed = this.values.coverAll(text);
    if (typed.length === 0) return scrub.text(text);
    const vault = scrub.cover(text);
    let result = '';
    let at = 0;
    for (const run of mergeRanges([...typed, ...vault])) {
      const piece = text.slice(run.start, run.end);
      const fromTyped = typed.some(range => overlaps(range, run));
      const fromVault = vault.some(range => overlaps(range, run));
      result += text.slice(at, run.start);
      result += fromTyped && fromVault ? BOTH_MASK : fromTyped ? this.values.scrubAll(piece) : scrub.text(piece);
      at = run.end;
    }
    return result + text.slice(at);
  }

  private maskStrings(scrub: Scrub, value: unknown): unknown {
    if (typeof value === 'string') return this.mask(scrub, value);
    if (Array.isArray(value)) return value.map(entry => this.maskStrings(scrub, entry));
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
          this.mask(scrub, key),
          this.maskStrings(scrub, entry),
        ]),
      );
    return value;
  }
}

const overlaps = (inner: TextRange, run: TextRange): boolean => inner.start < run.end && inner.end > run.start;
