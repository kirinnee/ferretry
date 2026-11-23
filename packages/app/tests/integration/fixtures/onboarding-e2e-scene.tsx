/**
 * The browser entry for the r10-1 onboarding gate: the REAL `App` over the REAL generated surfaces (every shipped plugin's app
 * half and stylesheet), an EMPTY paired list (a first visit), and TWO fake machines that pair by a fixed fake code. No daemon,
 * no network. `window.__fake` is the test's window onto each machine's side of every answer.
 *
 *   /            a first visit: the shell sends a device with no daemon to the first run
 *   ?theme=<family>-<mode>
 *   ?paused=<plugin>   the machines report that plugin as off and list none of its steps, as a daemon with it switched off does
 *
 * Pairing is REAL up to the wire: Access's pairing page reads the link, mints its device key in the browser, and asks the
 * (fake) `pairDirect`; the fake saves the key as the shell does after a sealed `paired` answer, and the machine is added.
 */
import { createRoot } from 'react-dom/client';
import '../../../src/styles/index.css';
import '../../../src/ui/design-system.css';
import type { PairDirectInput } from '../../../src/connect/provides.ts';
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
import { FAKE_CODE, FakeDaemon, type FakeStep, MACHINES } from './onboarding-e2e-daemon.ts';
import { extraRoutes } from './onboarding-e2e-routes.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
// r11-1b G6: ?latency=N makes every machine read and write answer N ms late (the machines answer at once by default).
const latencyMs = Number(params.get('latency') ?? 0);
const surfaces = generated.surfaces;
const paused = params.get('paused');
const overrides = paused === null ? {} : { [paused]: { on: false } };

// ?projects=1: the machines also carry Projects' two device pages (the full journey's walk leaves them out).
const PROJECT_STEPS: readonly FakeStep[] =
  params.get('projects') === '1'
    ? [
        { plugin: 'projects', id: 'folders', title: 'Add your projects', order: 90, side: 'client', group: 'Projects' },
        { plugin: 'projects', id: 'github', title: 'Connect GitHub', order: 91, side: 'client', group: 'Projects' },
      ]
    : [];
// A paused plugin offers the machine no steps (a switched-off plugin's steps are not listed).
const daemons = new Map<string, FakeDaemon>(
  MACHINES.map(machine => [
    machine.id,
    new FakeDaemon({
      ...machine,
      steps: [...machine.steps, ...PROJECT_STEPS].filter(step => step.plugin !== paused),
    }),
  ]),
);
const transports = new Map<string, FakeTransport>();
const transportOf = (id: string): FakeTransport => {
  const known = transports.get(id);
  if (known !== undefined) return known;
  const fake = daemons.get(id);
  if (fake === undefined) throw new Error(`no fake machine ${id}`);
  const made = new FakeTransport(request => {
    if (request.path === '/v1/plugins') return json(inventoryOf(surfaces, overrides));
    if (latencyMs <= 0) return fake.answer(request, extraRoutes(fake));
    return new Promise(resolve => window.setTimeout(() => resolve(fake.answer(request, extraRoutes(fake))), latencyMs));
  });
  fake.accounts.onChange = (loginId, change) =>
    window.setTimeout(() => made.emit({ name: 'logins.changed', payload: { loginId, change } }), 0);
  transports.set(id, made);
  return made;
};

(window as unknown as { __fake: unknown }).__fake = {
  daemon: (id: string) => {
    const fake = daemons.get(id);
    return fake === undefined
      ? undefined
      : {
          answers: fake.answers,
          states: Object.fromEntries(fake.states),
          requests: fake.requests,
          unanswered: fake.unanswered,
          named: fake.named,
          writes: fake.writes,
          mutations: fake.mutations,
          runtimesMade: fake.accounts.made,
        };
  },
  ledger: () => window.localStorage.getItem('fy:onboarding:client'),
  code: FAKE_CODE,
};

const list = new DaemonList({ storage: memoryStore(), now: () => Date.now() });
const crypto = new WebCryptoRelayCrypto();

/** What the shell does on a sealed `paired` answer: the machine the QR pinned answers, and Access keeps the key. */
const pairDirect = async (input: PairDirectInput) => {
  if (input.code.replaceAll('-', '') !== FAKE_CODE.replaceAll('-', ''))
    throw new Error('the fake machine refuses this code');
  const machine = MACHINES.find(candidate => candidate.id === input.daemonId);
  if (machine === undefined) throw new Error('no fake machine answers at this fingerprint');
  const response = {
    deviceId: `fy_device_id_${machine.id.slice(-22)}`,
    idleExpiryDays: 30,
    daemonId: machine.id,
    daemonName: machine.name,
    capabilities: ['daemon-api'],
    carriers: [{ kind: 'direct', url: machine.address }],
  };
  await input.key.save(response as never);
  return { kind: 'paired' as const, response: response as never };
};

const daemonlessPorts: DaemonlessPorts = {
  crypto,
  subtle: window.crypto.subtle,
  indexedDB: window.indexedDB,
  now: () => Date.now(),
  after: (delayMs, run) => void window.setTimeout(run, delayMs),
  daemons: list,
  pairDirect,
  pair: async input => ({ ...(await pairDirect(input)), via: { kind: 'direct', address: input.address } }),
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
  connect: async daemon => transportOf(daemon.daemon),
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
