/**
 * Runtimes' answer to Ferrets' `runtime.start`: a start that names a runtime spends that runtime's login. The answer is
 * the runtime's harness and login when `resolve` says ok, and otherwise one plain sentence that names the runtime and the
 * way forward, so a runtime that cannot serve is refused rather than launched signed out.
 */
import { describe, expect, test } from 'bun:test';
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

describe('runtimeStartAnswer', () => {
  test('a runtime that resolves answers its harness and its login, and only that runtime was asked', async () => {
    const { asked, resolve } = resolving(READY);

    expect(await runtimeStartAnswer({ resolve })('rt')).toEqual({ ok: true, harness: 'claude-code', login: 'oauth' });
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
      const answer = await runtimeStartAnswer(resolving(refusal))('ghost');
      expect(answer.ok).toBe(false);
      const sentence = answer.ok ? '' : answer.sentence;
      expect(sentence).toContain('runtime ghost was not started');
      expect(sentence).toContain(refusal.ok ? '' : refusal.sentence);
      expect(sentence).toContain('fy runtimes');
    }
  });

  test('a name that is not a runtime name is refused without asking Runtimes', async () => {
    const { asked, resolve } = resolving(READY);

    const answer = await runtimeStartAnswer({ resolve })('Not A Name!');

    expect(answer.ok).toBe(false);
    expect(asked).toEqual([]);
  });
});
