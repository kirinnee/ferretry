/**
 * `logins.used-by` end to end through the host: Logins asks the plugin that provides it which runtimes use a login
 * before it removes one, and a removal FAILS CLOSED when nothing can answer. The provider here stands where Runtimes
 * stands (the key and the hook are the real ones); Runtimes' own answer is tested with Runtimes.
 */
import { describe, expect, test } from 'bun:test';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { type LoginUsers, LoginsUsedBy } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import { emptyVault } from '../../support/fake-vault.ts';

const IN_USE = '1 runtime still uses this login (claude-default). Move it to another login first.';
const UNKNOWN = 'Ferretry cannot check what uses this login right now, so it was not removed.';

const files = { logins: { work: { harness: 'claude-code', store: 'host' } } };

/** A plugin standing where Runtimes stands: it takes `logins.used-by:runtimes` and answers with what it is given. */
function provider(users: LoginUsers) {
  return implementDaemon(
    definePlugin({
      id: 'runtimes',
      title: 'Runtimes',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: ['runtime'],
      hooks: { takes: [{ hook: LoginsUsedBy, key: 'runtimes' }] },
    }),
    { build: () => ({ hooks: { 'logins.used-by:runtimes': users } }) as never },
  );
}

async function removal(users: LoginUsers | undefined) {
  const host = await testHost({
    plugins: users === undefined ? [daemon] : [daemon, provider(users)],
    fakes: { vault: emptyVault() },
    config: files,
  });
  const staged = await host.request('POST', '/v1/logins/changes', { body: { kind: 'login.remove', id: 'work' } });
  return { host, staged };
}

describe('removing a login asks which runtimes use it', () => {
  test('a login a runtime uses is refused with the in-use sentence and nothing is held', async () => {
    const { host, staged } = await removal({ of: () => ['claude-default'] });
    try {
      expect(staged.status).toBe(409);
      expect(staged.json<{ code: string; error: string }>()).toMatchObject({
        code: 'login_change_refused',
        error: IN_USE,
      });
    } finally {
      await host.stop();
    }
  });

  test('a login nothing uses is staged, and applies', async () => {
    const { host, staged } = await removal({ of: () => [] });
    try {
      expect(staged.status).toBe(200);
      const applied = await host.request('POST', `/v1/logins/changes/${staged.json<{ id: string }>().id}/apply`);
      expect(applied.status).toBe(200);
      expect(applied.json<{ outcome: string }>().outcome).toBe('applied');
    } finally {
      await host.stop();
    }
  });

  test('with no provider (Runtimes off) a removal is refused in a plain sentence', async () => {
    const { host, staged } = await removal(undefined);
    try {
      expect(staged.status).toBe(409);
      expect(staged.json<{ code: string; error: string }>()).toMatchObject({
        code: 'login_change_refused',
        error: UNKNOWN,
      });
    } finally {
      await host.stop();
    }
  });

  test('a provider that throws refuses the removal, without repeating what it threw', async () => {
    const { host, staged } = await removal({
      of: () => {
        throw new Error('runtimes could not read its files (sk-ant-api03-abcdefghijklmnopq)');
      },
    });
    try {
      expect(staged.status).toBe(409);
      expect(staged.body).not.toContain('sk-ant');
      expect(staged.json<{ error: string }>().error).toBe(UNKNOWN);
    } finally {
      await host.stop();
    }
  });
});

describe('the logins list names the runtimes that use each login', () => {
  async function listed(users: LoginUsers | undefined) {
    const host = await testHost({
      plugins: users === undefined ? [daemon] : [daemon, provider(users)],
      fakes: { vault: emptyVault() },
      config: files,
    });
    try {
      const list = await host.request('GET', '/v1/logins');
      expect(list.status).toBe(200);
      return list.json<{ logins: readonly { id: string; usedBy: readonly string[] }[] }>().logins;
    } finally {
      await host.stop();
    }
  }

  test('a login runtimes launch on lists them, sorted', async () => {
    const logins = await listed({ of: id => (id === 'work' ? ['claude-b', 'claude-a'] : []) });
    expect(logins.find(login => login.id === 'work')?.usedBy).toEqual(['claude-a', 'claude-b']);
  });

  test('an asynchronous answer is read too', async () => {
    const logins = await listed({ of: async () => ['claude-a'] });
    expect(logins.find(login => login.id === 'work')?.usedBy).toEqual(['claude-a']);
  });

  test('with no provider, or one that throws, the list still reads and names none', async () => {
    expect((await listed(undefined)).find(login => login.id === 'work')?.usedBy).toEqual([]);
    const throwing = await listed({
      of: () => {
        throw new Error('unreadable');
      },
    });
    expect(throwing.find(login => login.id === 'work')?.usedBy).toEqual([]);
  });
});
