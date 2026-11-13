/**
 * Parity rows J-0042, J-0087, J-0157, J-0223, J-0224, J-0226: the reads and timers Logins keeps.
 *
 * J-0096 (v4's watched fleet-manifest read, cached until the file-event hub said it changed) is the kernel config
 * service's now: it serves the answer of the last reload and its file watcher lets go of it, proved in the kernel's
 * host-config service test. Logins adds no cache on top, which the read test below pins. What Logins' watch does do
 * is announce a file that moved in effect (`logins.changed`), proved in tests/unit/daemon/config-watch.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { milliseconds } from '@ferretry/std';
import { testHost } from '@ferretry/kernel/testing';
import { harnessLoginTimer } from '../../../daemon/adapters/harness-login/login-child.ts';
import {
  HARNESS_LOGIN_IDLE_MINUTES,
  HARNESS_LOGIN_SHUTDOWN_GRACE_MS,
  HARNESS_LOGIN_WINDOW_MINUTES,
} from '../../../daemon/lib/harness-login/service.ts';
import { LoginChanged, LoginListSchema } from '../../../contract/index.ts';
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

  test('Logins keeps no read cache of its own: the next read returns whatever the host config holds at that moment', async () => {
    // The test host's config is edited IN PLACE and its port reads it live, so the host fires no config listener:
    // whatever the next read shows, Logins took it from the host at that moment and held none of its own. (The real
    // host serves the last reload's snapshot, which is the kernel's cache, proved in its service test J-0096.)
    const logins: Record<string, unknown> = { work: { harness: 'claude-code', store: 'host' } };
    const host = await testHost({ plugins: [daemon], fakes: { vault: emptyVault() }, config: { logins } });
    try {
      await host.settle();
      const idsOf = async () =>
        (LoginListSchema.parse((await host.request('GET', '/v1/logins')).json()).logins as readonly { id: string }[])
          .map(login => login.id)
          .sort();
      const announced = () => host.published.filter(entry => entry.event === LoginChanged.name).length;

      expect(await idsOf()).toEqual(['work']);

      logins.home = { harness: 'codex', store: 'host' };
      expect(await idsOf()).toEqual(['home', 'work']);

      delete logins.work;
      expect(await idsOf()).toEqual(['home']);

      expect(announced()).toBe(0);
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
