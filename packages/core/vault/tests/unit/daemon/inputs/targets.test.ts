import { expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import type { ClearJob, ClearOutcome, InputTarget, InputTargetFacts } from '../../../../contract/index.ts';
import { FakeInputTarget } from '../../../../contract/testing/index.ts';
import { PageTargetThroughHook } from '../../../../daemon/adapters/inputs/targets.ts';

class PageWithMethods extends FakeInputTarget {
  readonly checked: unknown[][] = [];
  readonly result = 'hidden' as const;

  async probe(ferret: FerretId, target: InputTarget, facts: InputTargetFacts, fields: readonly string[]) {
    this.checked.push([ferret, target, facts, fields]);
    return this.result;
  }

  async arm(ferret: FerretId, target: InputTarget, job: ClearJob): Promise<ClearOutcome> {
    this.checked.push([ferret, target, job]);
    return this.result === 'hidden' ? 'cleared' : 'unknown';
  }
}

test('I78 I84 page probe and field clear retain the target adapter receiver and arguments', async () => {
  const page = new PageWithMethods('page', 'login');
  const through = new PageTargetThroughHook(() => page);
  const ferret = 'f1' as FerretId;
  const target = { kind: 'page', key: 'login' } as const;
  const seen = await page.observe(ferret, target);
  if (!seen.ok) throw new Error('expected a live page');
  const job: ClearJob = { navigationId: 'n1', fields: [{ frameId: 'frame-1', backendNodeId: 10 }] };
  expect(await through.probe(ferret, target, seen.facts, ['value'])).toBe('hidden');
  expect(await through.clear(ferret, target, job)).toBe('cleared');
  expect(page.checked).toEqual([
    [ferret, target, seen.facts, ['value']],
    [ferret, target, job],
  ]);
  const absent = new PageTargetThroughHook(() => undefined);
  expect(await absent.probe(ferret, target, seen.facts, ['value'])).toBe('aborted');
  expect(await absent.clear(ferret, target, job)).toBe('unknown');
});
