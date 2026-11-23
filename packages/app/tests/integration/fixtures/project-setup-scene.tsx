/**
 * The browser entry for the PROJECT SETUP resume gate (C59 O8-13): the REAL `App` over the REAL generated surfaces (every
 * shipped plugin's app half), ONE paired fake machine whose last machine step is "Name this machine" and whose last page is the
 * Projects plugin's own "Add your projects" (a device page). No daemon, no network, no real home: every name and path is made up.
 *
 * The paired list lives in `localStorage` (as the shipped app's does), seeded once, so a SECOND page of the same browser is a
 * relaunch: it reads the paired list and the onboarding ledger the first page left. `window.__fake` is the test's window onto the
 * machine's side (writes, registrations).
 *
 *   /d/<machine>/onboarding/setup   the setup flow of that machine
 *   /                               a launch (what the manifest's start_url opens)
 */
import { createRoot } from 'react-dom/client';
import '../../../src/styles/index.css';
import '../../../src/ui/design-system.css';
import { type DaemonlessPorts, registeredDaemonless, registeredPasskey } from '../../../src/connect/provides.ts';
import { WebCryptoRelayCrypto } from '../../../src/session/webcrypto.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { generated } from '../../../src/generated/surfaces.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { FakeTransport, inventoryOf, json } from '../../unit/client/fixtures.ts';
import { FakeDaemon, type FakeMachine } from './onboarding-e2e-daemon.ts';
import { extraRoutes } from './onboarding-e2e-routes.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const surfaces = generated.surfaces;

/** The one machine: its last machine step is the name, its last page is the Projects plugin's own device page. */
export const MACHINE: FakeMachine = {
  id: `fy_daemon_${'c'.repeat(43)}`,
  name: 'studio-mac',
  address: 'http://127.0.0.1:40245',
  steps: [
    { plugin: 'onboarding', id: 'name', title: 'Name this machine', order: 5, group: 'This machine' },
    { plugin: 'projects', id: 'folders', title: 'Add your projects', order: 90, side: 'client', group: 'Projects' },
  ],
};

const HOME = '/home/sam';
const at = '2026-08-01T10:00:00.000Z';
const folder = (name: string) => ({ name, kind: 'folder', isRepo: false, hidden: false, modifiedAt: at });
/** The projects this machine registered, in the page's order: the page asks for them again on every visit. */
const registered: { id: string; name: string; path: string; source: string; createdAt: string }[] = [];

const fake = new FakeDaemon(MACHINE);
// The machine's own disk: what it was told (step answers, registered projects) outlives the page, as a real daemon's does, so a
// relaunch finds the machine as the first page left it.
const DISK = 'scene-machine-disk';
try {
  const disk = JSON.parse(window.localStorage.getItem(DISK) ?? '{}') as {
    states?: Record<string, never>;
    projects?: typeof registered;
  };
  for (const [key, state] of Object.entries(disk.states ?? {})) fake.states.set(key, state);
  registered.push(...(disk.projects ?? []));
} catch {
  // A damaged disk reads as a new machine.
}
const save = (): void =>
  window.localStorage.setItem(DISK, JSON.stringify({ states: Object.fromEntries(fake.states), projects: registered }));
const answers = (request: { method: string; path: string; body?: unknown; query?: Record<string, string> }) => {
  if (request.method === 'GET' && request.path === '/v1/projects') return json(registered);
  if (request.method === 'GET' && request.path === '/v1/projects/folders') {
    const path = request.query?.path ?? HOME;
    return json({
      path,
      crumbs: [{ name: '~', path: HOME }],
      entries: path === HOME ? [folder('atlas'), folder('harbour')] : [],
      truncated: false,
    });
  }
  if (request.method === 'POST' && request.path === '/v1/projects') {
    const body = request.body as { path: string };
    const name = body.path.split('/').at(-1) ?? 'project';
    const made = {
      id: `${String(registered.length + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
      name,
      path: body.path,
      source: 'existing-folder',
      createdAt: at,
    };
    registered.push(made);
    return json(made);
  }
  return undefined;
};
const transport = new FakeTransport(request => {
  if (request.path === '/v1/plugins') return json(inventoryOf(surfaces, {}));
  const own = answers(request as never);
  if (own !== undefined) {
    fake.requests.push(`${request.method} ${request.path}`);
    if (request.method !== 'GET')
      fake.mutations.push({ route: `${request.method} ${request.path}`, body: request.body });
    save();
    return own;
  }
  const answered = fake.answer(request, extraRoutes(fake));
  save();
  return answered;
});

(window as unknown as { __fake: unknown }).__fake = {
  machine: MACHINE.id,
  states: () => Object.fromEntries(fake.states),
  mutations: () => fake.mutations,
  registered: () => registered,
  ledger: () => window.localStorage.getItem('fy:onboarding:client'),
  later: () => window.localStorage.getItem('fy:onboarding:later'),
};

// The paired list is the browser's own storage, seeded ONCE: a later page of this browser reads it back, as a relaunch does.
const list = new DaemonList({ storage: window.localStorage, now: () => Date.now() });
if (list.snapshot().daemons.length === 0)
  list.add({
    daemon: MACHINE.id,
    machine: MACHINE.name,
    deviceId: `fy_device_id_${MACHINE.id.slice(-22)}`,
    address: MACHINE.address,
  });
const crypto = new WebCryptoRelayCrypto();
const daemonlessPorts: DaemonlessPorts = {
  crypto,
  subtle: window.crypto.subtle,
  indexedDB: window.indexedDB,
  now: () => Date.now(),
  after: (delayMs, run) => void window.setTimeout(run, delayMs),
  daemons: list,
  pairDirect: async () => Promise.reject(new Error('this scene pairs nothing')),
  pair: async () => Promise.reject(new Error('this scene pairs nothing')),
  hostedRelay: async () => ({ kind: 'undetermined', reason: 'this scene reads no relay directory' }),
};
const passkey = registeredPasskey(surfaces, {
  clientOf: (daemon, plugin) => runtime.client(daemon, plugin),
  daemons: list,
  origin: window.location.origin,
  credentials: {
    create: async () => Promise.reject(new DOMException('no passkey here', 'NotAllowedError')),
    get: async () => Promise.reject(new DOMException('no passkey here', 'NotAllowedError')),
  },
});
const runtime: ShellRuntime = new ShellRuntime({
  appVersion: generated.appVersion,
  surfaces,
  daemons: list,
  connect: async () => transport,
  passkey: () => passkey.passkey,
  daemonless: { views: registeredDaemonless(surfaces, daemonlessPorts).views, location: () => window.location.href },
  address: window,
});
const storage = memoryStore();

const root = document.getElementById('root');
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
