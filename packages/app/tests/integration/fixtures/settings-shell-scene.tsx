/**
 * The browser entry for the Settings shell (s6 R2-5, R2-6, R2-7): the REAL `App` over ONE FAKE machine whose settings
 * tabs are the REAL declarations of every shipped plugin (label, group, order) with fake bodies, so the grouping drawn
 * is the one a person gets. No daemon, no network. Everything on screen is fake data.
 *
 *   /d/ws/settings[/<plugin>/<tab>]   Settings, grouped, with the Setup, Warden … tabs one click away
 *   /settings                         Settings › This device, with its way back to the daemon's settings
 *   ?theme=<family>-<mode>
 */

import { implementApp, type Manifest } from '@ferretry/kernel/manifest';
import { createRoot } from 'react-dom/client';
import type { TransportAnswer, TransportRequest } from '../../../src/client/transport.ts';
import { type DaemonlessPorts, registeredDaemonless } from '../../../src/connect/provides.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { generated } from '../../../src/generated/surfaces.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import type { PasskeyHandler, PasskeyProvision } from '../../../src/passkey/passkey.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../../unit/client/fixtures.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const root = document.getElementById('root');
// The real tab declarations of every shipped plugin, with a fake body each.
const surfaces: SurfaceEntry[] = [
  ...CORE,
  ...generated.surfaces
    .filter(entry => (entry.manifest.ui?.settings ?? []).length > 0 && !CORE.some(core => core.id === entry.id))
    .map(entry => {
      const settings = entry.manifest.ui?.settings ?? [];
      const manifest = {
        id: entry.id,
        title: entry.title,
        version: '5.0.0',
        api: 5,
        core: false,
        kinds: ['view'],
        ui: { settings },
      } as unknown as Manifest;
      const bodies = Object.fromEntries(
        settings.map(setting => [setting.id, () => <p>{`${setting.label} settings (fake data)`}</p>]),
      );
      return {
        id: entry.id,
        title: entry.title,
        core: false,
        contract: `h-${entry.id}`,
        consumes: [],
        manifest,
        app: implementApp(manifest, { build: () => ({ screens: {}, settings: bodies }) as never }),
      } satisfies SurfaceEntry;
    }),
];
const grants = {
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
const transport = new FakeTransport((request: TransportRequest): TransportAnswer => {
  if (request.path === '/v1/plugins') return json(inventoryOf(surfaces));
  if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
  if (request.path === '/v1/grants') return json(grants);
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
