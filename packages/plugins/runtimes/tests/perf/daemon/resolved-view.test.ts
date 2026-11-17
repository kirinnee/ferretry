import { describe, it } from 'bun:test';
import should from 'should';
import { shownFlags } from '../../support/resolved-view-support.ts';

// The Resolved view reads a launch flag in one pass, however long it is. What it shows and hides is
// tests/unit/daemon/resolved-view.test.ts, at a small size; this file holds only the time, at the full size.

const HIDDEN = '‹hidden›';
// biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
const P = '${secret:OTHER_TOKEN}';

describe('resolvedEntries is linear', () => {
  it('should read a run of keys and separators in one pass, not once from every character (linear)', () => {
    // Arrange — a long value of secret-named keys with short values, and a long run with no separator.
    const keys = `--set=${'token=ab,'.repeat(20_000)}`;
    const run = `--set=${'a'.repeat(200_000)}`;
    // Quoted short values (each walked to its closing quote once), and keys in a glued flag's own part.
    const quoted = `--set=${'token="ab",'.repeat(20_000)}`;
    const flagPart = `--hdr,${'token:ab,'.repeat(20_000)} x`;
    const started = performance.now();

    // Act
    const actual = shownFlags([keys, run, quoted, flagPart]);

    // Assert
    should(actual.map(word => word.value)).deepEqual([keys, run, quoted, flagPart]);
    should(performance.now() - started).be.below(2_000);
  });

  it('should read every key around pointers in one pass, however many share a value (linear)', () => {
    // Arrange — pointers chained with no separator, with spaces, an unclosed `${…:-` run and quotes opening in turn.
    const glued = `--set=${`password=${P}?`.repeat(20_000)}`;
    const spaced = `--set=${`API_KEY=${P} `.repeat(20_000)}`;
    const defaults = `--set=${'API_KEY=${A:-'.repeat(20_000)}}`;
    const quotes = `--set=${`api_key=${P}'x `.repeat(20_000)}`;
    const started = performance.now();

    // Act
    const actual = shownFlags([glued, spaced, defaults, quotes]);

    // Assert
    should(actual.map(word => word.value)).deepEqual([
      `--set=password=${HIDDEN}`,
      spaced,
      `--set=API_KEY=${HIDDEN}`,
      `--set=${`api_key=${HIDDEN} `.repeat(20_000)}`,
    ]);
    should(performance.now() - started).be.below(2_000);
  });
});
