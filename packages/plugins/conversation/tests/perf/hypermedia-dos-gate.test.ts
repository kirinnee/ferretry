import { afterAll, beforeAll, describe, expect, it, test } from 'bun:test';
import { DOS_CASES, MAX_GROWTH_MB, overBudget, type Read } from './fixtures/dos-gate-cases.ts';

/**
 * THE DURIAN GATE (r12 H13): the pinned Durian does BOUNDED WORK on text built to make it do more than its size suggests. Each
 * case (`fixtures/dos-gate-cases.ts`: the inputs live there and nowhere else) is read in a real worker thread, twice:
 *
 *   `durian`  Durian's own `parse` under the caps the chat reads every message with, with nothing held, so its chart evaluator and
 *             its Markdown reader do the work. This is the number that decides whether a hold may be lifted (H14).
 *   `app`     the worker's own job, `answer`, as the page asks for it, holds and pre-parse limits included.
 *
 * Each read must finish within the case's budget (the best of three: one sample measures the collector that falls in it), grow the
 * process by less than {@link MAX_GROWTH_MB} MB and never throw. A BUDGET MAY ANSWER WITH AN ERROR BLOCK: the gate asks for bounded
 * work, not for a drawn chart. A re-pin of Durian comes in only when every case passes on the new tag.
 *
 * Perf-tier rules (`scripts/ci/perf-tier.sh`): report-only on a pull request, blocking on `main`, one process on its own runner.
 */
interface Answer {
  readonly id: number;
  readonly durian: Read;
  readonly app: Read;
}

let worker: Worker;
const waiting = new Map<number, (answer: Answer) => void>();

beforeAll(async () => {
  worker = new Worker(new URL('./fixtures/dos-gate-worker.ts', import.meta.url).href);
  await new Promise<void>((ready, failed) => {
    worker.onmessage = event => {
      if ((event.data as { ready?: boolean }).ready === true) ready();
    };
    worker.onerror = event => failed(new Error(String(event.message)));
  });
  worker.onmessage = event => {
    const answer = event.data as Answer;
    waiting.get(answer.id)?.(answer);
  };
});

afterAll(() => {
  worker.terminate();
});

const ask = (id: number, text: string): Promise<Answer> =>
  new Promise(resolve => {
    waiting.set(id, resolve);
    worker.postMessage({ id, text });
  });

describe('the pinned Durian does bounded work in the worker', () => {
  for (const [at, { name, text, budgetMs }] of DOS_CASES.entries())
    test(`${name} (${text.length} bytes): under ${budgetMs} ms, under ${MAX_GROWTH_MB} MB growth, no throw`, async () => {
      const answer = await ask(at, text);
      console.log(
        JSON.stringify({
          name,
          bytes: text.length,
          durian: {
            ms: Math.round(answer.durian.ms),
            mb: Math.round(answer.durian.grewMb),
            outcome: answer.durian.outcome.slice(0, 3),
          },
          app: { ms: Math.round(answer.app.ms), mb: Math.round(answer.app.grewMb), outcome: answer.app.outcome },
        }),
      );
      expect({ durian: overBudget(answer.durian, budgetMs), app: overBudget(answer.app, budgetMs) }).toEqual({
        durian: [],
        app: [],
      });
      // The gate measures Durian's work, so no case may be refused before any work (a YAML the reader could not read, a size cap) unless it is the case.
      expect(answer.durian.outcome.some(each => /could not be read|YAML (is|has) too/u.test(each))).toBe(false);
    }, 40_000);
});

describe('A GATE THAT CANNOT FAIL IS NOT ONE: the verdict is red for a slow, a hungry and a throwing read', () => {
  const fine: Read = { ms: 3, grewMb: 2, threw: false, outcome: ['chart'] };
  it('is green for a read within budget, at the edge included', () => {
    expect(overBudget(fine, 50)).toEqual([]);
    expect(overBudget({ ...fine, ms: 49.9, grewMb: MAX_GROWTH_MB - 1 }, 50)).toEqual([]);
  });
  it('is red one step past each bar, and for a throw', () => {
    expect(overBudget({ ...fine, ms: 50 }, 50)).toHaveLength(1);
    expect(overBudget({ ...fine, grewMb: MAX_GROWTH_MB }, 50)).toHaveLength(1);
    expect(overBudget({ ...fine, threw: true, outcome: ['RangeError: out of memory'] }, 50)).toHaveLength(1);
    expect(overBudget({ ms: 3_700, grewMb: 400, threw: true, outcome: ['x'] }, 50)).toHaveLength(3);
  });
});
