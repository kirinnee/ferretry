/**
 * The browser entry for the "What's new" evidence: THE REAL SHELL — `RouterProvider > StoreProvider >
 * AppShell`, exactly as `App` composes it — over ONE FAKE DAEMON that answers a sessions list and the
 * About read, with the repository's real `Changelog.md` stamped in the way `vite.config.ts` stamps `__FY_CHANGELOG__`.
 *
 * It exists because the component harness mounts the sheet on its own and the About harness mounts the
 * panel with no host, so neither ever ran the real path: Settings › About › What's new, and the finder's
 * "What's new" command, inside the shell, on a phone. `window.__whatsNew.daemonId` names the machine.
 *
 * Built by `scripts/build-composer-integration-fixture.ts --entry` in a child process, never inside the
 * test runner. The machine, its sessions and its update are fake; the release notes are the real ones.
 */

import type { DaemonUpdateView, SessionView } from '@ferretry/protocol';
import type { DaemonIdentity } from '@ferretry/relay';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import realChangelog from '../../../../../Changelog.md' with { type: 'text' };
import { AppShell } from '../../../src/App.tsx';
import type { DaemonConnectionRepository } from '../../../src/lib/connections.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { RouterProvider } from '../../../src/lib/router.tsx';
import { createAppStore, StoreProvider } from '../../../src/lib/store.tsx';
import { MemoryDeviceKeyStore } from '../../support/device-keys.ts';
import { fetcherDaemons, relayCrypto, testDevice } from '../../support/relay.ts';
import { schemaValidSessionView } from '../../support/schema-valid-sessions.ts';

/** What `vite.config.ts` stamps: the newest `## ` sections of `Changelog.md`, as one string. */
(globalThis as { __FY_CHANGELOG__?: string }).__FY_CHANGELOG__ = realChangelog
  .split(/^(?=## )/mu)
  .slice(0, 40)
  .join('');

const fixedIdentity = async (): Promise<DaemonIdentity> => {
  const prefix = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
  const der = new Uint8Array([...prefix, ...new Uint8Array(32).fill(0x2b)]);
  const lines = btoa(String.fromCharCode(...der)).match(/.{1,64}/gu) ?? [];
  return await relayCrypto.importDaemonIdentity(
    ['-----BEGIN PRIVATE KEY-----', ...lines, '-----END PRIVATE KEY-----', ''].join('\n'),
  );
};

class LocalStorageRepository implements DaemonConnectionRepository {
  async load(key: string): Promise<string | null> {
    return localStorage.getItem(`fy-whats-new:repo:${key}`);
  }

  async save(key: string, value: string): Promise<void> {
    localStorage.setItem(`fy-whats-new:repo:${key}`, value);
  }
}

const identity = await fixedIdentity();
const host = 'studio.example.test';
const connection = daemonConnection({
  daemonId: identity.daemonId,
  baseUrl: `https://${host}`,
  deviceId: 'fy_device_id_whatsNewDevice0000001',
  daemonName: 'studio',
});
(globalThis as { __whatsNew?: { daemonId: string } }).__whatsNew = { daemonId: identity.daemonId };

const session = (index: number): SessionView => {
  const base = schemaValidSessionView(`s-${String(index).padStart(2, '0')}`);
  const at = new Date(Date.UTC(2026, 9, 20, 11, 59 - index)).toISOString();
  return {
    ...base,
    config: { ...base.config, teammate: 'ivo', name: `Fake task number ${index}`, mode: 'interactive', updatedAt: at },
    state: { ...base.state, lastActivityAt: at },
  };
};

/** A Homebrew machine one release behind: the About panel draws its full body, What's new button included. */
const ABOUT_VIEW: DaemonUpdateView = {
  current: '4.92.1',
  method: { kind: 'homebrew', cask: 'ferretry' },
  plan: { kind: 'self', steps: [{ command: 'brew upgrade --cask ferretry' }], rollback: 'none' },
  check: {
    state: 'ok',
    checkedAt: '2026-10-29T12:00:00.000Z',
    latest: { version: '4.93.0', url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.93.0' },
  },
  available: true,
  midTurn: 0,
  autoInstall: false,
  job: null,
};

/** A set-up machine with nothing to install, so Settings › Machine draws its tab without a daemon behind it. */
const MACHINE_VIEW = {
  name: 'studio',
  format: 'version-2',
  setUp: true,
  agentPermissions: 'auto',
  defaultRuntime: 'claude-default',
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false },
  tools: [],
  runtimeCount: 1,
  runningSessions: 0,
  authority: { mayApply: true, applyRefusal: null },
};

/** `?about=failed`: the machine's update read errors, so Settings › About draws its failure card. */
const aboutFails = new URLSearchParams(location.search).get('about') === 'failed';

const daemonFetch = async (): Promise<Response> => Response.json({});
const network = fetcherDaemons([{ host, identity }], daemonFetch);
const deviceKeys = new MemoryDeviceKeyStore();
await deviceKeys.save(identity.daemonId, (await testDevice()).privateKey);

const never = async (_onFrame: unknown, signal?: AbortSignal): Promise<void> =>
  await new Promise<void>(resolve => {
    if (signal?.aborted === true) resolve();
    else signal?.addEventListener('abort', () => resolve(), { once: true });
  });

const store = await createAppStore({
  repository: new LocalStorageRepository(),
  connectionHealthEnvironment: {
    now: () => Date.now(),
    schedule: () => () => undefined,
    random: () => 0,
    isOnline: () => true,
  },
  connectionSignals: { listen: () => () => undefined },
  connectClient: async () =>
    ({
      list: async () => Array.from({ length: 12 }, (_, index) => session(index)),
      get: async (id: string) => session(Number(id.slice(2))),
      logs: async () => '',
      configChanges: never,
      stream: async (_sessionId: unknown, _after: unknown, _onEvent: unknown, signal?: AbortSignal): Promise<void> =>
        await never(undefined, signal),
      wardenStatus: async () => await Promise.reject(new Error('no warden in this scene')),
      wardenVerdicts: async () => [],
      wardenAgenda: async () => await Promise.reject(new Error('no warden in this scene')),
      foreignHistory: async () => ({ conversations: [], skipped: [] }),
      daemonUpdate: aboutFails
        ? async () => await Promise.reject(new Error('this machine did not answer'))
        : async () => ABOUT_VIEW,
      request: async (path: string) => {
        if (path === '/v1/fleet/machine') return MACHINE_VIEW;
        const catalogs: Record<string, unknown> = {
          '/v1/fleet/runtimes': { format: 'version-2', runtimes: [] },
          '/v1/fleet/components': { format: 'version-2', kinds: [] },
          '/v1/fleet/profiles': { format: 'version-2', profiles: [] },
          '/v1/fleet/credentials': { format: 2, machine: 'studio', credentials: [] },
        };
        if (path in catalogs) return catalogs[path];
        if (path === '/v1/daemon/update')
          return aboutFails ? await Promise.reject(new Error('this machine did not answer')) : ABOUT_VIEW;
        return await Promise.reject(new Error('not in this scene'));
      },
    }) as never,
  deviceKeys,
  relayCrypto,
  relayDial: network.dial,
  fetcher: daemonFetch,
});
if (store.connections.get(connection.daemonId) === undefined) store.connections.add(connection, { pairedAt: 1 });

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <StrictMode>
      <RouterProvider>
        <StoreProvider store={store}>
          <AppShell />
        </StoreProvider>
      </RouterProvider>
    </StrictMode>,
  );
