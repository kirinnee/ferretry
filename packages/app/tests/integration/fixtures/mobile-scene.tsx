/**
 * The browser entry for "every page at a phone's width" (U-M): the REAL `App` over the REAL generated surfaces (every
 * shipped plugin's own app half, its own stylesheet) and ONE FAKE machine whose daemon answers from `mobile-fake-daemon.ts`.
 * No daemon, no network. Everything on screen is fake data.
 *
 *   /d/ws/ferrets/zoe       a ferret's page     /d/ws/agenda   /d/ws/board   /d/ws/projects   /d/ws/insights
 *   /d/ws/settings[/<plugin>/<tab>]            /settings (this device)      /pair (the pairing page)
 *   ?theme=<family>-<mode>
 *
 * `window.__fakeRequests` lists every path the page asked for that the fake daemon has no answer for (a probe aid).
 */
import { createRoot } from 'react-dom/client';
import '../../../src/styles/index.css';
import '../../../src/ui/design-system.css';
import type { TransportAnswer, TransportRequest } from '../../../src/client/transport.ts';
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
import { answerFor } from './mobile-fake-daemon.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const surfaces = generated.surfaces;

const unanswered: string[] = [];
(window as unknown as { __fakeRequests: string[] }).__fakeRequests = unanswered;

const transport = new FakeTransport((request: TransportRequest): TransportAnswer => {
  if (request.path === '/v1/plugins') return json(inventoryOf(surfaces));
  // `?unlock=1`: the machine asks for a passkey on opening, so the app's real unlock prompt is on screen.
  if (params.get('unlock') === '1' && request.path !== '/v1/health' && !request.path.startsWith('/v1/access'))
    return json({ code: 'unlock_required', error: 'this machine asks for a passkey' }, 401);
  // `?question=1`: the ferret is waiting on a question, so the folded question line and its form are on screen.
  if (params.get('question') === '1' && /^\/v1\/ferrets\/[^/]+\/question$/u.test(request.path))
    return json({
      question: {
        format: 1,
        toolUseId: 'toolu_scene',
        header: 'Fix',
        text: 'Which fix should I apply to the redirect loop?',
        options: [
          { label: 'Patch the guard', description: 'Smallest change; keeps the old behaviour' },
          { label: 'Rewrite the reader', description: 'Cleaner, but touches more files' },
          { label: 'Leave it' },
        ],
        multiple: false,
        askedAt: new Date(Date.UTC(2026, 10, 17, 19, 55)).toISOString(),
      },
    });
  const answer = answerFor(request);
  // `?model=<id>&effort=<word>&fast=1` re-words the ferret's model readout, so a phone can be shown the longest one.
  if (answer !== undefined && /^\/v1\/ferrets\/[^/]+$/u.test(request.path) && typeof answer.body === 'object') {
    const model = params.get('model');
    const effort = params.get('effort');
    return {
      ...answer,
      body: {
        ...(answer.body as object),
        ...(model === null ? {} : { model }),
        ...(effort === null ? {} : { effort }),
        ...(params.get('fast') === '1' ? { fast: true } : {}),
      },
    };
  }
  if (answer !== undefined) return answer;
  unanswered.push(`${request.method} ${request.path}`);
  // A route this scene has no answer for is a plain refusal, which every page already draws as "nothing here".
  return json({ code: 'not_found', error: 'the fake machine has no answer' }, 404);
});
const list = new DaemonList({ storage: memoryStore(), now: () => 1 });
list.add({ daemon: 'ws', machine: 'workshop-host', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
const crypto = new WebCryptoRelayCrypto();
const unreachable = async (): Promise<never> => {
  throw new Error('this scene pairs with nothing');
};
const daemonlessPorts: DaemonlessPorts = {
  crypto,
  subtle: window.crypto.subtle,
  indexedDB: window.indexedDB,
  now: () => Date.now(),
  after: (delayMs, run) => void window.setTimeout(run, delayMs),
  daemons: list,
  pairDirect: unreachable,
  pair: unreachable,
  hostedRelay: async () => ({ kind: 'undetermined', reason: 'this scene reads no relay directory' }),
};
// The REAL passkey prompt (Access's), over a browser that has no passkey for this machine.
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
