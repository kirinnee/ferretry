// This import MUST come first: it captures Bun's WebSocket and WebCrypto before happy-dom replaces the globals.
import { NativeResponse, nativeSetTimeout } from '../two-release/native-socket.ts';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FerretRecordSchema } from '../../../../core/ferrets/contract/index.ts';
import { type StartedDaemon, startDaemon } from '../../../../../scripts/test/two-release/daemon.ts';
import type { DaemonRegistry } from '../../../../../scripts/test/two-release/releases.ts';
import { realDaemonRegistry } from '../../../../../scripts/test/two-release/real-release.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { type AppSession, openApp, turnUnlockOffAtTheMachine } from '../two-release/session.ts';

/**
 * A FERRET PAGE OPENS IN THE BUILT APP, ON A REAL 5.0 DAEMON (sessions-carry; the parity sweep's top finding).
 *
 * Every ferret page in 5.0 said "Conversation issue: Session: [zod: config expected object, state expected object,
 * directory expected string]" and drew nothing — no chat, toolbar, side panels or composer: the chat parsed Ferrets'
 * `GET /v1/ferrets/:ferretId` with today's whole session view (`{ config, state, directory }`), while the route serves
 * Ferrets' summary. The chat's unit tests fed a hand-written view, so nothing ever put the chat in front of the route.
 *
 * Here nothing is hand-written on the RESPONSE side. The daemon is the real kernel host over the real generated
 * registry; the ferret is a record in its home (STATE, written through Ferrets' own `FerretRecordSchema`, as a daemon
 * leaves it); the device is paired over the real direct carrier; and the page is the real `App` frame over the real
 * generated surfaces, in happy-dom, at the chat's own path.
 */

const FERRET = 'mwsc0001-5e55c4ee';
const AT = '2026-11-13T18:48:06.695Z';

/** One stopped ferret, as Ferrets keeps it: `state/ferrets/<id>/ferret.json`, checked by its owner's schema. */
const seedFerret = async (home: string): Promise<void> => {
  const record = FerretRecordSchema.parse({
    format: 1,
    id: FERRET,
    name: 'daisy',
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    runtime: 'claude-default',
    folder: '/tmp',
    state: 'stopped',
    createdAt: AT,
    stateAt: AT,
  });
  const folder = join(home, 'state', 'ferrets', FERRET);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(join(folder, 'ferret.json'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
};

/**
 * The DOM, loaded for THIS file only (as the two-release leg does): happy-dom replaces the global scope for whoever
 * runs after it, so it is registered here and unregistered in `afterAll`.
 */
let dom: typeof import('../../support/dom.ts');
let daemonRegistry: DaemonRegistry;
let surfaces: readonly SurfaceEntry[];
let appVersion: string;
let daemon: StartedDaemon | undefined;
let session: AppSession | undefined;
const originalResponse = globalThis.Response;

beforeAll(async () => {
  dom = await import('../../support/dom.ts');
  // The daemon in this process answers through the global `Response`, and `Bun.serve` accepts only Bun's own.
  globalThis.Response = NativeResponse;
  daemonRegistry = await realDaemonRegistry();
  const generated = (await import('../../../src/generated/surfaces.ts')) as unknown as {
    generated: { appVersion: string; surfaces: readonly SurfaceEntry[] };
  };
  surfaces = generated.generated.surfaces;
  appVersion = generated.generated.appVersion;
  daemon = await startDaemon({ name: 'A', daemon: daemonRegistry } as never, { version: appVersion, seed: seedFerret });
  // The passkey unlock is the device's step-up, not what this file tests: the owner turns it off at the machine.
  await turnUnlockOffAtTheMachine(daemon);
  session = await openApp(daemon, { surfaces, appVersion }, { grants: 'full' });
  await session.ready();
}, 60_000);

afterAll(async () => {
  session?.close();
  await daemon?.stop();
  globalThis.Response = originalResponse;
  window.history.replaceState({}, '', '/');
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  await GlobalRegistrator.unregister();
  (globalThis as { __ferretryDomRegistered?: boolean }).__ferretryDomRegistered = false;
});

const browser = (): ShellWindow => ({
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  document: { documentElement: document.documentElement },
});

/** A bounded poll with a short step; the step is a poll interval, never a budget. */
async function until(condition: () => boolean, what: string, seen: () => string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`waited ${ms} ms for ${what}; the page said: ${seen()}\n${daemon?.diagnose() ?? ''}`);
    await dom.interact(() => new Promise<void>(resolve => nativeSetTimeout(resolve, 10)));
  }
}

describe('a ferret page, in the built app, against the daemon that serves it', () => {
  test('the chat opens connected: the ferret is read, messages and composer drawn, no session refusal', async () => {
    if (session === undefined) throw new Error('the app session did not open');
    window.history.replaceState({}, '', `/d/${session.daemonId}/ferrets/${FERRET}/chat`);
    const view = await dom.mount(
      <App
        browser={browser()}
        layouts={new DeviceLayoutStore(session.storage)}
        runtime={session.runtime}
        scroll={new ScrollMemory(null)}
        themes={new ThemePreferenceStore(session.storage)}
      />,
    );
    try {
      const page = view.container;
      const said = () => page.textContent ?? '';
      const state = () => page.querySelector('[data-session-state]')?.getAttribute('data-session-state');
      await until(() => state() === 'connected' || state() === 'failed', 'the chat to read the ferret', said);

      // The ferret is read: the session part of the refresh has nothing to say.
      expect(state()).toBe('connected');
      expect(page.querySelector('[data-session-error]')?.textContent ?? '').not.toContain('Session:');
      expect(said()).not.toContain('zod');
      // The page is drawn: the messages, the composer.
      expect(page.querySelector('[data-chat-messages]')).not.toBeNull();
      expect(page.querySelector('[data-session-input]')).not.toBeNull();
      // This seeded ferret has no transcript, and the page says exactly that (an honest state, not a read failure).
      expect(page.querySelector('[data-session-error]')?.textContent ?? '').toContain(
        `session ${FERRET} has no transcript this daemon can prove is its own`,
      );
    } finally {
      await view.unmount();
    }
  }, 60_000);
});
