/**
 * The browser entry for "the frame lays the ferret page and the agenda out": the REAL `App` (router, frame, layout engine,
 * default layout, stylesheet) over ONE FAKE machine that answers an inventory and grants — no daemon, no network.
 *
 *   /d/ws/agenda            a stand-in agenda page in the main column, the ferret list in the side column as the
 *                           default layout holds it, and the status line a background view draws in flow
 *   /d/ws/ferrets/zoe       a ferret page: a stand-in for Conversation's chat beside `<PanelSlot slot="ferret.side">` —
 *                           the REAL slot, drawing the panels the DEFAULT layout lists, each a stand-in carrying the id
 *                           and plugin a real manifest declares
 *   ?theme=<family>-<mode>
 *
 * Only what a plugin draws is a stand-in (an app test reaches another package only through its contract); the frame, the
 * slot, the default layout and the stylesheet are the ones that ship. Everything on screen is fake data.
 */

import { type Manifest, implementApp } from '@ferretry/kernel/manifest';
import { DEFAULT_LAYOUT } from '@ferretry/plugin-layouts/contract';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { TransportAnswer, TransportRequest } from '../../../src/client/transport.ts';
import { type DaemonlessPorts, provideToShell, registeredDaemonless } from '../../../src/connect/provides.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import type { PasskeyHandler, PasskeyProvision } from '../../../src/passkey/passkey.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { PanelSlot } from '../../../src/shell/views.tsx';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../../unit/client/fixtures.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const manifestOf = (id: string, extra: Record<string, unknown> = {}): Manifest =>
  ({ id, title: id, version: '5.0.0', api: 5, core: false, kinds: ['view'], ...extra }) as unknown as Manifest;

const entryOf = (manifest: Manifest, app: SurfaceEntry['app'], core = false): SurfaceEntry => ({
  id: manifest.id,
  title: manifest.title,
  core,
  contract: `h-${manifest.id}`,
  consumes: [],
  manifest,
  ...(app === undefined ? {} : { app }),
});

// ─── a stand-in for the agenda page: the column the real page fills, with the width rules it has ─────────────────────────
// (the real page and its ⋯ menu are drawn by the Agenda plugin's own visual test, `inbox-item-menu.visual.test.ts`; an app
// test reaches another package only through its contract, so this scene holds what the FRAME decides: the column's width.)

function AgendaScreen(): ReactNode {
  return (
    <div
      className="fy-attn-inbox"
      data-agenda-stand-in=""
      style={{ height: '100%', boxSizing: 'border-box', padding: '16px max(16px, calc((100% - 56rem) / 2)) 16px' }}
    >
      <h2 style={{ margin: 0 }}>Inbox 2</h2>
      <section data-agenda-item="" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
        <strong>Which fix should I apply?</strong>
        <p>Fake item: the page column is as wide as the frame leaves it.</p>
      </section>
    </div>
  );
}

// What Connections' relay-fallback watcher draws while the direct address stands in for the relay: a status line, IN FLOW
// (`connections/app/features/carrier/relay-fallback-notice.tsx`: the same markup, hosted by a stub plugin).
const RELAY_FALLBACK_LINE = 'Couldn’t reach it through the relay, using the direct connection.';

// ─── stand-ins: the ferret list (the side column), the chat beside the side pane, the side panels ─────────────────────

const FERRETS = [
  ['Fixture running', 'zoe'],
  ['Release train', 'kai'],
  ['Docs sweep', 'hadi'],
  ['Ledger rewrite', 'piper'],
];

function FerretListScreen(): ReactNode {
  return (
    <div className="fy-sbar__ferrets" data-ferret-list="">
      <div className="fy-sbar__filters">
        <strong>Interactive 2</strong> · All 4 · Agents 2
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {FERRETS.map(([title, callsign]) => (
          <li key={callsign} style={{ padding: '8px 0' }}>
            <a href={`/d/ws/ferrets/${callsign}`}>{title}</a>
            <div style={{ opacity: 0.6, fontSize: 12 }}>{callsign} · fake ferret</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What Conversation's chat page draws: the log beside the `ferret.side` slot, in the same flex row. */
function FerretPageScreen(): ReactNode {
  return (
    <main className="flex h-full min-h-0 min-w-0 flex-col overflow-clip" data-session="zoe">
      <header style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>Fixture running · zoe</header>
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-chat="" style={{ padding: 16 }}>
          <p>Fake conversation: the chat log would be here.</p>
          <p>It keeps what is left of the row once the side pane has its column.</p>
        </div>
        <PanelSlot daemon="ws" slot="ferret.side" subject="zoe" />
      </div>
    </main>
  );
}

/** The plugin each side panel really belongs to (from the manifests), so the stand-in's `data-panel` reads true. */
const OWNER: Readonly<Record<string, string>> = {
  'ferret-agenda': 'agenda',
  queue: 'conversation',
  'cards-of-ferret': 'board',
  terminals: 'terminals',
  console: 'terminals',
  processes: 'terminals',
  browser: 'browsers',
  files: 'ferrets',
  'ferret-warden': 'warden',
  'mcp-servers': 'mcp',
  helpers: 'packs',
  skills: 'skills',
  usage: 'usage',
  insights: 'usage',
};
const SIDE = DEFAULT_LAYOUT.panels['ferret.side'] ?? [];
const panelStand = (id: string) =>
  function SidePanel(): ReactNode {
    return (
      <section data-side-panel={id} style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 6 }}>
        <h3 style={{ margin: 0, fontSize: 13 }}>{id}</h3>
        <p style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.7 }}>Fake {OWNER[id] ?? 'plugin'} panel.</p>
      </section>
    );
  };

const stub = (id: string, screens: { id: string; path: string; label: string; order: number }[]) =>
  manifestOf(id, {
    ui: { screens: screens.map(s => ({ id: s.id, path: s.path, nav: { label: s.label, order: s.order } })) },
  });

const ferretsManifest = manifestOf('ferrets', {
  core: true,
  ui: {
    screens: [
      { id: 'ferrets', path: 'ferrets', nav: { label: 'Ferrets', order: 5 } },
      { id: 'ferret', path: 'ferrets/:ferret' },
    ],
  },
});
const agendaManifest = stub('agenda', [{ id: 'agenda', path: 'agenda', label: 'Agenda', order: 1 }]);
const boardManifest = stub('board', [{ id: 'board', path: 'board', label: 'Board', order: 2 }]);
const usageManifest = manifestOf('usage', {
  ui: {
    screens: [{ id: 'insights', path: 'insights', nav: { label: 'Insights', order: 3 } }],
    panels: [],
  },
});
const panelsManifest = manifestOf('stubs', {
  ui: { panels: SIDE.map((id, order) => ({ id, slot: 'ferret.side', order })) },
});

// A background view drawing a status line in flow, hosted by a stub plugin (a background view the frame mounts once per paired machine), over a router that
// says the relay is down: the line the sweep saw at the top right of the real app.
const connectionsManifest = manifestOf('relaynote', {
  actions: { routes: [{ key: 'POST /v1/relaynote/ping', minimum: 'authenticated', caller: 'any', audit: 'skip' }] },
  ui: { screens: [{ id: 'note', path: 'note' }] },
});
function RelayFallbackWatcher(): ReactNode {
  return (
    <p role="status" className="fy-shell-line fy-shell-line--warn" data-relay-fallback="">
      {RELAY_FALLBACK_LINE}
    </p>
  );
}

const page = (text: string) => () => <p style={{ padding: 16 }}>{text}</p>;
const surfaces: readonly SurfaceEntry[] = [
  ...CORE.filter(entry => entry.id !== 'ferrets'),
  entryOf(
    ferretsManifest,
    provideToShell(
      implementApp(ferretsManifest, {
        build: () => ({ screens: { ferrets: FerretListScreen, ferret: FerretPageScreen } }),
      } as never),
      {},
    ),
    true,
  ),
  entryOf(
    agendaManifest,
    provideToShell(implementApp(agendaManifest, { build: () => ({ screens: { agenda: AgendaScreen } }) } as never), {}),
  ),
  entryOf(
    boardManifest,
    provideToShell(implementApp(boardManifest, { build: () => ({ screens: { board: page('Board') } }) } as never), {}),
  ),
  entryOf(
    usageManifest,
    provideToShell(
      implementApp(usageManifest, { build: () => ({ screens: { insights: page('Insights') } }) } as never),
      {},
    ),
  ),
  entryOf(
    connectionsManifest,
    provideToShell(implementApp(connectionsManifest, { build: () => ({}) } as never), {
      background: { 'relay-fallback': RelayFallbackWatcher },
    }),
  ),
  entryOf(
    panelsManifest,
    provideToShell(
      implementApp(panelsManifest, {
        build: () => ({ panels: Object.fromEntries(SIDE.map(id => [id, panelStand(id)])) }),
      } as never),
      {},
    ),
  ),
];

// ─── one paired fake machine ─────────────────────────────────────────────────────────────────────────────────────────

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
