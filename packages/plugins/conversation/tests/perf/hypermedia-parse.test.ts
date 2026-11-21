import { describe, expect, test } from 'bun:test';
import { parseMessage } from '../../app/hypermedia/parse-message.ts';

/**
 * The SPEED half of "an assistant message is read as Hypermedia": a 50 KB message (a long answer with lists, a table, code,
 * a terminal part and a reference in most paragraphs) is parsed and its references split in under 30 ms. A message is
 * parsed again on every append while it streams, so this is the per-frame cost of a long reply. That the reading is the
 * RIGHT one is checked at a small size in unit (`tests/unit/app/hypermedia/`).
 */
const BUDGET_MS = 30;
const FENCE = '`'.repeat(3);

const section = (n: number): string =>
  [
    `## Step ${n}: what changed in \`src/part-${n}.ts\``,
    '',
    `Ask :zelda to look at @src/part-${n}.ts:${n + 10} and &F${n} before ^A3 is closed; **do not** touch /deploy yet.`,
    '',
    `- first thing about step ${n} with a [link](https://example.com/${n})`,
    `- second thing, ~~dropped~~ and _stressed_ with 50% of the cases`,
    '',
    '| name | value |',
    '| - | - |',
    `| a${n} | ${n} |`,
    `| b${n} | ${n * 2} |`,
    '',
    `${FENCE}ts`,
    `const step${n} = (input: number): number => input * ${n};`,
    `${FENCE}`,
    '',
    `${FENCE}terminal`,
    `$ bun test step-${n}`,
    `ok ${n} tests`,
    `${FENCE}`,
    '',
    `Plain closing words for step ${n}, long enough to make the paragraph a real one rather than a stub.`,
    '',
  ].join('\n');

const message = (bytes: number): string => {
  const parts: string[] = [];
  let size = 0;
  for (let n = 1; size < bytes; n++) {
    const part = section(n);
    parts.push(part);
    size += part.length;
  }
  return parts.join('\n');
};

/** The fastest of a few runs: one sample measures the garbage collector that falls in it. */
const fastest = (run: () => unknown, runs = 7): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
};

describe('parsing an assistant message as hypermedia', () => {
  test('reads 50 KB in under 30 ms', () => {
    const text = message(50_000);
    expect(text.length).toBeGreaterThanOrEqual(50_000);
    expect(text.length).toBeLessThan(55_000);
    parseMessage(text, 'dh-x-'); // warm: the first call builds the lexer and the YAML reader
    const best = fastest(() => parseMessage(text, 'dh-x-'));
    expect(best).toBeLessThan(BUDGET_MS);
  });
});
