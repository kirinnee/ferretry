import { describe, expect, test } from 'bun:test';
import { diffText } from '../../../app/lib/agenda-diff.ts';

// The speed half of `tests/unit/app/agenda-diff.test.ts`: the diff of a very long text answers within its bound. The
// unit file proves the same word-level answers at a small size, without a clock.
describe('a very long text', () => {
  const lines = (count: number, edit: Readonly<Record<number, string>>): string =>
    Array.from(
      { length: count },
      (_, index) => `${edit[index] ?? `Step ${String(index)} of the report finished cleanly`}\n`,
    ).join('');
  const sentences = (count: number, edit: Readonly<Record<number, string>>): string =>
    Array.from({ length: count }, (_, index) => `Sentence ${String(index)} ${edit[index] ?? 'holds'} steady.`).join(
      ' ',
    );
  const kinds = (runs: ReturnType<typeof diffText>, kind: 'added' | 'removed'): string[] =>
    runs.filter(run => run.kind === kind).map(run => run.text);
  const joined = (runs: ReturnType<typeof diffText>, drop: 'added' | 'removed'): string =>
    runs
      .filter(run => run.kind !== drop)
      .map(run => run.text)
      .join('');

  test('keeps two one-word edits at the two ends of 3000 lines word-level', () => {
    const before = lines(3000, {});
    const after = lines(3000, {
      2: 'Step 2 of the report failed cleanly',
      2597: 'Step 2597 of the report failed cleanly',
    });
    const started = performance.now();
    const runs = diffText(before, after);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(kinds(runs, 'removed')).toEqual(['finished', 'finished']);
    expect(kinds(runs, 'added')).toEqual(['failed', 'failed']);
    expect(joined(runs, 'added')).toBe(before);
    expect(joined(runs, 'removed')).toBe(after);
  });

  test('keeps two far edits in a 3000 sentence paragraph word-level', () => {
    const before = sentences(3000, {});
    const after = sentences(3000, { 5: 'wobbles', 2990: 'wobbles' });
    const started = performance.now();
    const runs = diffText(before, after);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(kinds(runs, 'removed')).toEqual(['holds', 'holds']);
    expect(kinds(runs, 'added')).toEqual(['wobbles', 'wobbles']);
    expect(joined(runs, 'added')).toBe(before);
    expect(joined(runs, 'removed')).toBe(after);
  });

  test('answers a 50 by 50 block of 500-word lines, all rewritten, within a bound', () => {
    const block = (prefix: string): string =>
      Array.from(
        { length: 50 },
        (_, line) =>
          `${Array.from({ length: 500 }, (_, word) => `${prefix}${String(line)}x${String(word)}`).join(' ')}\n`,
      ).join('');
    const before = block('a');
    const after = block('b');
    const started = performance.now();
    const runs = diffText(before, after);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(joined(runs, 'added')).toBe(before);
    expect(joined(runs, 'removed')).toBe(after);
  });

  test('still pairs alike lines once the exact scoring budget is spent', () => {
    const block = (word: string): string =>
      Array.from(
        { length: 50 },
        (_, line) =>
          `${Array.from({ length: 500 }, (_, index) => (index === 250 ? word : `l${String(line)}w${String(index)}`)).join(' ')}\n`,
      ).join('');
    const before = block('old');
    const after = block('new');
    const started = performance.now();
    const runs = diffText(before, after);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(runs.filter(run => run.kind === 'removed').every(run => run.text === 'old')).toBe(true);
    expect(joined(runs, 'added')).toBe(before);
    expect(joined(runs, 'removed')).toBe(after);
  });
});
