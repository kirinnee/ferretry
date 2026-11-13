import { expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import type {
  ClearJob,
  ClearOutcome,
  InputTarget,
  InputTargetAdapter,
  InputTargetFacts,
} from '../../../../contract/index.ts';
import { FakeInputTarget } from '../../../../contract/testing/index.ts';
import {
  LoginProbeThroughHook,
  PageTargetThroughHook,
  TerminalTargetThroughHook,
} from '../../../../daemon/adapters/inputs/targets.ts';

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

test('I136 the login observer looks through the targets’ own reads, pinned to the surfaces it was given', async () => {
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

test('I136 a target that offers no look, or a provider that is off, leaves every sign-in fact unknown', async () => {
  const ferret = 'f1' as FerretId;
  const target = { kind: 'page', key: 'login' } as const;
  for (const provider of [() => new FakeInputTarget('page', 'login'), () => undefined]) {
    const probe = new LoginProbeThroughHook(provider);
    expect(await probe.where(ferret, 'login', ['login'])).toBeUndefined();
    expect(await probe.shows(ferret, target, ['login'], ['value'])).toBeUndefined();
    expect(await probe.prompt?.(ferret, 'dev', ['dev'])).toBeUndefined();
  }
});

/** An adapter that records every call it is handed and answers fixed words, so the delegation can be read off. */
function recording(kind: 'page' | 'terminal', refinds = true) {
  const calls: unknown[][] = [];
  const adapter = {
    masking: 'text' as const,
    observe: async (...args: unknown[]) => {
      calls.push(['observe', ...args]);
      return { ok: false as const, reason: 'target_gone' as const };
    },
    type: async (...args: unknown[]) => {
      calls.push(['type', ...args]);
      return 'typed' as never;
    },
    shoot: async (...args: unknown[]) => {
      calls.push(['shoot', ...args]);
      return { png: 'shot' } as never;
    },
    document: async (...args: unknown[]) => {
      calls.push(['document', ...args]);
      return 'doc-1';
    },
    ...(refinds
      ? {
          refind: async (...args: unknown[]) => {
            calls.push(['refind', ...args]);
            return { ok: false as const, reason: 'target_gone' as const };
          },
        }
      : {}),
  } as unknown as InputTargetAdapter;
  return { adapter, calls, kind };
}

const FERRET = 'f1' as FerretId;
const PAGE = { kind: 'page', key: 'login' } as const;
const TERMINAL = { kind: 'terminal', key: 'dev' } as const;
const FACTS = { kind: 'terminal' } as unknown as InputTargetFacts;
const FIELDS = [{ id: 'value' }] as never;

test('a page is observed, refound, typed into, pictured and named through the page provider, every call', async () => {
  const { adapter, calls } = recording('page');
  const through = new PageTargetThroughHook(kind => (kind === 'page' ? adapter : undefined));
  expect(await through.observe('f1', PAGE, FIELDS)).toEqual({ ok: false, reason: 'target_gone' });
  expect(await through.refind('f1', PAGE, FIELDS, FACTS)).toEqual({ ok: false, reason: 'target_gone' });
  const values = [{ field: 'value', text: 'x' }] as never;
  expect(await through.type('f1', PAGE, values, true, FACTS, { proceed: () => true })).toBe('typed' as never);
  expect(await through.shoot('f1', PAGE, FACTS)).toEqual({ png: 'shot' } as never);
  expect(await through.document('f1', 'login')).toBe('doc-1');
  expect(calls.map(call => call[0])).toEqual(['observe', 'refind', 'type', 'shoot', 'document']);
  expect(calls[2]?.slice(1, 5)).toEqual([FERRET, PAGE, values, true]);
});

test('a page whose provider is off cannot be observed, typed into, pictured or named, so nothing is typed', async () => {
  const through = new PageTargetThroughHook(() => undefined);
  expect(await through.observe('f1', PAGE, FIELDS)).toEqual({ ok: false, reason: 'unsupported' });
  expect(await through.refind('f1', PAGE, FIELDS, FACTS)).toEqual({ ok: false, reason: 'unsupported' });
  expect(await through.type('f1', PAGE, [], false, FACTS)).toBe('target_gone');
  expect(await through.shoot('f1', PAGE, FACTS)).toBeUndefined();
  expect(await through.document('f1', 'login')).toBeUndefined();
});

test('a page provider that cannot refind answers unsupported rather than guessing', async () => {
  const { adapter } = recording('page', false);
  const through = new PageTargetThroughHook(() => adapter);
  expect(await through.refind('f1', PAGE, FIELDS, FACTS)).toEqual({ ok: false, reason: 'unsupported' });
});

test('a terminal is one prompt, so it is observed and typed with the one single-field id', async () => {
  const { adapter, calls } = recording('terminal');
  const through = new TerminalTargetThroughHook(kind => (kind === 'terminal' ? adapter : undefined));
  await through.observe('f1', TERMINAL);
  expect(await through.type('f1', TERMINAL, 'hunter2', true, FACTS, { proceed: () => true })).toBe('typed' as never);
  expect(calls[0]).toEqual(['observe', FERRET, TERMINAL, [{ id: 'value' }]]);
  expect(calls[1]?.slice(0, 5)).toEqual(['type', FERRET, TERMINAL, [{ field: 'value', text: 'hunter2' }], true]);
});

test('a terminal whose provider is off is unsupported and gone', async () => {
  const through = new TerminalTargetThroughHook(() => undefined);
  expect(await through.observe('f1', TERMINAL)).toEqual({ ok: false, reason: 'unsupported' });
  expect(await through.type('f1', TERMINAL, 'x', false, FACTS)).toBe('target_gone');
});

test('the login probe never looks for a value in a secret target, whatever the provider offers', async () => {
  const probe = new LoginProbeThroughHook(() => {
    throw new Error('a secret target must not reach a provider');
  });
  expect(
    await probe.shows('f1', { kind: 'secret', key: 'TOKEN' } as InputTarget, ['TOKEN'], ['value']),
  ).toBeUndefined();
});
