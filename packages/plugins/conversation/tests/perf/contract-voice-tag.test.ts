import { describe, expect, test } from 'bun:test';
import { splitVoice } from '../../contract/index.ts';

/**
 * The SPEED half of the `<voice>` grammar (`contract/voice-tag.ts`): the chat reads every assistant message with it on every
 * token that streams in, and Read aloud reads it again, so a hostile message must cost about what one of words does. Every
 * scan is one left-to-right pass; a hundred thousand backticks or twenty thousand tags is the worst case measured here.
 */
const BUDGET_MS = 1_500;

const fastest = (run: () => unknown, runs = 3): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
};

describe('splitVoice stays linear on hostile input', () => {
  test.each([
    ['backticks', '`'.repeat(100_000)],
    ['alternating backtick runs', '`a``b```'.repeat(20_000)],
    ['open tags', '<voice>'.repeat(20_000)],
    ['closed lines', '<voice>x</voice>'.repeat(20_000)],
    ['open tags in code', '`<voice>`'.repeat(20_000)],
  ])('%s', (_name, body) => {
    expect(fastest(() => splitVoice(`<voice>${body}`))).toBeLessThan(BUDGET_MS);
  });
});
