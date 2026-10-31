import { describe, expect, it } from 'bun:test';
import type { PasteRule } from '@ferretry/protocol';
import {
  addRule,
  answerPlan,
  fromWords,
  listPlans,
  listRules,
  pasteRoute,
  removeRule,
  ruleFromForm,
  ruleLimits,
  toWords,
} from '../../../src/lib/secure-copy.ts';
import { fakeClient, request } from '../../support/input-fixtures.ts';

const RULE: PasteRule = {
  id: 'a'.repeat(32),
  from: { kind: 'command', program: 'gh' },
  to: { kind: 'terminal', program: 'vercel' },
  used: 2,
  createdAt: '2026-08-05T09:00:00.000Z',
  createdBy: { kind: 'host' },
};

const PLAN = {
  id: 'b'.repeat(32),
  sessionId: 's 1',
  agendaItemId: 'A8',
  items: [{ from: RULE.from, to: RULE.to, why: 'token' }],
  state: 'pending' as const,
  raisedAt: '2026-08-05T09:00:00.000Z',
  expiresAt: '2026-08-05T11:00:00.000Z',
};

describe('the secure copy client', () => {
  it('dials the owner routes and parses each answer', async () => {
    const fake = fakeClient(call =>
      call.path === '/v1/copy-rules' && call.method === 'GET'
        ? { rules: [RULE] }
        : call.path === '/v1/copy-rules'
          ? RULE
          : call.method === 'DELETE'
            ? { removed: true }
            : call.path === '/v1/copy-plans'
              ? { plans: [PLAN] }
              : { ...PLAN, state: 'approved', approved: [0] },
    );

    expect((await listRules(fake.client)).rules).toHaveLength(1);
    expect((await addRule(fake.client, { from: RULE.from, to: RULE.to, count: 1 })).id).toBe(RULE.id);
    await removeRule(fake.client, RULE.id);
    expect((await listPlans(fake.client)).plans).toHaveLength(1);
    expect((await answerPlan(fake.client, PLAN, [0])).state).toBe('approved');

    expect(fake.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET /v1/copy-rules',
      'POST /v1/copy-rules',
      `DELETE /v1/copy-rules/${RULE.id}`,
      'GET /v1/copy-plans',
      `POST /v1/sessions/s%201/copy-plans/${PLAN.id}/approve`,
    ]);
    expect(fake.calls[1]?.body).toEqual({ from: RULE.from, to: RULE.to, count: 1 });
    expect(fake.calls[4]?.body).toEqual({ items: [0] });
  });
});

describe('secure copy words', () => {
  it('says every kind of route plainly', () => {
    expect(fromWords({ kind: 'command', program: 'gh' })).toBe('what gh prints');
    expect(fromWords({ kind: 'browser', origin: 'https://github.com' })).toBe('text on https://github.com');
    expect(fromWords({ kind: 'clipboard', origin: 'https://github.com' })).toBe('the clipboard of https://github.com');
    expect(toWords({ kind: 'terminal', program: 'vercel' })).toBe('vercel in a terminal');
    expect(toWords({ kind: 'browser', origin: 'https://vercel.com' })).toBe('a field on https://vercel.com');
    expect(toWords({ kind: 'secret', name: 'VERCEL_TOKEN' })).toBe('the secret VERCEL_TOKEN');
  });

  it('says what a rule still allows, for whom and until when', () => {
    expect(ruleLimits(RULE)).toBe('any number of pastes · any ferret · no end · used 2');
    expect(ruleLimits({ ...RULE, remaining: 1, sessionId: 's1', expiresAt: '2026-08-06T09:30:00.000Z' })).toBe(
      '1 more · one ferret · until 2026-08-06 09:30 UTC · used 2',
    );
  });

  it("draws a paste card's two ends from what the daemon saw", () => {
    const fromCommand = request({ source: { kind: 'sealed', name: 't', from: { kind: 'command', program: 'gh' } } });
    expect(pasteRoute(fromCommand)).toEqual({ from: 'gh (what it printed)', to: 'sudo in %terminal:deploy' });
    expect(pasteRoute(request())).toBeUndefined();
    const reobserving = request({
      source: { kind: 'sealed', name: 't', from: { kind: 'clipboard', origin: 'https://github.com' } },
      observed: undefined,
    });
    expect(pasteRoute(reobserving)).toEqual({ from: 'https://github.com (its clipboard)', to: '%terminal:deploy' });
    const intoPage = request({
      target: { kind: 'browser', key: 'app' },
      source: { kind: 'sealed', name: 't', from: { kind: 'browser', origin: 'https://github.com' } },
      observed: {
        kind: 'browser',
        pageId: 'p',
        origin: 'https://vercel.com',
        secure: true,
        navigationId: 'n',
        fields: [],
      } as never,
    });
    expect(pasteRoute(intoPage)).toEqual({ from: 'https://github.com', to: 'a field on https://vercel.com' });
    const bare = request({ source: { kind: 'sealed', name: 't', from: { kind: 'command' } } });
    expect(pasteRoute(bare)?.from).toBe('a command (what it printed)');
    const page = request({ source: { kind: 'sealed', name: 't', from: { kind: 'browser' } } });
    expect(pasteRoute(page)?.from).toBe('a page');
  });
});

describe('the add-rule form', () => {
  const form = { fromKind: 'command', from: 'gh', toKind: 'terminal', to: 'vercel', count: '2', hours: '24' } as const;

  it('reads a route with its count and hours', () => {
    expect(ruleFromForm(form)).toEqual({
      ok: true,
      rule: {
        from: { kind: 'command', program: 'gh' },
        to: { kind: 'terminal', program: 'vercel' },
        count: 2,
        expiresInSeconds: 86_400,
      },
    });
    expect(ruleFromForm({ ...form, count: '', hours: '' })).toEqual({
      ok: true,
      rule: { from: { kind: 'command', program: 'gh' }, to: { kind: 'terminal', program: 'vercel' } },
    });
    expect(
      ruleFromForm({ ...form, fromKind: 'clipboard', from: 'https://github.com', toKind: 'secret', to: 'GH_TOKEN' }),
    ).toMatchObject({
      ok: true,
      rule: { from: { kind: 'clipboard', origin: 'https://github.com' }, to: { kind: 'secret', name: 'GH_TOKEN' } },
    });
    expect(ruleFromForm({ ...form, toKind: 'browser', to: 'https://vercel.com', hours: '0.001' })).toMatchObject({
      ok: true,
      rule: { to: { kind: 'browser', origin: 'https://vercel.com' }, expiresInSeconds: 60 },
    });
  });

  it('says what is wrong with each end and each limit', () => {
    const problem = (overrides: Partial<Parameters<typeof ruleFromForm>[0]>) => {
      const read = ruleFromForm({ ...form, ...overrides });
      return read.ok ? 'ok' : read.problem;
    };
    expect(problem({ from: '/usr/bin/gh' })).toBe('Name the program, like gh.');
    expect(problem({ fromKind: 'browser', from: 'github.com' })).toBe(
      'Name the page by its origin, like https://github.com.',
    );
    expect(problem({ to: '' })).toBe('Name the program reading the terminal, like vercel.');
    expect(problem({ toKind: 'secret', to: 'lower' })).toBe('Name the secret in capitals, like VERCEL_TOKEN.');
    expect(problem({ toKind: 'browser', to: 'vercel.com' })).toBe(
      'Name the page by its origin, like https://vercel.com.',
    );
    expect(problem({ count: '0' })).toBe('A count is a whole number from 1 to 100, or empty for no count.');
    expect(problem({ hours: '721' })).toBe('Hours are more than 0 and at most 720 (30 days), or empty for no end.');
  });
});
