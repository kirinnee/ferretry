/**
 * The browser entry for "a ferret with a pending ask shows it": the REAL `App` over ONE FAKE machine whose plugins are the
 * REAL generated surfaces — the real Conversation page and composer, the real Agenda line above the composer, the real side
 * toggle — answered by a fake transport. No daemon, no network. Everything on screen is fake data.
 *
 *   /d/ws/ferrets/zoe/chat      the ferret's chat
 *   ?agenda=on|off              whether the ferret works in agenda mode (the line above the composer draws only when on)
 *   ?asks=<n>                   how many open asks wait on the owner (default 1)
 *   ?theme=<family>-<mode>
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
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { FakeTransport, inventoryOf, json } from '../../unit/client/fixtures.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const agendaOn = params.get('agenda') !== 'off';
const asks = Number(params.get('asks') ?? '1');

const AT = '2026-11-18T09:00:00.000Z';
const surfaces = generated.surfaces;

const summary = {
  id: 'zoe',
  name: 'zoe',
  role: 'lead',
  harness: 'claude-code',
  runner: 'tmux',
  folder: '/work/project',
  state: 'idle',
  createdAt: AT,
  stateAt: AT,
  title: 'Fixture running',
};

const item = (n: number) => ({
  id: `A${n}`,
  source: 'agent-raised',
  sourceRef: null,
  sourceSeq: n,
  subject: n === 1 ? 'Which fix should I apply?' : `Fake ask number ${n}`,
  why: 'Two fixes would work; the owner picks.',
  waitingSince: '2026-11-18T08:30:00.000Z',
  howToResolve: 'Pick one.',
  raisedBy: 'agent',
  raisedBySession: 'zoe',
  raisedByName: 'zoe',
  kind: 'choice',
  ask: { kind: 'multiple-choice', options: [{ label: 'Patch it' }, { label: 'Rewrite it' }] },
});

const board = {
  v: 1,
  sessionId: 'zoe',
  items: Array.from({ length: asks }, (_, i) => item(i + 1)),
  resolved: [],
  count: asks,
  parseErrors: 0,
  updatedAt: AT,
};

const grants = {
  capabilities: ['fleet', 'terminal', 'browser', 'filesystem', 'warden', 'pairing', 'secrets'].map(capability => ({
    capability,
    use: true,
    configure: true,
    granted: { use: true, configure: true },
    useRefusal: 'granted',
    configureRefusal: 'granted',
    mayGrant: false,
    origin: 'default',
  })),
  governed: true,
  hostLocal: false,
  steppedUp: false,
};

(window as unknown as { __unanswered: string[] }).__unanswered = [];
const transport = new FakeTransport((request: TransportRequest): TransportAnswer => {
  const path = request.path.split('?')[0] ?? request.path;
  if (path === '/v1/plugins') return json(inventoryOf(surfaces));
  if (path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
  if (path === '/v1/grants') return json(grants);
  if (path === '/v1/ferrets/zoe') return json(summary);
  if (path === '/v1/ferrets') return json([summary]);
  if (path === '/v1/ferrets/zoe/agenda-mode')
    return json({
      enabled: agendaOn,
      restartRequired: false,
      note: 'Agenda mode applies from the ferret’s next launch.',
    });
  if (path === '/v1/ferrets/zoe/agenda') return json(board);
  if (path === '/v1/agenda/open') return json({ sessions: [{ sessionId: 'zoe', items: board.items }] });
  if (path === '/v1/ferrets/zoe/log-page')
    return json({ v: 1, ferret: 'zoe', log: '', start: 0, file: 'zoe.jsonl', offsets: [] });
  (window as unknown as { __unanswered: string[] }).__unanswered.push(`${request.method} ${path}`);
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
