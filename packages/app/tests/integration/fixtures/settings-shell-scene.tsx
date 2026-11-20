/**
 * The browser entry for the Settings shell (s6 R2-5, R2-6, R2-7): the REAL `App` over ONE FAKE machine whose settings
 * tabs are the REAL declarations of every shipped plugin (label, group, order) with fake bodies, so the grouping drawn
 * is the one a person gets. No daemon, no network. Everything on screen is fake data.
 *
 *   /d/ws/settings[/<plugin>/<tab>]   Settings, grouped, with the Setup, Warden … tabs one click away
 *   /settings                         Settings › This device, with its way back to the daemon's settings
 *   ?theme=<family>-<mode>
 *   ?real=agenda                      the Agenda surface is the plugin's REAL app half (its real Settings tab body), in the real shell
 *   ?real=runtimes                    the Runtimes surface is REAL too, over the fake reads in runtimes-reads.json (r10 S11)
 */

import { implementApp, type Manifest } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
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
import fleetReads from './runtimes-reads.json';

/**
 * REAL BODIES FOR THIS SCENE: a plugin's integration test that must measure its real page INSIDE the real shell (the drawer, the
 * nav, the panel it actually gets) registers it on `globalThis.__FY_SCENE_SETTINGS_BODIES__`, keyed `<plugin>/<tab>`, from a
 * module the test's generated entry imports BEFORE this one. A global, not an import: a plugin reaches the app only through its
 * public API. Any tab not registered keeps its fake body below.
 */
const sceneBodies: ReadonlyMap<string, () => ReactNode> =
  (globalThis as { __FY_SCENE_SETTINGS_BODIES__?: Map<string, () => ReactNode> }).__FY_SCENE_SETTINGS_BODIES__ ??
  new Map();

/**
 * REAL PLUGINS OVER FAKE ANSWERS: a plugin whose real app half reads the daemon (Access: its devices, grants, passkeys) is
 * registered the same way, on `globalThis.__FY_SCENE__`, from the test's generated entry (a global for the same reason as above):
 *   real       plugin ids whose REAL surface replaces the fake one here (a core id such as `gate` replaces its stand-in)
 *   answer     the fake machine's answer to a request, asked BEFORE the defaults below; `undefined` falls through to them
 *   deviceId   the id this browser is paired under on the fake machine
 */
interface SceneRegistration {
  readonly real?: readonly string[];
  readonly answer?: (request: TransportRequest) => TransportAnswer | undefined;
  readonly deviceId?: string;
}
const registration = (globalThis as { __FY_SCENE__?: SceneRegistration }).__FY_SCENE__ ?? {};
const realIds = new Set(registration.real ?? []);

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const root = document.getElementById('root');
// The real tab declarations of every shipped plugin, with a fake body each; the ones a test registers as real are whole.
const surfaces: SurfaceEntry[] = [
  ...CORE.filter(core => !realIds.has(core.id)),
  ...generated.surfaces.filter(entry => realIds.has(entry.id)),
  ...generated.surfaces
    .filter(
      entry =>
        (entry.manifest.ui?.settings ?? []).length > 0 &&
        !CORE.some(core => core.id === entry.id) &&
        !realIds.has(entry.id),
    )
    .map(entry => {
      if (entry.id === 'agenda' && params.get('real') === 'agenda') return entry;
      // The Runtimes tabs also read the Logins list, so its REAL manifest (the routes it declares) stays too.
      if ((entry.id === 'runtimes' || entry.id === 'logins') && params.get('real') === 'runtimes') return entry;
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
        settings.map(setting => [
          setting.id,
          sceneBodies.get(`${entry.id}/${setting.id}`) ??
            // A real tab is a screenful or more (a list of logins, a form): the fake one is tall enough to scroll to.
            (() => (
              <div>
                <p>{`${setting.label} settings (fake data)`}</p>
                {Array.from({ length: 24 }, (_, row) => row + 1).map(number => (
                  <p key={number}>{`${setting.label}: fake row ${number}`}</p>
                ))}
              </div>
            )),
        ]),
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
  const registered = registration.answer?.(request);
  if (registered !== undefined) return registered;
  if (request.path === '/v1/plugins') return json(inventoryOf(surfaces));
  if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
  if (request.path === '/v1/grants') return json(grants);
  const scripted = (fleetReads as Record<string, unknown>)[`${request.method} ${request.path}`];
  if (scripted !== undefined && params.get('real') === 'runtimes') return json(scripted);
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
list.add({
  daemon: 'ws',
  machine: 'workshop-host',
  deviceId: registration.deviceId ?? 'dev',
  address: 'http://127.0.0.1:40245',
});
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
