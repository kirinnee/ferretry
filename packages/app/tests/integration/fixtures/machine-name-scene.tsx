/**
 * The browser entry for the machine name over FAKE data (no daemon, no pairing code, no real path): the REAL app shell
 * and the REAL kernel app half over scripted daemons. The machine was paired under its host
 * name, so what the lists show is the name the daemon taught this device.
 *
 *   ?theme=<family>-<mode>
 *   ?view=name        Settings › General › Name (path /d/ws/settings/kernel/name), the owner's name set
 *   ?view=name-host   the same, with no name set: the host name is the placeholder
 *   ?view=daemons     the daemon list (path /)
 *   ?view=pair-name   a machine just paired with, no name of the owner's: the "Name this machine" step
 *   ?view=connecting  the name this device learned, shown while the machine has not answered yet
 */
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
const view = params.get('view') ?? 'name';
const root = document.getElementById('root');

const OWNER_NAME = 'pebox';
const HOST_NAME = 'kirin-mbp.local';
const named = view !== 'name-host' && view !== 'pair-name';
const daemonName = named ? OWNER_NAME : HOST_NAME;

const kernel = generated.surfaces.find(entry => entry.id === 'kernel');
if (kernel === undefined) throw new Error('the generated registry has no kernel');
const surfaces: SurfaceEntry[] = [kernel, ...CORE.filter(entry => entry.id !== 'kernel')];

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
/** One scripted daemon: it answers the plugin list with the name it is called, as the real one does. */
const daemonCalled = (name: string) =>
  new FakeTransport((request: TransportRequest): TransportAnswer => {
    const path = request.path.split('?')[0];
    if (path === '/v1/plugins') return json({ ...(inventoryOf(surfaces) as object), daemonName: name });
    if (path === '/v1/config/file')
      return json({
        path: 'host.yaml',
        exists: named,
        text: named ? `name: "${OWNER_NAME}"\n` : '',
        etag: named ? 'e1' : 'e0',
      });
    if (path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    if (path === '/v1/grants') return json(grants);
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
// Paired while it still went by its host name: the plugin list teaches this device the name it has now.
list.add({
  daemon: 'ws',
  machine: HOST_NAME,
  deviceId: 'dev',
  address: 'http://127.0.0.1:40245',
  ...(view === 'pair-name' ? { askName: true as const } : {}),
});
if (view === 'connecting') list.learnMachine('ws', OWNER_NAME);
if (view === 'daemons')
  list.add({ daemon: 'lap', machine: 'kirin-laptop', deviceId: 'dev2', address: 'http://127.0.0.1:40246' });
const runtime = new ShellRuntime({
  appVersion: '5.0.0',
  surfaces,
  daemons: list,
  connect: async paired =>
    view === 'connecting'
      ? await new Promise<never>(() => undefined)
      : paired.daemon === 'lap'
        ? daemonCalled('kirin-laptop')
        : daemonCalled(daemonName),
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
