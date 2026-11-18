/**
 * WHERE THE FRAME'S RELAY LINE SPEAKS: only on a settings screen, where the connection matters. On every other page the
 * connection simply works, so the page stays clean (the line used to sit, red, on every page).
 */
import { afterEach, expect, test } from 'bun:test';
import { mount, type Mounted, RouterProvider } from '@ferretry/app/testing';
import { RELAY_FALLBACK_LINE } from '../../../app/carriers/router.ts';
import { relayFallbackView } from '../../../app/features/carrier/relay-fallback-notice.tsx';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  if (typeof window !== 'undefined') window.history.replaceState(null, '', '/');
});

const router = { subscribe: () => () => undefined, relayFallback: () => RELAY_FALLBACK_LINE };
const Watcher = relayFallbackView(() => router);

const saidAt = async (path: string): Promise<boolean> => {
  window.history.replaceState(null, '', path);
  await view?.unmount();
  view = await mount(
    <RouterProvider>
      <Watcher daemon="fy_daemon_a" client={{} as never} />
    </RouterProvider>,
  );
  return (view.container.textContent ?? '').includes(RELAY_FALLBACK_LINE);
};

test('the line is silent on an ordinary page and speaks on a settings screen', async () => {
  // The first mount is what puts a DOM in place; the address is set only once there is one.
  view = await mount(<div />);
  expect(await saidAt('/app/')).toBe(false);
  expect(await saidAt('/d/fy_daemon_a')).toBe(false);
  expect(await saidAt('/settings')).toBe(true);
  expect(await saidAt('/d/fy_daemon_a/settings/connections')).toBe(true);
});
