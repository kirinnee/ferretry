/** Parity rows J-0042, J-0087, J-0096, J-0157, J-0223, J-0224, J-0226: the reads and timers Logins keeps. */
import { describe, expect, test } from 'bun:test';
import { milliseconds } from '@ferretry/std';
import { testHost } from '@ferretry/kernel/testing';
import { harnessLoginTimer } from '../../../daemon/adapters/harness-login/login-child.ts';
import {
  HARNESS_LOGIN_IDLE_MINUTES,
  HARNESS_LOGIN_SHUTDOWN_GRACE_MS,
  HARNESS_LOGIN_WINDOW_MINUTES,
} from '../../../daemon/lib/harness-login/service.ts';
import daemon from '../../../daemon/index.ts';
import { emptyVault } from '../../support/fake-vault.ts';

describe('the jobs and timers Logins keeps', () => {
  test('J-0042 J-0087 the models read runs once after start as a kernel job and never throws when the network is down', async () => {
    const host = await testHost({
      plugins: [daemon],
      fakes: { vault: emptyVault() },
      fetch: async () => {
        throw new Error('offline');
      },
    });
    try {
      expect(host.jobIds()).toContain('logins.models-refresh');
      await host.runJob('logins.models-refresh');
    } finally {
      await host.stop();
    }
  });

  test('J-0096 a watched document that changes is seen on the next read: the watch lets go of what was read before', async () => {
    const work = { harness: 'claude-code', store: 'host' };
    const home = { harness: 'codex', store: 'host' };
    const host = await testHost({ plugins: [daemon], fakes: { vault: emptyVault() }, config: { logins: { work } } });
    try {
      await host.settle();
      const listed = async (): Promise<string[]> => {
        const response = await host.request('GET', '/v1/logins');
        expect(response.status).toBe(200);
        const body = JSON.parse(String(response.body)) as { logins?: { id: string }[] } | { id: string }[];
        return (Array.isArray(body) ? body : (body.logins ?? [])).map(entry => entry.id).sort();
      };
      expect(await listed()).toEqual(['work']);
      // A hand edit adds a login: the next read, with nothing else asked, names it.
      host.setConfig('logins', { work, home });
      await host.settle();
      expect(await listed()).toEqual(['home', 'work']);
      // And one taken out is gone from the next read too, not served from what was read before.
      host.setConfig('logins', { home });
      await host.settle();
      expect(await listed()).toEqual(['home']);
    } finally {
      await host.stop();
    }
  });

  test('J-0157 a sign-in’s timer is the kernel clock’s, so it ends with the daemon and a test can drive it', () => {
    const armed: number[] = [];
    const timer = harnessLoginTimer({
      after: (delay: number) => {
        armed.push(Number(delay));
        return () => undefined;
      },
    } as never);

    timer.after(1_500, () => undefined)();

    expect(armed).toEqual([Number(milliseconds(1_500))]);
  });

  test('J-0223 J-0224 J-0226 a sign-in keeps its window, its idle limit and its shutdown grace', () => {
    expect([HARNESS_LOGIN_WINDOW_MINUTES, HARNESS_LOGIN_IDLE_MINUTES, HARNESS_LOGIN_SHUTDOWN_GRACE_MS]).toEqual([
      10, 5, 2_000,
    ]);
  });
});
