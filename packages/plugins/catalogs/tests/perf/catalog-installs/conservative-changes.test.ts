import { describe, it } from 'bun:test';
import should from 'should';
import { MAX_SCANNED, mayHoldSecret } from '../../../daemon/lib/catalog-installs/conservative-changes.ts';

// The speed half of `tests/unit/catalog-installs/conservative-changes.test.ts`: the secret scan stays linear on the
// largest text it will scan. The unit file runs the same shapes at a small size.
describe('mayHoldSecret: the scan is linear', () => {
  it.each([
    ['a prefix repeated', 'sk-'.repeat(MAX_SCANNED / 3)],
    ['colons and at-signs', ':@'.repeat(MAX_SCANNED / 2)],
    ['scheme marks', '://'.repeat(MAX_SCANNED / 3)],
    ['scheme marks with no end', `://${'a'.repeat(MAX_SCANNED - 3)}`],
    ['line breaks', '\n'.repeat(MAX_SCANNED)],
    ['plain prose', 'lorem ipsum '.repeat(MAX_SCANNED / 12)],
  ])('should finish in linear time on 2 MiB of %s', (_label, text) => {
    const started = performance.now();
    mayHoldSecret(text);
    should(performance.now() - started).be.below(2_000);
  });
});
