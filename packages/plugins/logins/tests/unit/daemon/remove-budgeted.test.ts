/**
 * Removing a BUDGETED login end to end through the host's real config port. Removing the login lifts its budget, which
 * the kernel's judge lets in for the owner (or a confirmed step-up) and holds for a caller it governs. Logins removes
 * with `refuseIfHeld`, so the owner removes in ONE step and a governed caller is refused with the budget-first sentence
 * — file untouched, nothing held, the judge asked once. The held rule lives in the kernel only; this proves the wiring.
 */
import { describe, expect, test } from 'bun:test';
import type { ConfigWriteJudgement } from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { owner, standInAdmission, testHost } from '@ferretry/kernel/testing';
import { LoginsUsedBy } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import { emptyVault } from '../../support/fake-vault.ts';

const BUDGET_FIRST =
  'This login has a budget, so it was not removed: first drop its budget (you confirm that), then remove the login.';

const runtimes = implementDaemon(
  definePlugin({
    id: 'runtimes',
    title: 'Runtimes',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: ['runtime'],
    hooks: { takes: [{ hook: LoginsUsedBy, key: 'runtimes' }] },
  }),
  { build: () => ({ hooks: { 'logins.used-by:runtimes': { of: () => [] } } }) as never },
);

const budgeted = { harness: 'claude-code', store: 'host', budget: { daily: { hard: 5 } } };
const plain = { harness: 'claude-code', store: 'host' };

/** The kernel's judge for this call: `verdict` is what Gate answers; every ask is recorded. */
async function world(verdict: 'apply' | 'hold', files: Record<string, unknown>) {
  const asked: ConfigWriteJudgement[] = [];
  const gate = {
    ...standInAdmission(() => owner()),
    judgeConfigWrite: (input: ConfigWriteJudgement) => (asked.push(input), verdict),
  };
  const host = await testHost({
    plugins: [daemon, runtimes],
    fakes: { vault: emptyVault() },
    gate,
    config: { logins: files },
  });
  return { host, asked };
}

describe('removing a budgeted login', () => {
  test('the owner (the judge lets the loosening in) removes it in ONE step: applied, gone, nothing held', async () => {
    const { host, asked } = await world('apply', { work: budgeted });
    try {
      const staged = await host.request('POST', '/v1/logins/changes', { body: { kind: 'login.remove', id: 'work' } });
      expect(staged.status).toBe(200);
      const applied = await host.request('POST', `/v1/logins/changes/${staged.json<{ id: string }>().id}/apply`);
      expect(applied.status).toBe(200);
      expect(applied.json<{ outcome: string }>().outcome).toBe('applied');
      expect(await host.request('GET', '/v1/logins').then(r => r.body)).not.toContain('"work"');
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({ plugin: 'logins', removal: true });
    } finally {
      await host.stop();
    }
  });

  test('a governed caller (the judge holds it) is refused with the budget-first sentence: login in effect, nothing held, judge asked once', async () => {
    const { host, asked } = await world('hold', { work: budgeted });
    try {
      const staged = await host.request('POST', '/v1/logins/changes', { body: { kind: 'login.remove', id: 'work' } });
      expect(staged.status).toBe(200);
      const applied = await host.request('POST', `/v1/logins/changes/${staged.json<{ id: string }>().id}/apply`);
      expect(applied.status).toBe(409);
      expect(applied.json<{ code: string; error: string }>()).toMatchObject({
        code: 'login_change_refused',
        error: BUDGET_FIRST,
      });
      expect(await host.request('GET', '/v1/logins').then(r => r.body)).toContain('"work"');
      expect(asked).toHaveLength(1);
      // Nothing was held: the next change gets the next handle and the login can still be edited.
      const next = await host.request('POST', '/v1/logins/changes', {
        body: { kind: 'login.label', id: 'work', label: 'Work' },
      });
      expect(next.status).toBe(200);
    } finally {
      await host.stop();
    }
  });

  test('an unbudgeted login is removed without the judge being asked, whoever asks', async () => {
    const { host, asked } = await world('hold', { home: plain });
    try {
      const staged = await host.request('POST', '/v1/logins/changes', { body: { kind: 'login.remove', id: 'home' } });
      expect(staged.status).toBe(200);
      const applied = await host.request('POST', `/v1/logins/changes/${staged.json<{ id: string }>().id}/apply`);
      expect(applied.json<{ outcome: string }>().outcome).toBe('applied');
      expect(await host.request('GET', '/v1/logins').then(r => r.body)).not.toContain('"home"');
      expect(asked).toEqual([]);
    } finally {
      await host.stop();
    }
  });
});
