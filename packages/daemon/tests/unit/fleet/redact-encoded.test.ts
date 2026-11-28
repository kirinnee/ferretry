import { describe, expect, it } from 'bun:test';
import { redactText } from '../../../src/lib/fleet/catalog.ts';
import { referenceRedactEncoded } from '../../support/redact-encoded-r3.ts';
import {
  ENCODED_SHAPES,
  ENCODED_WRAPPERS,
  encodedSample,
  exposedEncoded,
} from '../../support/redact-encoded-samples.ts';

describe('whole-word encoded scanning before additional path masking', () => {
  it('masks complete padded ciphertext before a key-shaped suffix can split it', () => {
    const value = `${'A'.repeat(43)}/${encodedSample(0, 32)}`;
    expect(redactText(value).text).toBe('‹hidden›');
  });
  it('never revives low-entropy fragments after masking a key-shaped span', () => {
    for (let sample = 0; sample < 100; sample++) {
      const value = `${'Ab1'.repeat(11)}/${encodedSample(sample, 32)}`;
      const reference = referenceRedactEncoded(value, () => {});
      expect(exposedEncoded(redactText(value).text, value)).toBeLessThanOrEqual(exposedEncoded(reference, value));
    }
  });
  for (const [shape, length] of ENCODED_SHAPES) {
    for (const [wrapper, wrap] of ENCODED_WRAPPERS) {
      it(`${shape} with '/' in ${wrapper} never exposes more than 5e4f86 per sample`, () => {
        const failures: number[] = [];
        let checked = 0;
        const count = length === 32 ? 10_000 : 1_000;
        for (let sample = 0; checked < count; sample++) {
          const value = encodedSample(sample, length);
          if (!value.includes('/')) continue;
          checked++;
          const input = wrap(value);
          const current = redactText(input).text;
          const reference = referenceRedactEncoded(input, () => {});
          if (
            exposedEncoded(current, value) > exposedEncoded(reference, value) ||
            (length === 32 && current.includes(value))
          )
            failures.push(sample);
        }
        expect(failures).toEqual([]);
      });
    }
  }
});
