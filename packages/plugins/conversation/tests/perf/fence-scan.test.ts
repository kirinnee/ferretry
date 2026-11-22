import { describe, expect, test } from 'bun:test';
import { settleFences } from '../../app/hypermedia/fence-boundaries.ts';
import { readMessage } from '../../app/hypermedia/parse-message.ts';

/**
 * The SPEED half of "where every fence of a message is decided": a message near the 300,000-byte cap that holds thousands
 * of fences and prose that talks about `fy-render` is read on the MAIN THREAD, again on every token that streams in. It
 * took 3.8 to 4.6 seconds when the scan was quadratic (a search of every fence for each of Durian's, a copy of the whole
 * tail for each fence). It is one linear pass now, and a message that only TALKS about `fy-render` (no fence opened with
 * it) is not read by micromark at all.
 */
const BUDGET_MS = 200;
const FENCE = '`'.repeat(3);
const NEAR_CAP = 299_000;

const repeated = (unit: string, size: number): string => {
  const parts: string[] = [];
  for (let length = 0; length + unit.length < size; length += unit.length) parts.push(unit);
  return parts.join('');
};

/** The fastest of a few runs: one sample measures the garbage collector that falls in it. */
const fastest = (run: () => unknown, runs = 5): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
};

describe('a near-cap message of thousands of fences that mentions fy-render', () => {
  const prose = repeated(`${FENCE}js\nconst x = 1;\n${FENCE}\nthe fy-render fence is how a chart is drawn\n`, NEAR_CAP);

  test('has its fence boundaries decided in under 200 ms', () => {
    expect(prose.length).toBeGreaterThan(NEAR_CAP - 100);
    settleFences(prose); // warm
    expect(fastest(() => settleFences(prose))).toBeLessThan(BUDGET_MS);
  });

  test('is read, boundaries and Durian together, in under 200 ms', () => {
    readMessage(prose, 'p-'); // warm: the first call builds the lexer and the YAML reader
    expect(fastest(() => readMessage(prose, 'p-'), 3)).toBeLessThan(BUDGET_MS);
  });
});

describe('a message that DOES open fy-render fences, among thousands of others', () => {
  const unit = `${FENCE}js\nx\n${FENCE}\nsee fy-render here\n`;
  const real = `${FENCE}fy-render\ntype: svg\nalt: a\n---\n<svg xmlns="http://www.w3.org/2000/svg"/>\n${FENCE}\n`;
  const message = (size: number): string => `${real}${repeated(unit, size)}`;

  // micromark reads this message, so a wall-clock budget would measure the machine; the shape of the cost is what is held:
  // four times the text is about four times the time (a quadratic scan makes it sixteen).
  test('costs about four times as much for four times the text, not sixteen', () => {
    const small = message(NEAR_CAP / 4);
    const large = message(NEAR_CAP);
    settleFences(large); // warm
    const ratio = fastest(() => settleFences(large)) / fastest(() => settleFences(small));
    expect(ratio).toBeLessThan(8);
  }, 60_000);
});
