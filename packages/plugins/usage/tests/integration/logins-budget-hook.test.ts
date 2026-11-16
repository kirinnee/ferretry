/**
 * Usage answers `logins.budget:usage`: the standing Logins shows on `fy login ls` and `fy login check` is the one Usage
 * measures (`GET /v1/usage/budgets`). The asker here stands where Logins stands (the plugin that offers the hook, and
 * the key and the hook are the real ones); Logins' own use of the answer is tested with Logins.
 */
import { describe, expect, test } from 'bun:test';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { type LoginBudgets, LoginsBudget } from '@ferretry/plugin-logins/contract';
import usage from '../../daemon/index.ts';

/** The asker's way to ask, as Logins asks: when it needs the answer, never at build (Usage is built after it). */
let ask: (() => LoginBudgets | 'unavailable') | undefined;

/** A plugin standing where Logins stands: it offers `logins.budget` and asks for the provider keyed `usage`. */
const logins = implementDaemon(
  definePlugin({
    id: 'logins',
    title: 'Logins',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: ['login'],
    hooks: { offers: [{ hook: LoginsBudget }] },
  }),
  {
    build: ctx => {
      ask = () => ctx.hooks.provider(LoginsBudget, 'usage');
      return {} as never;
    },
  },
);

async function host(config: Record<string, unknown>) {
  return await testHost({
    plugins: [logins, usage],
    fakes: {
      ferrets: new FakeFerrets(),
      conversation: fakeConversation(),
      logins: fakeLogins([sampleLogin('work')]),
      vault: new FakeVault(),
    },
    config,
  });
}

describe('Usage provides the budget standing to Logins', () => {
  test('Logins is handed a provider, and its answer is the standing Usage measures', async () => {
    const h = await host({ 'usage.yaml': { budgets: { work: { daily: { hard: 5 } } } } });
    try {
      const budgets = ask?.();
      if (budgets === undefined || budgets === 'unavailable')
        throw new Error('Logins was handed no provider for usage');
      // Before the first measure there is no standing to show, and a login with no budget never has one.
      expect(budgets.view('work')).toBeUndefined();
      await h.runJob('usage-budget');
      const measured = budgets.view('work');
      expect(measured?.daily?.hard).toBe(5);
      expect(measured?.measured).toBeDefined();
      expect(budgets.view('spare')).toBeUndefined();
      const listed = (await h.request('GET', '/v1/usage/budgets')).json<{
        budgets: { login: string; budget: unknown }[];
      }>();
      expect(listed.budgets.map(row => [row.login, row.budget])).toEqual([['work', measured]]);
    } finally {
      await h.stop();
    }
  });
});
