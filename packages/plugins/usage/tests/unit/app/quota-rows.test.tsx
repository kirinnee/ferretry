import { expect, test } from 'bun:test';
import { RouterProvider, ensureDom, interact, mount } from '@ferretry/app/testing';
import usageApp from '../../../app/index.ts';
import usageManifest from '../../../manifest.ts';
import { fakeClient } from './support/client.ts';

/**
 * The real multi-row shape. Ferrets draws this panel once PER ROW, and each row's component builds its own
 * `{ daemonId }` through `useDaemonConnection()` — so 25 rows hand the store 25 DISTINCT connection objects for one
 * daemon. The list must still cost one `GET /v1/usage`, and each row must read the quota of its OWN login.
 */
const screens = [{ plugin: 'ferrets', id: 'ferrets', path: 'ferrets', label: 'Ferrets' }];
const rows = Array.from({ length: 25 }, (_, i) => `row-${i}`);
const loginOf = (i: number): string => (i === 24 ? 'renamed-login' : i % 2 === 0 ? 'login-a' : 'login-b');

const account = (agent: string, fiveHourPercent: number) => ({
  agent,
  fiveHourPercent,
  weeklyPercent: 10,
  atLimit: false,
  authOk: true,
});

test('25 quota panels on one daemon share one usage read and each uses its own login', async () => {
  const client = fakeClient({
    'GET /v1/usage': {
      at: '2026-08-01T09:00:00.000Z',
      stale: false,
      accounts: [account('login-a', 42), account('login-b', 83), account('runtime-a', 91)],
    },
  });
  const build = usageApp.build;
  if (build === undefined) throw new Error('the usage app has no build');
  const half = build({ manifest: usageManifest, client: client as never });
  ensureDom();
  window.history.pushState(null, '', '/d/alpha/ferrets');
  const view = await mount(
    <RouterProvider screens={screens}>
      <ul>
        {rows.map((id, i) => (
          <li key={id} data-row={id}>
            {half.panels.quota?.({ login: loginOf(i) } as never) as never}
          </li>
        ))}
      </ul>
    </RouterProvider>,
  );
  try {
    await interact(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    const text = (i: number): string => view.container.querySelector(`[data-row="row-${i}"]`)?.textContent ?? '';
    expect(client.calls.filter(call => call.route === 'GET /v1/usage')).toHaveLength(1);
    expect(text(0)).toContain('42%');
    expect(text(1)).toContain('83%');
    // A login the feed does not name draws nothing, and never another account's number.
    expect(text(24)).toBe('');
    expect(rows.some((_, i) => text(i).includes('91%'))).toBe(false);
  } finally {
    await view.unmount();
    window.history.pushState(null, '', '/');
  }
});
