/**
 * Runtimes' answer to Ferrets' `runtime.start`: a start that names a runtime spends that runtime's login. The answer is
 * the runtime's harness and login when `resolve` says ok, and otherwise one plain sentence that names the runtime and the
 * way forward, so a runtime that cannot serve is refused rather than launched signed out. The same answer says whether a
 * LOGIN may be spent at all: switched off, or over its spend budget, is refused whether the login is named directly or
 * reached through a runtime.
 */
import { describe, expect, test } from 'bun:test';
import type { LoginView } from '@ferretry/plugin-logins/contract';
import type { ResolveResult, RuntimeId } from '../../../contract/index.ts';
import { runtimeStartAnswer } from '../../../daemon/lib/service/runtime-start-answer.ts';

const resolving = (answer: ResolveResult) => {
  const asked: (RuntimeId | undefined)[] = [];
  return { asked, resolve: async (id?: RuntimeId) => (asked.push(id), answer) };
};
const READY = {
  ok: true,
  runtime: {
    id: 'rt',
    harness: 'claude-code',
    login: 'oauth',
    profile: 'plain',
    agent: true,
    launch: { available: true },
  },
} as unknown as ResolveResult;

/** A login as Logins lists it; `extra` carries its `disabled` block or its `budget`. */
const login = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra }) as unknown as LoginView;
const listing = (...logins: LoginView[]) => ({ list: async () => ({ logins }) as never });
const period = (level: 'ok' | 'over_trigger' | 'over_hard') => ({
  trigger: 5,
  hard: 10,
  spentUsd: 6,
  level,
  startsAt: '2026-11-12T00:00:00Z',
  resetsAt: '2026-11-13T00:00:00Z',
});
const OK = login('oauth');

describe('runtimeStartAnswer', () => {
  test('a runtime that resolves answers its harness and its login, and only that runtime was asked', async () => {
    const { asked, resolve } = resolving(READY);

    expect(await runtimeStartAnswer({ resolve, logins: listing(OK) }).resolve('rt')).toEqual({
      ok: true,
      harness: 'claude-code',
      login: 'oauth',
    });
    expect(asked.map(String)).toEqual(['rt']);
  });

  test('every refusal Runtimes gives becomes a sentence naming the runtime, its reason and the way forward', async () => {
    const refusals: ResolveResult[] = [
      { ok: false, refusal: 'unknown', sentence: 'no runtime ghost exists on this machine' },
      { ok: false, refusal: 'not_signed_in', sentence: 'Login oauth needs sign-in' },
      { ok: false, refusal: 'no_login', sentence: 'Login oauth does not exist' },
      { ok: false, refusal: 'disabled', sentence: 'ghost is switched off' },
    ];
    for (const refusal of refusals) {
      const answer = await runtimeStartAnswer({ ...resolving(refusal), logins: listing(OK) }).resolve('ghost');
      expect(answer.ok).toBe(false);
      const sentence = answer.ok ? '' : answer.sentence;
      expect(sentence).toContain('runtime ghost was not started');
      expect(sentence).toContain(refusal.ok ? '' : refusal.sentence);
      expect(sentence).toContain('fy runtimes');
    }
  });

  test('a name that is not a runtime name is refused without asking Runtimes', async () => {
    const { asked, resolve } = resolving(READY);

    const answer = await runtimeStartAnswer({ resolve, logins: listing(OK) }).resolve('Not A Name!');

    expect(answer.ok).toBe(false);
    expect(asked).toEqual([]);
  });
});

describe('runtimeStartAnswer › whether a login may be spent', () => {
  const answer = (...logins: LoginView[]) => runtimeStartAnswer({ ...resolving(READY), logins: listing(...logins) });

  test('a login that is on and within budget may be spent', async () => {
    const budget = { level: 'ok', daily: period('ok'), weekly: period('ok') };
    expect(await answer(login('oauth', { budget })).login('oauth')).toEqual({ ok: true });
  });

  test('a login switched off is refused in one sentence naming it, its reason and when it comes back', async () => {
    const disabled = { reason: 'owner-off', until: '2026-12-01T00:00:00Z', source: 'login' };

    const refused = await answer(login('oauth', { disabled })).login('oauth');

    expect(refused).toEqual({
      ok: false,
      sentence: 'login oauth is switched off (owner-off) until 2026-12-01T00:00:00Z',
    });
  });

  test('a login over a budget is refused naming the period, its limit and the reset; the hard limit wins over a trigger', async () => {
    const trigger = { level: 'over_trigger', daily: period('over_trigger'), weekly: period('ok') };
    const hard = { level: 'over_hard', daily: period('over_trigger'), weekly: period('over_hard') };

    const first = await answer(login('oauth', { budget: trigger })).login('oauth');
    const second = await answer(login('oauth', { budget: hard })).login('oauth');

    expect(first).toEqual({
      ok: false,
      sentence: 'login oauth is over its daily budget on this machine (its $5.00 trigger) until 2026-11-13T00:00:00Z',
    });
    expect(second).toEqual({
      ok: false,
      sentence:
        'login oauth is over its weekly budget on this machine (its $10.00 hard limit) until 2026-11-13T00:00:00Z',
    });
  });

  test('a login Logins does not know, or cannot list, is refused rather than spent', async () => {
    expect((await answer(login('other')).login('oauth')).ok).toBe(false);
    const broken = runtimeStartAnswer({
      ...resolving(READY),
      logins: {
        list: async () => {
          throw new Error('boom');
        },
      },
    });
    const refused = await broken.login('oauth');
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.sentence).not.toContain('boom');
  });

  test('a runtime whose login is switched off or over budget is refused too: through a runtime is the same check', async () => {
    const off = answer(login('oauth', { disabled: { reason: 'owner-off', source: 'login' } }));
    const over = answer(login('oauth', { budget: { level: 'over_trigger', daily: period('over_trigger') } }));

    const viaOff = await off.resolve('rt');
    const viaOver = await over.resolve('rt');

    expect(viaOff.ok).toBe(false);
    expect(viaOff.ok ? '' : viaOff.sentence).toContain('runtime rt was not started: login oauth is switched off');
    expect(viaOver.ok).toBe(false);
    expect(viaOver.ok ? '' : viaOver.sentence).toContain('login oauth is over its daily budget');
  });
});
