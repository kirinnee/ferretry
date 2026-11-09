import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { implementApp, type PanelProps } from '@ferretry/kernel/manifest';
import { BUILT_IN_LAYOUTS } from '@ferretry/plugin-layouts/contract';
import { type ReactNode, useState } from 'react';
import { deviceControls, useDeviceControls } from '../../../src/compose/device-controls.ts';
import { provideToShell } from '../../../src/connect/provides.ts';
import { useAppHook } from '../../../src/shell/app-hooks.ts';
import { PanelSlot } from '../../../src/shell/views.tsx';
import { useViewPlace } from '../../../src/shell/view-place.tsx';
import { useEveryDaemon } from '../../../src/shell/every-daemon.ts';
import { useDevicePaired } from '../../../src/shell/device-context.tsx';
import { useNavForm } from '../../../src/shell/device-panels.tsx';
import { APP_STORAGE } from '../../../src/storage/names.ts';
import { memoryStore, writeRecord } from '../../../src/storage/records.ts';
import { interact, type Mounted } from '../../support/dom.ts';
import { bootApp, entryOf, manifestOf, settle } from './frame-fixtures.tsx';

/**
 * DRAWING THE `nav`, `side` AND `device.settings` SLOTS, PLUS NAV BADGES (shell contract S4): a nav panel is device-level
 * (drawn once, no daemon, a column nav only), a `device.settings` panel needs no machine, the side column draws its
 * panels for the route's daemon, a nav entry's count is the SUM over every machine where the plugin is allowed, and `top`
 * and `bottom` panels are not drawn.
 */

// ─── a plugin like Agenda: an Inbox door with a count, a Needs-you nav panel, an Appearance panel, and a side note ────

/** What each machine's badge provider counts, and who is listening. */
const counts = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
const built: string[] = [];
/** How the provider misbehaves, when a test says so. */
const misbehave = { countThrows: false, subscribeThrows: false };
const setCount = (daemon: string, n: number): void => {
  counts.set(daemon, n);
  for (const listener of listeners.get(daemon) ?? []) listener();
};

function NeedsYou(): ReactNode {
  const rows = useEveryDaemon();
  const scope = useDeviceControls().device.sessionsList;
  const selected = useDevicePaired().selected;
  const shown = scope === 'current' ? rows.filter(row => row.daemon === selected) : rows;
  return (
    <ul data-testid="needs-you" data-form={useNavForm()}>
      {shown.map(row => (
        <li key={row.daemon} data-testid={`needs-${row.daemon}`} data-online={String(row.online)}>
          {row.machine}
        </li>
      ))}
    </ul>
  );
}

const writes: string[] = [];
/** What a device panel can reach by a daemon ARGUMENT: nothing. */
const byArgument: unknown[] = [];
/** The view place each device panel saw: none, whatever page it is drawn beside. */
const placesSeen: unknown[] = [];
function Marks(): ReactNode {
  const rows = useEveryDaemon();
  byArgument.push(useAppHook('d1', 'inbox.store'));
  placesSeen.push(useViewPlace());
  const [, bump] = useState(0);
  return (
    <section data-testid="marks">
      <p>message marks</p>
      <PanelSlot daemon="d1" slot="side" />
      {rows.map(row => {
        const state = row.authority('fleet', 'configure');
        return state.kind === 'refused' ? null : (
          <button
            key={row.daemon}
            type="button"
            data-testid={`mark-${row.daemon}`}
            onClick={() => {
              void row.client.call('POST /v1/inbox/marks', { body: {} }).then(() => {
                writes.push(row.daemon);
                bump(n => n + 1);
              });
            }}
          >
            {row.machine}
          </button>
        );
      })}
    </section>
  );
}

const inboxManifest = manifestOf('inbox', {
  actions: {
    routes: [{ key: 'POST /v1/inbox/marks', minimum: 'authenticated', caller: 'any', audit: 'skip' }],
  },
  ui: {
    screens: [{ id: 'inbox', path: 'inbox', nav: { label: 'Inbox', order: 1 } }],
    panels: [
      { id: 'needs-you', slot: 'nav', order: 10 },
      { id: 'marks', slot: 'device.settings', order: 10 },
      { id: 'side-note', slot: 'side', order: 10 },
      { id: 'top-note', slot: 'top', order: 10 },
      { id: 'bottom-note', slot: 'bottom', order: 10 },
    ],
  },
});
const inbox = entryOf(
  inboxManifest,
  provideToShell(
    implementApp(inboxManifest, {
      build: () => ({
        screens: { inbox: () => <p>inbox page</p> },
        panels: {
          'side-note': ({ subject }: PanelProps) => <p data-testid="side-note">side note {String(subject)}</p>,
          'top-note': () => <p>top note</p>,
          'bottom-note': () => <p>bottom note</p>,
        },
      }),
    }),
    {
      hooks: { 'inbox.store': () => ({ store: true }) },
      navPanels: { 'needs-you': NeedsYou },
      deviceSettings: { marks: Marks },
      navBadges: {
        inbox: ({ daemon }) => {
          built.push(daemon);
          return {
            count: () => {
              if (misbehave.countThrows) throw new Error('count failed');
              return counts.get(daemon) ?? 0;
            },
            subscribe: changed => {
              if (misbehave.subscribeThrows) throw new Error('subscribe failed');
              const set = listeners.get(daemon) ?? new Set();
              listeners.set(daemon, set);
              set.add(changed);
              return () => void set.delete(changed);
            },
          };
        },
      },
    },
  ),
);

/** A skeleton plugin: it declares an Inbox-like nav entry but implements nothing. */
const quietManifest = manifestOf('quiet', {
  ui: { screens: [{ id: 'q', path: 'q', nav: { label: 'Quiet', order: 2 } }] },
});
const quiet = entryOf(quietManifest, implementApp(quietManifest, { skeleton: true } as never));

/** What each machine's poster badge provider sends when poked (a "seen" mark), as a careless one could. */
const pokes = new Map<string, () => void>();
const posterManifest = manifestOf('poster', {
  actions: { routes: [{ key: 'POST /v1/poster/seen', minimum: 'authenticated', caller: 'any', audit: 'skip' }] },
  ui: { screens: [{ id: 'poster', path: 'poster', nav: { label: 'Poster', order: 3 } }] },
});
const poster = entryOf(
  posterManifest,
  provideToShell(implementApp(posterManifest, { build: () => ({ screens: { poster: () => <p>poster page</p> } }) }), {
    navBadges: {
      poster: ({ client, daemon }) => {
        pokes.set(daemon, () => void client.call('POST /v1/poster/seen', { body: {} }).catch(() => {}));
        return { count: () => 0, subscribe: () => () => {} };
      },
    },
  }),
);

const LIST = { style: 'list', items: ['inbox', 'settings'] };
const PHONE = { side: 'bottom', items: ['inbox'] };

/**
 * This device's layout override. The built-in default names screens and panels these fixtures do not install, which would
 * refuse the whole candidate, so the override also clears the names it cannot resolve here.
 */
const deviceLayout = (nav: Record<string, unknown>, phoneNav: Record<string, unknown> = PHONE) => {
  const storage = memoryStore();
  writeRecord(storage, APP_STORAGE.layout, {
    nav,
    phone: { nav: phoneNav },
    panels: { 'ferret.side': [] },
    'composer.tools': [],
  });
  return storage;
};

let view: Mounted | null = null;
beforeEach(() => {
  deviceControls().setDeviceControls({ sessionsList: 'all' });
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  counts.clear();
  listeners.clear();
  built.length = 0;
  pokes.clear();
  writes.length = 0;
  byArgument.length = 0;
  placesSeen.length = 0;
  misbehave.countThrows = false;
  misbehave.subscribeThrows = false;
  deviceControls().setDeviceControls({ sessionsList: 'all' });
});

const text = (): string => view?.container.textContent ?? '';
const panels = (name: string): number => view?.container.querySelectorAll(`[data-panel="${name}"]`).length ?? 0;

describe('the nav count', () => {
  test('shell S4: the badge is the SUM over every machine, with either one selected, on the column nav and on the phone tab bar', async () => {
    counts.set('d1', 2);
    counts.set('d2', 3);
    for (const viewport of ['wide', 'phone'] as const) {
      for (const path of ['/d/d1/inbox', '/d/d2/inbox']) {
        const app = await bootApp({
          surfaces: [inbox],
          machines: ['d1', 'd2'],
          path,
          viewport,
          storage: deviceLayout(LIST, PHONE),
        });
        view = app.view;
        const badge = app.view.container.querySelector('.fy-nav__badge');
        expect(badge?.getAttribute('data-count')).toBe('5');
        expect(badge?.textContent).toContain('5');
        await view.unmount();
        view = null;
      }
    }
  });

  test('shell S4: the badge is drawn on a collapsed rail too, and reads "N open Inbox items" to a screen reader', async () => {
    counts.set('d1', 4);
    const app = await bootApp({
      surfaces: [inbox],
      machines: ['d1'],
      path: '/d/d1/inbox',
      storage: deviceLayout({ style: 'rail', items: ['inbox'] }),
    });
    view = app.view;
    expect(app.view.container.querySelector('.fy-nav--rail .fy-nav__badge')).not.toBeNull();
    expect(text()).toContain('4 open Inbox items');
  });

  test('shell S4 (R1 n2): a screen reader hears "1 open Inbox item", not "1 open Inbox items"', async () => {
    counts.set('d1', 1);
    const app = await bootApp({
      surfaces: [inbox],
      machines: ['d1'],
      path: '/d/d1/inbox',
      storage: deviceLayout(LIST),
    });
    view = app.view;
    expect(app.view.container.querySelector('.fy-nav__badge .sr-only')?.textContent).toBe('1 open Inbox item');
  });

  test('shell S4: a sum of 0 draws no badge, and 100+ is capped at 99+', async () => {
    const app = await bootApp({
      surfaces: [inbox],
      machines: ['d1'],
      path: '/d/d1/inbox',
      storage: deviceLayout(LIST),
    });
    view = app.view;
    expect(app.view.container.querySelector('.fy-nav__badge')).toBeNull();
    await interact(() => setCount('d1', 150));
    const badge = app.view.container.querySelector('.fy-nav__badge');
    expect(badge?.querySelector('[aria-hidden="true"]')?.textContent).toBe('99+');
    expect(badge?.getAttribute('data-count')).toBe('150');
  });

  test('shell S4: one machine’s change re-draws the sum', async () => {
    counts.set('d1', 2);
    counts.set('d2', 3);
    const app = await bootApp({
      surfaces: [inbox],
      machines: ['d1', 'd2'],
      path: '/d/d1/inbox',
      storage: deviceLayout(LIST),
    });
    view = app.view;
    await interact(() => setCount('d2', 7));
    expect(app.view.container.querySelector('.fy-nav__badge')?.getAttribute('data-count')).toBe('9');
    await interact(() => setCount('d1', 0));
    expect(app.view.container.querySelector('.fy-nav__badge')?.getAttribute('data-count')).toBe('7');
  });

  test('shell S4: a machine where the plugin is blocked adds 0, a locked machine adds 0, and a machine never opened still counts', async () => {
    counts.set('d1', 2);
    counts.set('d2', 3);
    counts.set('d3', 4);
    // Opened on /d/d1/inbox only: d2 and d3 are never visited, and still count (2 + 3 + 4 = 9) at app open.
    const app = await bootApp({
      surfaces: [inbox],
      machines: ['d1', 'd2', 'd3'],
      path: '/d/d1/inbox',
      storage: deviceLayout(LIST),
    });
    view = app.view;
    expect(app.view.container.querySelector('.fy-nav__badge')?.getAttribute('data-count')).toBe('9');
    app.machine('d3').off.add('inbox');
    await app.reread('d3');
    expect(app.view.container.querySelector('.fy-nav__badge')?.getAttribute('data-count')).toBe('5');
    // d2 locks (a 401 unlock_required on its next read): it adds 0 until unlocked.
    app.machine('d2').locked = true;
    await app.reread('d2');
    await settle();
    expect(app.view.container.querySelector('.fy-nav__badge')?.getAttribute('data-count')).toBe('2');
    await app.unlock('d2');
    await app.reread('d2');
    expect(app.view.container.querySelector('.fy-nav__badge')?.getAttribute('data-count')).toBe('5');
  });

  test('shell S4: the providers are built over every allowed machine at app open, before any page of it is visited', async () => {
    const app = await bootApp({ surfaces: [inbox], machines: ['d1', 'd2'], path: '/', storage: deviceLayout(LIST) });
    view = app.view;
    expect([...new Set(built)].sort()).toEqual(['d1', 'd2']);
  });

  test('shell S4: a skeleton plugin’s nav entry draws no badge and a provider that throws counts 0', async () => {
    const app = await bootApp({
      surfaces: [quiet, inbox],
      machines: ['d1'],
      path: '/',
      storage: deviceLayout({ style: 'list', items: ['q', 'inbox'] }),
    });
    view = app.view;
    counts.set('d1', 1);
    await interact(() => setCount('d1', 1));
    expect(app.view.container.querySelectorAll('.fy-nav__badge')).toHaveLength(1);
  });
});

describe('the nav badge origin (R1 m5)', () => {
  test('shell S4: a badge provider’s POST to a machine that locked after it was built raises no prompt (background origin), and goes once unlocked', async () => {
    const app = await bootApp({
      surfaces: [poster],
      machines: ['d1', 'd2'],
      path: '/d/d2/poster',
      storage: deviceLayout({ style: 'list', items: ['poster'] }, { side: 'bottom', items: ['poster'] }),
    });
    view = app.view;
    expect([...pokes.keys()].sort()).toEqual(['d1', 'd2']);
    // d1 locks (its unlock expired) while nobody looks at it; the provider it was built with sends a mark.
    app.machine('d1').locked = true;
    pokes.get('d1')?.();
    await settle();
    expect(app.prompts.length).toBeGreaterThan(0);
    expect(app.prompts.every(prompt => prompt.origin === 'background')).toBe(true);
    // The one refused attempt is all that reached the machine; the mark waits for the unlock and then goes through.
    const marks = (): number =>
      app
        .machine('d1')
        .transport.paths()
        .filter(path => path === 'POST /v1/poster/seen').length;
    expect(marks()).toBe(1);
    await app.unlock('d1');
    expect(marks()).toBe(2);
  });
});

describe('a provider that misbehaves', () => {
  test('shell S4: a count that is negative, not a number or throws counts 0, and a subscribe that throws breaks nothing', async () => {
    counts.set('d1', 2);
    const app = await bootApp({
      surfaces: [inbox],
      machines: ['d1', 'd2'],
      path: '/d/d1/inbox',
      storage: deviceLayout(LIST),
    });
    view = app.view;
    counts.set('d2', 3);
    expect(app.view.container.querySelector('.fy-nav__badge')?.getAttribute('data-count')).toBe('2');
    await interact(() => setCount('d2', -4));
    expect(app.view.container.querySelector('.fy-nav__badge')?.getAttribute('data-count')).toBe('2');
    await interact(() => setCount('d2', Number.NaN));
    expect(app.view.container.querySelector('.fy-nav__badge')?.getAttribute('data-count')).toBe('2');
    misbehave.countThrows = true;
    await interact(() => setCount('d1', 5));
    expect(app.view.container.querySelector('.fy-nav__badge')).toBeNull();
    await view.unmount();
    // A provider whose subscribe throws is built on the next boot: the nav still draws, and the sum still reads.
    misbehave.countThrows = false;
    misbehave.subscribeThrows = true;
    const again = await bootApp({
      surfaces: [inbox],
      machines: ['d1'],
      path: '/d/d1/inbox',
      storage: deviceLayout(LIST),
    });
    view = again.view;
    expect(again.view.container.querySelector('.fy-nav__badge')?.getAttribute('data-count')).toBe('5');
  });

  test('shell S4: a nav entry with no machine to open it on is dimmed, and draws no count', async () => {
    const app = await bootApp({ surfaces: [inbox], machines: [], path: '/app/', storage: deviceLayout(LIST) });
    view = app.view;
    const off = app.view.container.querySelector('.fy-nav__item--off');
    expect(off?.textContent).toBe('Inbox');
    expect(app.view.container.querySelector('.fy-nav__badge')).toBeNull();
  });
});

describe('the Needs-you nav panel (device-level)', () => {
  test('shell S4: a nav panel is drawn ONCE, not once per daemon, in a column nav, and lists both machines', async () => {
    const app = await bootApp({
      surfaces: [inbox],
      machines: ['d1', 'd2'],
      path: '/d/d1/inbox',
      storage: deviceLayout(LIST),
    });
    view = app.view;
    expect(panels('inbox.needs-you')).toBe(1);
    expect(text()).toContain('d1-host');
    expect(text()).toContain('d2-host');
    expect(app.view.container.querySelectorAll('[data-testid="needs-you"]')).toHaveLength(1);
  });

  test('shell S4: a nav panel is drawn in the rail too, once, told it is a rail, and the column is told it is a column', async () => {
    const rail = await bootApp({
      surfaces: [inbox],
      machines: ['d1', 'd2'],
      path: '/d/d1/inbox',
      storage: deviceLayout({ style: 'rail', items: ['inbox'] }),
    });
    view = rail.view;
    expect(panels('inbox.needs-you')).toBe(1);
    expect(
      rail.view.container.querySelector('.fy-nav--rail [data-testid="needs-you"]')?.getAttribute('data-form'),
    ).toBe('rail');
    expect(text()).toContain('d2-host');
    await view.unmount();
    const column = await bootApp({
      surfaces: [inbox],
      machines: ['d1'],
      path: '/d/d1/inbox',
      storage: deviceLayout(LIST),
    });
    view = column.view;
    expect(column.view.container.querySelector('[data-testid="needs-you"]')?.getAttribute('data-form')).toBe('column');
  });

  for (const layout of BUILT_IN_LAYOUTS) {
    // R2 m2: v4 drew the full group in the sessions column on a desktop, so the DEFAULT layout's nav is a list (column)
    // and only `compact` is a rail.
    const form = layout.id === 'default' ? 'column' : 'rail';
    test(`shell S4 (R1 M1, R2 m2): under the built-in "${layout.id}" layout on a desktop the Needs-you panel is drawn, once, in the ${form} form`, async () => {
      const app = await bootApp({
        surfaces: [inbox],
        machines: ['d1', 'd2'],
        path: '/d/d1/inbox',
        storage: deviceLayout({ side: layout.nav.side, style: layout.nav.style, items: ['inbox'] }),
      });
      view = app.view;
      expect(layout.nav.style).toBe(form === 'column' ? 'list' : 'rail');
      expect(panels('inbox.needs-you')).toBe(1);
      expect(app.view.container.querySelector('[data-testid="needs-you"]')?.getAttribute('data-form')).toBe(form);
    });
  }

  test('shell S4: nav panels are absent on the phone bar, and on a top bar', async () => {
    const phone = await bootApp({
      surfaces: [inbox],
      machines: ['d1'],
      path: '/d/d1/inbox',
      viewport: 'phone',
      storage: deviceLayout(LIST, PHONE),
    });
    view = phone.view;
    expect(panels('inbox.needs-you')).toBe(0);
    await view.unmount();
    const top = await bootApp({
      surfaces: [inbox],
      machines: ['d1'],
      path: '/d/d1/inbox',
      storage: deviceLayout({ side: 'top', style: 'bar', items: ['inbox'] }),
    });
    view = top.view;
    expect(panels('inbox.needs-you')).toBe(0);
  });

  test('shell S4: with the selected machine unreachable or the plugin paused on it, the other machine’s rows still show and no blocked line is drawn', async () => {
    const app = await bootApp({
      surfaces: [inbox],
      machines: ['d1', 'd2'],
      path: '/',
      off: { d1: ['inbox'] },
      storage: deviceLayout(LIST),
    });
    view = app.view;
    app.runtime.daemons.select('d1');
    await settle();
    expect(app.view.container.querySelector('[data-testid="needs-d2"]')).not.toBeNull();
    expect(app.view.container.querySelector('[data-testid="needs-d1"]')).toBeNull();
    expect(text()).not.toContain('cannot reach');
    expect(text()).not.toContain('is off');
    expect(text()).not.toContain('paused');
  });

  test('shell S4: "Sessions list: current" shows the selected machine only; "all" shows both', async () => {
    const app = await bootApp({ surfaces: [inbox], machines: ['d1', 'd2'], path: '/', storage: deviceLayout(LIST) });
    view = app.view;
    app.runtime.daemons.select('d2');
    await interact(() => deviceControls().setDeviceControls({ sessionsList: 'current' }));
    await settle();
    expect(app.view.container.querySelector('[data-testid="needs-d1"]')).toBeNull();
    expect(app.view.container.querySelector('[data-testid="needs-d2"]')).not.toBeNull();
    await interact(() => deviceControls().setDeviceControls({ sessionsList: 'all' }));
    expect(app.view.container.querySelector('[data-testid="needs-d1"]')).not.toBeNull();
    expect(app.view.container.querySelector('[data-testid="needs-d2"]')).not.toBeNull();
  });

  test('shell S4: a machine whose feed drops keeps its row, offline (the panel greys it)', async () => {
    const app = await bootApp({ surfaces: [inbox], machines: ['d1', 'd2'], path: '/', storage: deviceLayout(LIST) });
    view = app.view;
    await interact(() => app.machine('d1').transport.openFeed());
    await settle();
    expect(app.view.container.querySelector('[data-testid="needs-d1"]')?.getAttribute('data-online')).toBe('true');
    await interact(() => app.machine('d1').transport.dropFeed());
    await settle();
    const row = app.view.container.querySelector('[data-testid="needs-d1"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('data-online')).toBe('false');
  });
});

describe('the device.settings slot', () => {
  test('shell S4: draws each panel once with NO paired machine', async () => {
    const app = await bootApp({ surfaces: [inbox], machines: [], path: '/settings' });
    view = app.view;
    expect(panels('inbox.marks')).toBe(1);
    expect(text()).toContain('message marks');
    expect(app.view.container.querySelectorAll('[data-testid="marks"]')).toHaveLength(1);
    // Under the Appearance block: after the theme/mode/text-size controls, before the layout line.
    const page = text();
    expect(page.indexOf('Text size')).toBeLessThan(page.indexOf('message marks'));
    expect(page.indexOf('message marks')).toBeLessThan(page.indexOf('Layout:'));
  });

  test('shell S4: draws with the selected machine offline, and with a machine locked', async () => {
    const app = await bootApp({ surfaces: [inbox], machines: ['d1', 'd2'], path: '/settings', locked: ['d2'] });
    view = app.view;
    expect(panels('inbox.marks')).toBe(1);
    // One row per machine, the locked one shown too (a click on it is a press that asks for the unlock first).
    expect(app.view.container.querySelector('[data-testid="mark-d1"]')).not.toBeNull();
    expect(app.view.container.querySelector('[data-testid="mark-d2"]')).not.toBeNull();
  });

  test('shell S4: a per-machine row writes to its own machine only', async () => {
    const app = await bootApp({ surfaces: [inbox], machines: ['d1', 'd2'], path: '/settings' });
    view = app.view;
    app.runtime.daemons.select('d1');
    const before2 = app
      .machine('d2')
      .transport.paths()
      .filter(path => path === 'POST /v1/inbox/marks').length;
    await interact(() => (app.view.container.querySelector('[data-testid="mark-d2"]') as HTMLElement).click());
    await settle();
    expect(
      app
        .machine('d2')
        .transport.paths()
        .filter(path => path === 'POST /v1/inbox/marks'),
    ).toHaveLength(before2 + 1);
    expect(app.machine('d1').transport.paths()).not.toContain('POST /v1/inbox/marks');
    expect(writes).toEqual(['d2']);
  });

  test('shell S4: a view-only machine’s row hides its control (m1)', async () => {
    const app = await bootApp({ surfaces: [inbox], machines: ['d1', 'd2'], path: '/settings', viewOnly: ['d2'] });
    view = app.view;
    expect(app.view.container.querySelector('[data-testid="mark-d1"]')).not.toBeNull();
    expect(app.view.container.querySelector('[data-testid="mark-d2"]')).toBeNull();
  });

  test('shell S4: a device.settings panel is drawn under WithoutShell: no daemon ARGUMENT reaches a machine (useAppHook, PanelSlot)', async () => {
    const app = await bootApp({ surfaces: [inbox], machines: ['d1'], path: '/settings' });
    view = app.view;
    expect(panels('inbox.marks')).toBe(1);
    // The hook exists on d1 (a per-daemon view would read it), and a device panel asking for it by daemon gets nothing.
    expect(app.runtime.appHook('d1', 'inbox.store')).toEqual({ store: true });
    expect(byArgument.length).toBeGreaterThan(0);
    expect(byArgument.every(value => value === undefined)).toBe(true);
    // A PanelSlot in a device panel draws nothing (the side panel exists and is not drawn here).
    expect(app.view.container.querySelector('[data-testid="marks"] [data-testid="side-note"]')).toBeNull();
  });

  test('shell S4 (R1 n4): a device panel is drawn in no machine’s view place', async () => {
    const app = await bootApp({ surfaces: [inbox], machines: ['d1'], path: '/settings' });
    view = app.view;
    expect(placesSeen.length).toBeGreaterThan(0);
    expect(placesSeen.every(place => place === null)).toBe(true);
  });

  test('shell S4: a nav panel is drawn under WithoutShell too: it reaches machines only through its rows', async () => {
    const app = await bootApp({
      surfaces: [inbox],
      machines: ['d1'],
      path: '/d/d1/inbox',
      storage: deviceLayout(LIST),
    });
    view = app.view;
    expect(app.view.container.querySelector('[data-device-slot="nav"]')).not.toBeNull();
  });
});

describe('the side column', () => {
  test('shell S4: draws the side slot’s panels for the route’s daemon on a wide screen, and nothing without a daemon', async () => {
    const app = await bootApp({ surfaces: [inbox], machines: ['d1', 'd2'], path: '/d/d2/inbox' });
    view = app.view;
    expect(panels('inbox.side-note')).toBe(1);
    expect(app.view.container.querySelector('.fy-side')).not.toBeNull();
    await view.unmount();
    const home = await bootApp({ surfaces: [inbox], machines: ['d1', 'd2'], path: '/app/' });
    view = home.view;
    expect(panels('inbox.side-note')).toBe(0);
  });

  test('shell S4: the side column is not drawn on a phone (wide-only)', async () => {
    const app = await bootApp({ surfaces: [inbox], machines: ['d1'], path: '/d/d1/inbox', viewport: 'phone' });
    view = app.view;
    expect(panels('inbox.side-note')).toBe(0);
  });
});

describe('top and bottom stay undrawn (M7)', () => {
  test('shell S4: panels declared in top and bottom are not drawn anywhere', async () => {
    const app = await bootApp({ surfaces: [inbox], machines: ['d1'], path: '/d/d1/inbox' });
    view = app.view;
    expect(text()).not.toContain('top note');
    expect(text()).not.toContain('bottom note');
    expect(panels('inbox.top-note')).toBe(0);
    expect(panels('inbox.bottom-note')).toBe(0);
  });
});
