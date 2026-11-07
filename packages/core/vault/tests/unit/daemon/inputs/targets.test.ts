import { expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import type { ClearJob, ClearOutcome, InputTarget, InputTargetFacts } from '../../../../contract/index.ts';
import { FakeInputTarget } from '../../../../contract/testing/index.ts';
import { LoginProbeThroughHook, PageTargetThroughHook } from '../../../../daemon/adapters/inputs/targets.ts';

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

test('I93 I99 the login observer looks through the targets’ own reads, pinned to the surfaces it was given', async () => {
  const seen: unknown[][] = [];
  class Looking extends FakeInputTarget {
    async where(ferret: FerretId, key: string, surfaces: readonly string[]) {
      seen.push(['where', ferret, key, surfaces]);
      return { navigationId: 'n1', host: 'login.example.test' };
    }
    async text(ferret: FerretId, key: string, surfaces: readonly string[]) {
      seen.push(['text', ferret, key, surfaces]);
      return 'welcome back, hunter2-value';
    }
    async promptLine(ferret: FerretId, key: string, surfaces: readonly string[]) {
      seen.push(['promptLine', ferret, key, surfaces]);
      return 'Password:';
    }
  }
  const page = new Looking('page', 'login');
  const terminal = new Looking('terminal', 'dev');
  const probe = new LoginProbeThroughHook(kind => (kind === 'page' ? page : terminal));
  const ferret = 'f1' as FerretId;
  expect(await probe.where(ferret, 'login', ['login'])).toEqual({ navigationId: 'n1', host: 'login.example.test' });
  expect(await probe.prompt?.(ferret, 'dev', ['dev', '%3'])).toBe('Password:');
  const pageTarget = { kind: 'page', key: 'login' } as const;
  const terminalTarget = { kind: 'terminal', key: 'dev' } as const;
  expect(await probe.shows(ferret, pageTarget, ['login'], ['hunter2-value'])).toBe(true);
  expect(await probe.shows(ferret, terminalTarget, ['dev'], ['other-value', ''])).toBe(false);
  // Nothing to look for, or nothing read: cannot tell.
  expect(await probe.shows(ferret, pageTarget, ['login'], [])).toBeUndefined();
  expect(seen.filter(entry => entry[0] === 'text')).toHaveLength(2);
  expect(seen).toContainEqual(['promptLine', ferret, 'dev', ['dev', '%3']]);
});

test('I93 a target that offers no look, or a provider that is off, leaves every sign-in fact unknown', async () => {
  const ferret = 'f1' as FerretId;
  const target = { kind: 'page', key: 'login' } as const;
  for (const provider of [() => new FakeInputTarget('page', 'login'), () => undefined]) {
    const probe = new LoginProbeThroughHook(provider);
    expect(await probe.where(ferret, 'login', ['login'])).toBeUndefined();
    expect(await probe.shows(ferret, target, ['login'], ['value'])).toBeUndefined();
    expect(await probe.prompt?.(ferret, 'dev', ['dev'])).toBeUndefined();
  }
});
