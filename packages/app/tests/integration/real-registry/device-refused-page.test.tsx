// This import MUST come first: it captures Bun's WebSocket and WebCrypto before happy-dom replaces the globals.
import { NativeResponse, nativeFetch, nativeSetTimeout } from '../two-release/native-socket.ts';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type StartedDaemon, startDaemon } from '../../../../../scripts/test/two-release/daemon.ts';
import type { DaemonRegistry } from '../../../../../scripts/test/two-release/releases.ts';
import { realDaemonRegistry } from '../../../../../scripts/test/two-release/real-release.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { pairAgainHref } from '../../../src/router/routes.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { type AppSession, openApp, turnUnlockOffAtTheMachine } from '../two-release/session.ts';

/**
 * THE REFUSED CLOSE (`4403`), END TO END, ON A REAL DAEMON: the owner removes a paired browser at the machine and the
 * browser's page leaves the shell for ONE full-page screen.
 *
 * Nothing on the response side is written by hand. The daemon is the real kernel host over the real generated registry, in a
 * temp home, on a loopback port in this unit's own range (7480-7499); the device is paired over the real direct carrier with a
 * real code (never printed); the page is the real `App` over the real generated surfaces, in happy-dom. The device is then
 * REVOKED through the daemon's own door (`DELETE /v1/pair/devices/:deviceId`, the admin token over loopback: what
 * `fy device revoke` does), and the app's live session is the one the machine then refuses with `4403`.
 */

const PORTS = { from: 7480, to: 7499 } as const;

/**
 * This file's own port in the range: derived from the process id, so two runs on one box rarely meet, with nothing probed and
 * closed first (a probe races the daemon's bind). A run that does meet another fails loudly at the daemon's boot.
 */
const PORT = PORTS.from + (process.pid % (PORTS.to - PORTS.from + 1));

let dom: typeof import('../../support/dom.ts');
let daemonRegistry: DaemonRegistry;
let surfaces: readonly SurfaceEntry[];
let appVersion: string;
let daemon: StartedDaemon | undefined;
let session: AppSession | undefined;
const originalResponse = globalThis.Response;

beforeAll(async () => {
  dom = await import('../../support/dom.ts');
  dom.registerDom();
  // The daemon in this process answers through the global `Response`, and `Bun.serve` accepts only Bun's own.
  globalThis.Response = NativeResponse;
  daemonRegistry = await realDaemonRegistry();
  const generated = (await import('../../../src/generated/surfaces.ts')) as unknown as {
    generated: { appVersion: string; surfaces: readonly SurfaceEntry[] };
  };
  surfaces = generated.generated.surfaces;
  appVersion = generated.generated.appVersion;
  daemon = await startDaemon({ name: 'A', daemon: daemonRegistry } as never, {
    version: appVersion,
    port: PORT,
  });
  // The passkey unlock is the device's step-up, not what this file tests: the owner turns it off at the machine.
  await turnUnlockOffAtTheMachine(daemon);
  session = await openApp(daemon, { surfaces, appVersion }, { grants: 'full' });
  await session.ready();
}, 90_000);

afterAll(async () => {
  session?.close();
  await daemon?.stop();
  globalThis.Response = originalResponse;
  window.history.replaceState({}, '', '/');
  await dom.unregisterDom();
});

const browser = (): ShellWindow => ({
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  document: { documentElement: document.documentElement },
});

async function until(condition: () => boolean, what: string, seen: () => string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`waited ${ms} ms for ${what}; the page said: ${seen()}\n${daemon?.diagnose() ?? ''}`);
    await dom.interact(() => new Promise<void>(resolve => nativeSetTimeout(resolve, 10)));
  }
}

describe('a paired browser the machine removes', () => {
  test('the page leaves the shell for one full-page "not connected any more" screen with Pair again', async () => {
    if (session === undefined || daemon === undefined) throw new Error('the app session did not open');
    const live = session;
    const machine = daemon;
    const id = live.daemonId;
    const deviceId = live.daemons.get(id)?.deviceId;
    if (deviceId === undefined) throw new Error('the pairing holds no device id');
    window.history.replaceState({}, '', `/d/${id}`);
    const view = await dom.mount(
      <App
        browser={browser()}
        layouts={new DeviceLayoutStore(live.storage)}
        runtime={live.runtime}
        scroll={new ScrollMemory(null)}
        themes={new ThemePreferenceStore(live.storage)}
      />,
    );
    try {
      const page = view.container;
      const said = () => page.textContent ?? '';
      // While the machine accepts this browser it is the ordinary shell: the drawer, and no stop page.
      await until(() => page.querySelector('.fy-drawer') !== null, 'the shell to draw', said);
      expect(page.querySelector('[data-machine-stop]')).toBeNull();

      // The owner, at the machine, removes this browser (the same door as `fy device revoke`).
      const revoked = await nativeFetch(`${machine.url}/v1/pair/devices/${encodeURIComponent(deviceId)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${await machine.adminToken()}` },
      });
      expect(revoked.status).toBe(200);
      // Every session the app holds ends, as a closed tab or a dropped carrier would: the next one the machine refuses with 4403.
      live.endAppSessions();

      await until(() => page.querySelector('[data-machine-stop="refused"]') !== null, 'the refused page', said);
      const headline = page.querySelector('h1') as HTMLElement;
      // The machine's name is the one this browser learned from it, whatever the host calls itself.
      const name = live.daemons.get(id)?.machine ?? '';
      expect(name.length).toBeGreaterThan(0);
      expect(headline.textContent).toBe(`This browser isn't connected to ${name} any more`);
      expect(page.querySelectorAll('h1').length).toBe(1);
      // ONE page, not a line over dead chrome: no drawer, no find box, no nav, no title bar.
      expect(
        page.querySelector('.fy-drawer, [data-slot="bottom"], [data-slot="phone-title"], [data-drawer-find]'),
      ).toBeNull();
      expect(document.activeElement).toBe(headline);
      expect(said()).toContain('went unused for too long');
      // Nothing was removed from this browser: the pairing stays, and Pair again is the repair.
      expect(live.daemons.get(id)).toBeDefined();
      const pairAgain = page.querySelector('[data-device-refused-pair]') as HTMLButtonElement;
      expect(pairAgain.textContent).toBe('Pair again');
      await dom.interact(async () => pairAgain.click());
      await until(
        () => `${window.location.pathname}${window.location.search}` === pairAgainHref(id),
        'Pair again to open the pairing page',
        said,
      );
    } finally {
      await view.unmount();
    }
  }, 120_000);
});
