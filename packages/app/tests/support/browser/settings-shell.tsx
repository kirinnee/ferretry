/**
 * THE REAL SETTINGS SHELL for a plugin's browser scene (r10 S5): the real `App` over ONE fake machine whose only plugin is the
 * one handed in, with the plugin's real settings-tab declarations (label, group, scope) and whatever bodies it supplies.
 * No daemon, no network: a fake transport answers the handful of reads the shell makes. A plugin's integration suite reaches
 * it as `@ferretry/app/testing/settings-shell` (a plugin never imports another package's source), and bundles it with
 * `sceneBuilder`. It exists so a settings page is measured at the panel width a person really gets (about 212px at a 768px
 * window, because the drawer, the side column and the settings list take the rest), not in a hand-built frame.
 *
 *   /d/ws/settings/<plugin>/<tab>      the tab, inside the shell
 *   ?theme=<family>-<mode>
 */

import { implementApp, type Manifest } from '@ferretry/kernel/manifest';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import type { TransportAnswer, TransportRequest } from '../../../src/client/transport.ts';
import { type DaemonlessPorts, registeredDaemonless } from '../../../src/connect/provides.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import type { PasskeyHandler, PasskeyProvision } from '../../../src/passkey/passkey.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../../unit/client/fixtures.ts';

export interface SettingsShellScene {
  /** The plugin's real manifest (`manifest.ts`'s default export). */
  readonly manifest: unknown;
  /** One body per settings tab id the manifest declares. */
  readonly bodies: Readonly<Record<string, ComponentType>>;
  /** Where to draw; the page's `#root` by default. */
  readonly root?: HTMLElement | null;
}

const GRANTS = {
  capabilities: [
    {
      capability: 'fleet',
      use: true,
      configure: true,
      granted: { use: true, configure: true },
      useRefusal: 'granted',
      configureRefusal: 'granted',
      mayGrant: false,
      origin: 'default',
    },
  ],
  governed: true,
  hostLocal: false,
  steppedUp: false,
};

export function renderSettingsShell({
  manifest: given,
  bodies,
  root = document.getElementById('root'),
}: SettingsShellScene) {
  const params = new URLSearchParams(window.location.search);
  document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
  const manifest = given as Manifest;
  const surfaces: SurfaceEntry[] = [
    ...CORE,
    {
      id: manifest.id,
      title: manifest.title,
      core: false,
      contract: `h-${manifest.id}`,
      consumes: [],
      manifest,
      app: implementApp(manifest, { build: () => ({ screens: {}, settings: bodies }) as never }),
    } satisfies SurfaceEntry,
  ];
  const transport = new FakeTransport((request: TransportRequest): TransportAnswer => {
    if (request.path === '/v1/plugins') return json(inventoryOf(surfaces));
    if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    if (request.path === '/v1/grants') return json(GRANTS);
    return json({ ok: true });
  });
  const handler: PasskeyHandler = {
    need: () => undefined,
    confirm: async () => true,
    ask: async () => false,
    focus: () => undefined,
    locked: () => [],
    subscribe: () => () => undefined,
  };
  const provision = { handler, Prompts: () => null } as unknown as PasskeyProvision;
  const list = new DaemonList({ storage: memoryStore(), now: () => 1 });
  list.add({ daemon: 'ws', machine: 'workshop-host', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  const runtime = new ShellRuntime({
    appVersion: '5.0.0',
    surfaces,
    daemons: list,
    connect: async () => transport,
    passkey: () => provision,
    daemonless: {
      views: registeredDaemonless(surfaces, {} as DaemonlessPorts).views,
      location: () => window.location.href,
    },
  });
  const storage = memoryStore();
  if (root !== null)
    createRoot(root).render(
      <App
        runtime={runtime}
        themes={new ThemePreferenceStore(storage)}
        layouts={new DeviceLayoutStore(storage)}
        browser={window}
        scroll={new ScrollMemory(null)}
      />,
    );
}
