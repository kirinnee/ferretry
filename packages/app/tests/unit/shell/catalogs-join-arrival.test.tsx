import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { type DaemonlessPorts, registeredDaemonless } from '../../../src/connect/provides.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { generated } from '../../../src/generated/surfaces.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { interact, mount } from '../../support/dom.ts';
import { CORE, FakeTransport, json } from '../client/fixtures.ts';

/**
 * R2-B1: A SHARE LINK THAT ARRIVES MUST NOT KEEP ITS LIVE CODE IN THE ADDRESS BAR OR THE HISTORY. The shell is booted with
 * NO daemon paired (a recipient's browser) over the real Catalogs half, at `/join#<fragment>`.
 */

const catalogs = generated.surfaces.find(entry => entry.id === 'catalogs') as SurfaceEntry;
const surfaces: SurfaceEntry[] = [...CORE, catalogs];

const browser: ShellWindow = {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  document: { documentElement: document.documentElement },
};

const go = (path: string): void => window.history.replaceState(null, '', path);
afterEach(() => go('/'));

/** Lets the lazily loaded views arrive and their effects run. */
async function until(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !done(); turn += 1) {
    await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
  }
}

/** Boots the shell over the real Catalogs half with no daemon paired, at whatever address the page is on. */
async function boot() {
  const transport = new FakeTransport(() => json({ error: 'none', code: 'not_found' }, 404));
  const storage = memoryStore();
  const daemons = new DaemonList({ storage, now: () => 1 });
  const registered = registeredDaemonless([catalogs], {} as DaemonlessPorts);
  expect(registered.failures).toEqual([]);
  const runtime = new ShellRuntime({
    appVersion: '5.1.0',
    surfaces,
    daemons,
    connect: async () => transport,
    daemonless: { views: registered.views, location: () => window.location.href },
  });
  const mounted = await mount(
    <App
      runtime={runtime}
      themes={new ThemePreferenceStore(storage)}
      layouts={new DeviceLayoutStore(storage)}
      browser={browser}
      scroll={new ScrollMemory(null)}
    />,
  );
  return { mounted, transport };
}

const FRAGMENT = '#v1;code=fy_share_x';

describe('R2-B1 a share link arriving on /join', () => {
  test('R2-B1 the shell with no daemons takes the code off /join: no hash, no new history entry, no write carrying a #', async () => {
    go(`/join${FRAGMENT}`);
    const lengthBefore = window.history.length;
    const push = spyOn(window.history, 'pushState');
    const replace = spyOn(window.history, 'replaceState');
    try {
      const { mounted, transport } = await boot();
      await until(() => window.location.hash === '');
      expect(window.location.hash).toBe('');
      expect(window.location.pathname).toBe('/join');
      expect(window.history.length).toBe(lengthBefore);
      expect(push).not.toHaveBeenCalled();
      const written = [...push.mock.calls, ...replace.mock.calls].map(call => String(call[2] ?? ''));
      expect(written.filter(url => url.includes('#'))).toEqual([]);
      expect(replace).toHaveBeenCalled();
      // No daemon is contacted for the screen.
      expect(transport.paths()).toEqual([]);
      await mounted.unmount();
    } finally {
      push.mockRestore();
      replace.mockRestore();
    }
  });

  test('R2-N3 the entry’s own history state goes back in with the rewrite', async () => {
    const state = { fyEntry: 'e1', fyIndex: 0 };
    window.history.replaceState(state, '', `/join${FRAGMENT}`);
    const replace = spyOn(window.history, 'replaceState');
    try {
      const { mounted } = await boot();
      await until(() => window.location.hash === '');
      const stripping = replace.mock.calls.filter(call => call[2] === '/join');
      expect(stripping.length).toBeGreaterThan(0);
      // Whatever the router has adopted by then, the strip hands back the state THE ENTRY HAS, never an empty one.
      expect(
        stripping.every(call => call[0] !== null && typeof call[0] === 'object' && Object.keys(call[0]).length > 0),
      ).toBe(true);
      await mounted.unmount();
    } finally {
      replace.mockRestore();
    }
  });

  test('R2-B1 a second link opened in the same tab (hashchange) leaves the address too', async () => {
    go('/join');
    const { mounted } = await boot();
    await until(() => document.body.textContent !== '' && mounted.container.textContent !== '');
    const push = spyOn(window.history, 'pushState');
    try {
      go('/join#v1;code=fy_share_y');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await until(() => window.location.hash === '');
      expect(window.location.hash).toBe('');
      expect(push).not.toHaveBeenCalled();
      await mounted.unmount();
    } finally {
      push.mockRestore();
    }
  });

  test('an address with no fragment is left exactly as it is', async () => {
    go('/join?x=1');
    const replace = spyOn(window.history, 'replaceState');
    try {
      const { mounted } = await boot();
      await until(() => mounted.container.textContent !== '');
      const stripping = replace.mock.calls.filter(call => call[2] === '/join?x=1');
      expect(stripping).toEqual([]);
      expect(window.location.search).toBe('?x=1');
      await mounted.unmount();
    } finally {
      replace.mockRestore();
    }
  });
});
