import { afterEach, describe, expect, test } from 'bun:test';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { DEVICE_SETTINGS_HREF } from '../../../src/router/routes.ts';
import { RelaySessionError } from '../../../src/session/session-client.ts';
import { RELAY_CLOSE_CODES } from '../../../src/session/wire/index.ts';
import { UNREADABLE_INVENTORY_SENTENCE } from '../../../src/client/sentences.ts';
import { App } from '../../../src/shell/app.tsx';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { interact, mount } from '../../support/dom.ts';
import { CORE, FakeTransport } from '../client/fixtures.ts';

/**
 * A WHOLE MACHINE BLOCKED BY A CARRIER THAT COULD NOT CARRY THE READ (`docs/relay-protocol.md` §15): the block page says
 * the list could not be read, names the carrier's own cause, and ALWAYS offers the Connection setting — kept on this
 * device, so it needs none of the machine's own (blocked) screens.
 */

const browser: ShellWindow = {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  document: { documentElement: document.documentElement },
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

const go = (path: string): void => window.history.replaceState({}, '', path);
afterEach(() => go('/'));

const CAUSE = 'Relay only — there is no relay for this machine right now.';

async function render() {
  const transport = new FakeTransport(() => {
    throw new RelaySessionError(CAUSE, RELAY_CLOSE_CODES.daemonAbsent);
  });
  const storage = memoryStore();
  const daemons = new DaemonList({ storage, now: () => 1 });
  daemons.add({ daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  const runtime = new ShellRuntime({
    appVersion: '5.0.0',
    surfaces: [...CORE],
    daemons,
    connect: async () => transport,
  });
  go('/d/d1');
  const view = await mount(
    <App
      runtime={runtime}
      themes={new ThemePreferenceStore(storage)}
      layouts={new DeviceLayoutStore(storage)}
      browser={browser}
      scroll={new ScrollMemory(null)}
    />,
  );
  await settle();
  return view;
}

describe('a machine whose plugin list could not be read through its carrier', () => {
  test('the block says so, names the carrier’s cause, and offers the Connection setting', async () => {
    const view = await render();
    const main = view.container.querySelector('main')?.textContent ?? '';
    expect(main).toContain(UNREADABLE_INVENTORY_SENTENCE);
    expect(main).toContain(`Why: ${CAUSE}`);
    const link = view.container.querySelector('[data-whole-daemon-connection] a') as HTMLAnchorElement;
    expect(link.textContent).toBe('Connection settings');
    expect(link.getAttribute('href')).toBe(DEVICE_SETTINGS_HREF);
    await view.unmount();
  });

  test('following it leaves the block for This device’s settings, which need no machine', async () => {
    const view = await render();
    const link = view.container.querySelector('[data-whole-daemon-connection] a') as HTMLAnchorElement;
    await interact(async () => link.click());
    await settle();
    expect(window.location.pathname).toBe(DEVICE_SETTINGS_HREF);
    expect(view.container.querySelector('[data-whole-daemon-connection]')).toBeNull();
    await view.unmount();
  });
});
