/**
 * Parity rows J-0042, J-0087, J-0096, J-0157, J-0223, J-0224, J-0226: the reads and timers Logins keeps.
 *
 * J-0096 (v4's watched fleet-manifest read, cached until the file-event hub said it changed) is removed by design
 * (britnee): no read cache, nothing to clear. The test below is the condition of that ruling: a login file changed on
 * disk is seen by the very next read, with no restart and no watch callback. What Logins' watch does do is announce a
 * file that moved in effect (`logins.changed`), proved in tests/unit/daemon/config-watch.test.ts.
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

  test('J-0096 a login file changed on disk is seen by the very next read: no read cache, no restart, no watch callback', async () => {
    // The files are edited IN PLACE under the host (the way an editor writes the disk), so the host fires no config
    // listener: whatever the next read shows, it read from the files and was not told to let go of anything.
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
