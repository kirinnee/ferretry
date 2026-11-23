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

import { type Manifest, type PanelProps, implementApp } from '@ferretry/kernel/manifest';
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
import { FerretWorkspace } from '../../../src/shell/ferret-workspace.tsx';
import { PanelSlot } from '../../../src/shell/views.tsx';
import { useFerretWorkspace } from '../../../src/shell/ferret-workspace-actions.tsx';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../../unit/client/fixtures.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
// `?tall=1` makes the page's own content far taller than the window, as a long inbox or conversation is.
const TALL = params.get('tall') === '1';
// `?header=modes` draws the ferret header as the real chat page does: the name and the status on one line and ONE "Modes" button at its end
// (the chips and switches live behind it), so the chrome above the first chat line can be measured as a person sees it.
const HOST_STATE = params.get('host') === 'unnamed' ? 'unnamed' : params.get('host') === 'named' ? 'named' : null;
const MODES_HEADER = params.get('header') === 'modes';
const tallBlock = (what: string): ReactNode =>
  TALL ? <div data-tall-filler="" style={{ height: 3_000, flexShrink: 0 }}>{`Fake ${what}: a tall page.`}</div> : null;

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
      {tallBlock('inbox')}
    </div>
  );
}

// What Connections' relay-fallback watcher draws while the direct address stands in for the relay: a status line, IN FLOW
// (`connections/app/features/carrier/relay-fallback-notice.tsx`: the same markup, hosted by a stub plugin).
const RELAY_FALLBACK_LINE = 'Couldn’t reach it through the relay, using the direct connection.';

// A stand-in for Ferrets' New ferret page (`/d/ws/new`): a form about the size of the real one, so a loader drawn over it shows.
function NewFerretStand(): ReactNode {
  return (
    <form
      aria-label="New ferret"
      data-new-ferret=""
      style={{ display: 'grid', gap: 14, maxWidth: 720, margin: '0 auto', padding: 16 }}
    >
      <h1 style={{ margin: 0, fontSize: 22 }}>New ferret</h1>
      {['Runtime', 'Where it works', 'Model', 'Label'].map(label => (
        <label key={label} style={{ display: 'grid', gap: 4, fontWeight: 600 }}>
          {label}
          <input placeholder={`Fake ${label.toLowerCase()}`} style={{ font: 'inherit', padding: 8 }} />
        </label>
      ))}
      <label style={{ display: 'grid', gap: 4, fontWeight: 600 }}>
        Opening prompt
        <textarea
          placeholder="Describe what you want the agent to do…"
          rows={6}
          style={{ font: 'inherit', padding: 8 }}
        />
      </label>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="kt-btn" type="button">
          Cancel
        </button>
        <button className="kt-btn" data-variant="primary" type="button">
          Create ferret
        </button>
      </div>
    </form>
  );
}

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
      {/* Ferrets' own header row (`ferret-list.tsx`): the Mine / All / Agents segments with their counts, the ⋯ options button beside them. */}
      <div className="fy-sbar__filters" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 0 8px' }}>
        <fieldset
          aria-label="Show ferrets"
          style={{
            display: 'flex',
            flex: 1,
            gap: 2,
            margin: 0,
            padding: 2,
            border: '1px solid var(--border)',
            borderRadius: 8,
          }}
        >
          {(
            [
              ['mine', 'Mine', 2],
              ['all', 'All', 4],
              ['agents', 'Agents', 2],
            ] as const
          ).map(([mode, label, count]) => (
            <button
              aria-pressed={mode === 'mine'}
              data-sbar-filter={mode}
              key={mode}
              type="button"
              style={{
                flex: 1,
                border: 0,
                borderRadius: 6,
                padding: '4px 6px',
                font: 'inherit',
                fontSize: 12,
                color: 'var(--fg)',
                background: mode === 'mine' ? 'var(--select-fill)' : 'transparent',
              }}
            >
              {label} <span style={{ opacity: 0.6 }}>{count}</span>
            </button>
          ))}
        </fieldset>
        <button
          aria-label="List options"
          type="button"
          style={{
            border: 0,
            background: 'transparent',
            color: 'var(--muted)',
            fontSize: 18,
            lineHeight: 1,
            padding: '2px 6px',
          }}
        >
          ⋯
        </button>
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

/** What Conversation's chat page draws: the log and the `ferret.side` slot, as the REAL `FerretWorkspace` lays them out (beside each other wide, one at a time behind chips on a phone). */
function FerretPageScreen(): ReactNode {
  return (
    <main className="flex h-full min-h-0 min-w-0 flex-col overflow-clip" data-session="zoe">
      {MODES_HEADER ? (
        <div className="flex min-w-0 items-center" data-ferret-header="">
          <div className="min-w-0 flex-1">
            <PanelSlot daemon="ws" slot="ferret.toolbar" subject="zoe" />
          </div>
          <div
            className="fy-modes"
            data-modes-menu=""
            style={{ display: 'flex', alignItems: 'center', paddingRight: 12 }}
          >
            <button className="kt-btn kt-btn--sm" data-modes-trigger="" type="button">
              Modes
            </button>
          </div>
        </div>
      ) : (
        <PanelSlot daemon="ws" slot="ferret.toolbar" subject="zoe" />
      )}
      <FerretWorkspace
        chat={
          <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-chat="">
            <div data-transcript="" style={{ flex: '1 1 0', minHeight: 0, padding: 16, overflowY: 'auto' }}>
              <p>Fake conversation: the chat log would be here.</p>
              <p>It keeps what is left of the row once the side pane has its column.</p>
              {tallBlock('conversation')}
            </div>
            {/* The composer is the real one's size: a text box, a model chip and the send button, about 170px. */}
            <div data-composer="" style={{ flex: '0 0 170px', padding: 16, borderTop: '1px solid var(--border)' }}>
              Fake composer
            </div>
          </div>
        }
        daemon="ws"
        subject="zoe"
      />
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
  instructions: 'ferrets',
  'ferret-warden': 'warden',
  'mcp-servers': 'mcp',
  helpers: 'packs',
  skills: 'skills',
  usage: 'usage',
  insights: 'usage',
};
const SIDE = DEFAULT_LAYOUT.panels['ferret.side'] ?? [];

/**
 * The ferret's toolbar as the real plugins draw it (the ids and order are the manifests'): the name, the status, the
 * Hypermedia and Compact-memory chips, Info, Actions, and the Agenda-mode and Lessons switches with Lessons' full-width scan
 * bar. Only the shapes matter here (a heading, small buttons, a switch row, one bar); the words are the real ones.
 */
const chip = (label: string, value?: string) => () => (
  <button className="kt-btn" type="button">
    {label}
    {value === undefined ? null : <span style={{ marginLeft: 6, opacity: 0.7 }}>{value}</span>}
  </button>
);
const toggle = (label: string) => () => (
  <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}>
    <input defaultChecked type="checkbox" />
    {label} <span style={{ opacity: 0.7 }}>On</span>
  </label>
);
// The real name and status panels' markup and metrics (`core/ferrets` header/name-panel.tsx, status-panel.tsx and their stylesheet) for the
// `?header=modes` header. The sizes are written inline: a scene reaches another package only through its contract, never its stylesheet.
const REAL_TOOLBAR: ReadonlyArray<readonly [string, () => ReactNode]> = [
  [
    'name',
    () => (
      <div
        className="fy-ferret-name"
        data-ferret-name=""
        style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0, flex: 1 }}
      >
        <h1 style={{ margin: 0, minWidth: 0, fontSize: 'var(--text-lg)', whiteSpace: 'nowrap' }}>Fixture running</h1>
        <span style={{ flexShrink: 0, color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>zoe</span>
      </div>
    ),
  ],
  [
    'status',
    () => (
      <span
        className="fy-ferret-status"
        data-ferret-status="idle"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          color: 'var(--muted)',
          fontSize: 'var(--text-sm)',
          whiteSpace: 'nowrap',
        }}
      >
        <span>Your turn</span>
      </span>
    ),
  ],
];
const LEGACY_TOOLBAR: ReadonlyArray<readonly [string, () => ReactNode]> = [
  ['name', () => <strong>Fixture running</strong>],
  ['status', () => <span>Your turn</span>],
  ['hypermedia', chip('Hypermedia', 'Off')],
  ['compact-at', chip('Compact memory at…', 'Default')],
  ['info', chip('Info')],
  ['actions', chip('Actions')],
  ['ferret-agenda-mode', toggle('Agenda mode')],
  [
    'ferret-lessons',
    () => (
      <div
        className="flex min-w-0 flex-col gap-2 max-md:flex-row max-md:items-center max-md:gap-3"
        data-ferret-lessons=""
      >
        {toggle('Passive lessons')()}
        <button className="kt-btn" type="button">
          Scan this ferret for lessons…
        </button>
      </div>
    ),
  ],
];
const TOOLBAR = MODES_HEADER ? REAL_TOOLBAR : LEGACY_TOOLBAR;
const panelStand = (id: string) =>
  function SidePanel({ intent, subject }: PanelProps): ReactNode {
    // Ferrets' Instructions list opens a file in Files and brings Files on screen through the ferret's workspace.
    const workspace = useFerretWorkspace();
    return (
      <section
        data-intent={intent === undefined ? undefined : `${intent.action}#${String(intent.id)}`}
        data-side-panel={id}
        style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 6 }}
      >
        <h3 style={{ margin: 0, fontSize: 13 }}>{id}</h3>
        <p style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.7 }}>Fake {OWNER[id] ?? 'plugin'} panel.</p>
        {/* A panel with a row that is wider than the pane (the Terminals panel's toolbar was): it must not give the whole pane a sideways scroll. */}
        {id === 'terminals' ? (
          <pre style={{ margin: '4px 0 0', minWidth: 520 }}>
            session cwd · terminals unavailable · a row wider than the pane
          </pre>
        ) : null}
        {id === 'instructions' ? (
          <button
            data-open-in-files=""
            onClick={() => {
              if (workspace !== null && workspace.ferret === subject) workspace.showPanel('files');
            }}
            type="button"
          >
            AGENTS.md
          </button>
        ) : null}
      </section>
    );
  };

const stub = (id: string, screens: { id: string; path: string; label: string; order: number; icon: string }[]) =>
  manifestOf(id, {
    ui: {
      screens: screens.map(s => ({ id: s.id, path: s.path, nav: { label: s.label, icon: s.icon, order: s.order } })),
      // One settings tab each, so `?work=off` has Agenda's and Board's to leave out of the Settings list.
      settings: [{ id: id, label: `${id[0]?.toUpperCase()}${id.slice(1)}`, order: 20, group: 'behaviour' }],
    },
  });

const ferretsManifest = manifestOf('ferrets', {
  core: true,
  ui: {
    screens: [
      { id: 'ferrets', path: 'ferrets', nav: { label: 'Ferrets', icon: 'list', order: 5 } },
      { id: 'ferret', path: 'ferrets/:ferret' },
      { id: 'new-ferret', path: 'new' },
    ],
  },
});
const agendaManifest = stub('agenda', [{ id: 'agenda', path: 'agenda', label: 'Agenda', icon: 'inbox', order: 1 }]);
const boardManifest = stub('board', [
  { id: 'board', path: 'board/:project?', label: 'Board', icon: 'columns', order: 2 },
]);
const projectsManifest = stub('projects', [
  { id: 'projects', path: 'projects', label: 'Projects', icon: 'folder', order: 35 },
]);
const usageManifest = manifestOf('usage', {
  ui: {
    screens: [{ id: 'insights', path: 'insights', nav: { label: 'Insights', icon: 'chart', order: 3 } }],
    panels: [],
  },
});
const COMPOSER_TOOLS = DEFAULT_LAYOUT['composer.tools'] ?? [];
const panelsManifest = manifestOf('stubs', {
  ui: {
    panels: [
      ...SIDE.map((id, order) => ({ id, slot: 'ferret.side', order })),
      ...TOOLBAR.map(([id], order) => ({ id, slot: 'ferret.toolbar', order })),
      // The composer's tools the default layout lists: a device layout laid over the default is checked against these.
      ...COMPOSER_TOOLS.map((id, order) => ({ id, slot: 'composer.tools', order })),
    ],
  },
});

// A background view drawing a status line in flow, hosted by a stub plugin (a background view the frame mounts once per paired machine), over a router that
// says the relay is down: the line the sweep saw at the top right of the real app.
const connectionsManifest = manifestOf('relaynote', {
  actions: { routes: [{ key: 'POST /v1/relaynote/ping', minimum: 'authenticated', caller: 'any', audit: 'skip' }] },
  ui: { screens: [{ id: 'note', path: 'note' }] },
});
function RelayFallbackWatcher(): ReactNode {
  // `?relay=0`: the shell shots compare pages, not the status strip, so they leave the line out.
  if (params.get('relay') === '0') return null;
  return (
    <p role="status" className="fy-shell-line fy-shell-line--warn" data-relay-fallback="">
      {RELAY_FALLBACK_LINE}
    </p>
  );
}

const page = (text: string) => () => <p style={{ padding: 16 }}>{text}</p>;
const surfaces: readonly SurfaceEntry[] = [
  ...CORE.filter(entry => entry.id !== 'ferrets' && entry.id !== 'kernel'),
  // The kernel declares the one route the machine switcher reads (`host.yaml`, to know whether the machine goes by its host name).
  entryOf(
    manifestOf('kernel', {
      core: true,
      actions: { routes: [{ key: 'GET /v1/config/file', minimum: 'authenticated', caller: 'any', audit: 'skip' }] },
    }),
    undefined,
    true,
  ),
  entryOf(
    ferretsManifest,
    provideToShell(
      implementApp(ferretsManifest, {
        build: () => ({
          screens: { ferrets: FerretListScreen, ferret: FerretPageScreen, 'new-ferret': NewFerretStand },
        }),
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
    projectsManifest,
    provideToShell(
      implementApp(projectsManifest, { build: () => ({ screens: { projects: page('Projects') } }) } as never),
      {},
    ),
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
        build: () => ({
          panels: {
            ...Object.fromEntries(SIDE.map(id => [id, panelStand(id)])),
            ...Object.fromEntries(TOOLBAR.map(([id, stand]) => [id, stand])),
            ...Object.fromEntries(COMPOSER_TOOLS.map(id => [id, () => null])),
          },
        }),
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
// `?work=off`: the daemon's work switch is off, so its inventory says Board and Agenda are `off`. `?work=split` pairs a
// SECOND machine (`ws2`) that has the switch ON while `ws` has it off: each machine's own nav answers for itself.
const WORK = params.get('work');
const workIsOff = (machine: string): boolean => WORK === 'off' || (WORK === 'split' && machine === 'ws');
// `?slow=<ms>`: the daemon answers its plugin list that many ms late (a slow machine), so the shell's waiting state shows.
const SLOW = Number(params.get('slow') ?? '0');
const transportOf = (machine: string) =>
  new FakeTransport((request: TransportRequest): Promise<TransportAnswer> | TransportAnswer => {
    if (request.path === '/v1/plugins' && SLOW > 0) {
      const answer = json(
        inventoryOf(surfaces, workIsOff(machine) ? { agenda: { on: false }, board: { on: false } } : {}),
      );
      return new Promise<TransportAnswer>(resolve => setTimeout(() => resolve(answer), SLOW));
    }
    if (request.path === '/v1/plugins')
      return json(inventoryOf(surfaces, workIsOff(machine) ? { agenda: { on: false }, board: { on: false } } : {}));
    if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    if (request.path === '/v1/grants') return json(grants);
    // `?host=unnamed`: the machine has no `host.yaml` name, so it goes by its host name (the "Name this machine" offer); `?host=named` has one.
    if (request.path === '/v1/config/file' && HOST_STATE !== null)
      return json(
        HOST_STATE === 'named'
          ? { exists: true, text: 'name: "workshop"\n', etag: 'e1' }
          : { exists: false, text: '', etag: 'e0' },
      );
    return json({ ok: true });
  });
const transports = new Map<string, FakeTransport>();
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
if (WORK === 'split')
  list.add({ daemon: 'ws2', machine: 'studio-host', deviceId: 'dev', address: 'http://127.0.0.1:40246' });
const runtime = new ShellRuntime({
  appVersion: '5.0.0',
  surfaces,
  daemons: list,
  connect: async paired => {
    const held = transports.get(paired.daemon) ?? transportOf(paired.daemon);
    transports.set(paired.daemon, held);
    return held;
  },
  passkey: () => provision,
  daemonless: {
    views: registeredDaemonless(surfaces, {} as DaemonlessPorts).views,
    location: () => window.location.href,
  },
});
const storage = memoryStore();
// `?nav=<form>` and `?phonenav=<side>` lay this DEVICE's choice over the default layout, the way Settings › Layout's device scope does:
// icons | words (the sidebar foot), list, rail, bottom; `?phonenav=bottom` is the phone-only bottom bar switch.
const deviceLayouts = new DeviceLayoutStore(storage);
const NAV_FORMS: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  icons: [
    ['nav.style', 'dock'],
    ['nav.labels', 'icons'],
  ],
  words: [
    ['nav.style', 'dock'],
    ['nav.labels', 'words'],
  ],
  list: [['nav.style', 'list']],
  rail: [['nav.style', 'rail']],
  bottom: [['nav.side', 'bottom']],
};
for (const [path, value] of NAV_FORMS[params.get('nav') ?? ''] ?? []) deviceLayouts.set(DEFAULT_LAYOUT, path, value);
if (params.get('phonenav') === 'bottom') deviceLayouts.set(DEFAULT_LAYOUT, 'phone.nav.side', 'bottom');

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <App
      runtime={runtime}
      themes={new ThemePreferenceStore(storage)}
      layouts={deviceLayouts}
      browser={window}
      scroll={new ScrollMemory(null)}
    />,
  );
