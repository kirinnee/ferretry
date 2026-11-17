/**
 * CFG-LEAK (ii) fix 4 (G1): the hooks net reads a number, `true` and `null` beside and ON a refused path, and a
 * document nested past the depth cap is withheld whole. Fake values only.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { hooksDocumentRefusedLines } from '../../../daemon/lib/service/hooks-document-net.ts';

const V = 'Zk3pQ9vXw2LmN7rT';

const lines = (text: string): number[] => {
  const found = hooksDocumentRefusedLines(text);
  if (found === undefined || found === 'whole') throw new Error('expected a set of lines');
  return [...found].sort((a, b) => a - b);
};

describe('the hooks net reads scalars that are not strings', () => {
  it('should withhold only the refused line when a number, true and null sit beside it', () => {
    // Arrange
    const text = JSON.stringify(
      { timeout: 5, enabled: true, note: null, hooks: [{ command: `tool --token ${V}` }], retries: -1.5e2 },
      undefined,
      2,
    );
    const at = text.split('\n').findIndex(line => line.includes(V));

    // Act
    const found = lines(text);

    // Assert
    should(found).deepEqual([at]);
  });

  for (const [name, scalar] of [
    ['a number', '12345'],
    ['true', 'true'],
    ['null', 'null'],
  ] as const) {
    it(`should not withhold a secret-shaped key holding a non-string scalar (W accepts it) when the value is ${name}`, () => {
      // Arrange
      const text = `{\n  "ok": 1,\n  "apiToken": ${scalar},\n  "after": false\n}`;

      // Act
      const found = hooksDocumentRefusedLines(text);

      // Assert: the write rule judges strings only, so the document is accepted and no line is withheld
      should(found).equal(undefined);
    });
  }

  it('should withhold the whole text when the refused document is nested past the depth cap', () => {
    // Arrange
    const depth = 250;
    const text = `{"command":"tool --token ${V}","deep":${'['.repeat(depth)}${']'.repeat(depth)}}`;

    // Act
    const found = hooksDocumentRefusedLines(text);

    // Assert
    should(found).equal('whole');
  });

  for (const depth of [1_000, 100_000]) {
    it(`should withhold the whole text, not throw, when a refused command sits beside a list nested ${String(depth)} deep`, () => {
      // Arrange: past what the call stack allows a recursive walker; the parser still reads it
      const text = `{"command":"tool --token ${V}","deep":${'['.repeat(depth)}${']'.repeat(depth)}}`;

      // Act
      const found = hooksDocumentRefusedLines(text);

      // Assert
      should(found).equal('whole');
    });
  }

  it('should list nothing, not throw, when a list nested 100,000 deep holds nothing refused', () => {
    // Arrange
    const text = `{"command":"tool --quiet","deep":${'['.repeat(100_000)}${']'.repeat(100_000)}}`;

    // Act
    const found = hooksDocumentRefusedLines(text);

    // Assert
    should(found).equal(undefined);
  });
});
