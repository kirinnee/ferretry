import { describe, expect, it } from 'bun:test';
import type { PasteRule, PasteRuleStaged } from '../../../contract/routes/index.ts';
import {
  confirmPasteRuleStage,
  fromWords,
  listRules,
  removeRule,
  ruleFromForm,
  ruleLimits,
  toWords,
} from '../../../app/lib/secure-copy.ts';
import { fakeClient } from '../../support/app/fake-client.ts';

const RULE: PasteRule = {
  id: 'a'.repeat(32),
  from: { kind: 'command', program: 'gh' },
  to: { kind: 'terminal', program: 'vercel' },
  used: 2,
  createdAt: '2026-08-05T09:00:00.000Z',
  createdBy: { kind: 'host' },
};

describe('the secure copy client', () => {
  it('dials the owner routes and parses each answer', async () => {
    const fake = fakeClient(call =>
      call.path === '/v1/copy-rules' && call.method === 'GET' ? { rules: [RULE] } : { removed: true },
    );

    expect((await listRules(fake.client)).rules).toHaveLength(1);
    await removeRule(fake.client, RULE.id);

    expect(fake.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET /v1/copy-rules',
      `DELETE /v1/copy-rules/${RULE.id}`,
    ]);
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

describe('confirming one staged paste change', () => {
  const STAGED: PasteRuleStaged = {
    stage: `prs_${'1'.repeat(24)}`,
    kind: 'rule',
    does: 'Ferretry pastes what gh prints into vercel in a terminal, for any ferret on this machine, without asking.',
    rows: [{ label: 'Staged', value: 'At this machine, 2026-11-02 09:00 UTC' }],
    runsAnything: false,
    expiresAt: '2026-11-02T09:02:00.000Z',
  };

  it('drops its own stage and says why when the passkey prompt fails, and never commits', async () => {
    const { client, calls } = fakeClient(() => ({ stage: STAGED.stage, dropped: true }));

    const outcome = await confirmPasteRuleStage(
      client,
      async () => {
        throw new Error('the passkey sheet closed');
      },
      STAGED,
    );

    expect(outcome).toEqual({ kind: 'failed', words: 'the passkey sheet closed' });
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([`DELETE /v1/copy-rules/stages/${STAGED.stage}`]);
  });

  it('says why a commit failed after the passkey, and drops nothing then', async () => {
    const { client, calls } = fakeClient(call => {
      if (call.path.endsWith('/commit')) throw new Error('the daemon is gone');
      return STAGED;
    });

    const outcome = await confirmPasteRuleStage(client, async () => true, STAGED, { taken: true });

    expect(outcome).toEqual({ kind: 'failed', words: 'the daemon is gone' });
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      `POST /v1/copy-rules/stages/${STAGED.stage}/bind`,
      `POST /v1/copy-rules/stages/${STAGED.stage}/commit`,
    ]);
  });
});
