/**
 * `logins.budget` end to end through the host: `fy login ls` and `fy login check` show a login's budget line because
 * the REAL Logins composition asks the plugin that provides the standing (Usage, which owns the budgets and meters
 * the spend). The provider here stands where Usage stands (the key and the hook are the real ones); Usage's own answer
 * is tested with Usage. The budget lives in `usage.yaml`, so the login's own file carries none.
 */
import { describe, expect, test } from 'bun:test';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { type LoginBudget, LoginBudgetSchema, type LoginBudgets, LoginsBudget } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import { emptyVault } from '../../support/fake-vault.ts';

const STANDING: LoginBudget = LoginBudgetSchema.parse({
  timeZone: 'UTC',
  timeZoneSet: true,
  daily: {
    hard: 5,
    spentUsd: 1.5,
    level: 'ok',
    startsAt: '2026-11-13T00:00:00.000Z',
    resetsAt: '2026-11-14T00:00:00.000Z',
  },
  level: 'ok',
  unpriced: 0,
  measured: true,
});

/** A plugin standing where Usage stands: it takes `logins.budget:usage` and answers with what it is given. */
function usage(budgets: LoginBudgets) {
  return implementDaemon(
    definePlugin({
      id: 'usage',
      title: 'Usage',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: ['view'],
      hooks: { takes: [{ hook: LoginsBudget, key: 'usage' }] },
    }),
    { build: () => ({ hooks: { 'logins.budget:usage': budgets } }) as never },
  );
}

const files = {
  logins: { work: { harness: 'claude-code', store: 'host' }, spare: { harness: 'claude-code', store: 'host' } },
};

async function listed(budgets: LoginBudgets | undefined) {
  const host = await testHost({
    plugins: budgets === undefined ? [daemon] : [daemon, usage(budgets)],
    fakes: { vault: emptyVault() },
    config: files,
  });
  try {
    const answer = await host.request('GET', '/v1/logins');
    expect(answer.status).toBe(200);
    return new Map(
      answer.json<{ logins: { id: string; budget?: LoginBudget }[] }>().logins.map(row => [row.id, row.budget]),
    );
  } finally {
    await host.stop();
  }
}

describe('a login shows the budget standing Usage measures', () => {
  test('the login Usage has a standing for carries it; the one it has none for carries none', async () => {
    const rows = await listed({ view: login => (login === 'work' ? STANDING : undefined) });
    expect(rows.get('work')).toEqual(STANDING);
    expect(rows.get('spare')).toBeUndefined();
  });

  test('with nothing providing budgets no login shows one, and the list still answers', async () => {
    const rows = await listed(undefined);
    expect([...rows.keys()].sort()).toEqual(['spare', 'work']);
    expect(rows.get('work')).toBeUndefined();
  });
});
