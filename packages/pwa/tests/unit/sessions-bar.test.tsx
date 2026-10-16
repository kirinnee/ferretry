import { afterEach, describe, expect, test } from 'bun:test';
import type { ComponentProps } from 'react';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { WORKSPACE_RAIL_BOUNDS, WorkspaceRailPreferenceStore } from '../../src/lib/workspace-rail-preferences.ts';
import { SessionsBar } from '../../src/shell/sessions-bar.tsx';
import '../support/dom.ts';
import { interact, type Mounted, mount, must, pressKey } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const DAEMON = 'alpha' as DaemonId;
const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const recent = new Date(NOW - 60_000).toISOString();

const SESSIONS = [
  sessionView('hadi-1', {
    config: { teammate: 'hadi', label: 'Fix the stuck sign-in', cwd: '/work/ferretry' },
    state: { lastActivityAt: recent },
  }),
  sessionView('maryah-1', {
    config: { teammate: 'maryah', label: 'Diene work', cwd: '/work/home-manager' },
    state: { status: 'awaiting_user', lastActivityAt: recent },
  }),
  sessionView('nameless', {
    config: {
      teammate: undefined as never,
      label: undefined as never,
      name: undefined as never,
      cwd: '/work/home-manager',
    },
    state: { status: 'waiting', lastActivityAt: recent },
  }),
];

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

type BarProps = ComponentProps<typeof SessionsBar>;

const bar = (props: Partial<BarProps> = {}) => {
  const calls: string[] = [];
  const element = (
    <SessionsBar
      active={null}
      activeSessionId="hadi-1"
      daemonId={DAEMON}
      machineName="work-mac"
      machines={[
        { daemonId: DAEMON, name: 'work-mac' },
        { daemonId: 'beta' as DaemonId, name: 'kirin-box' },
      ]}
      onAddMachine={() => calls.push('add-machine')}
      onCollapse={() => calls.push('collapse')}
      onNavigate={to => calls.push(`navigate:${to}`)}
      onOpenPalette={() => calls.push('palette')}
      presentation="column"
      projects={[]}
      sessions={SESSIONS}
      {...props}
    />
  );
  return { calls, element };
};

const click = async (element: Element | null, what: string): Promise<void> => {
  await interact(() => (must(element, what) as HTMLElement).click());
};

describe('SessionsBar as a column', () => {
  test('lists sessions by project, marks the open one, and badges the one that needs the reader', async () => {
    const { element } = bar();
    view = await mount(element);
    const projects = [...view.container.querySelectorAll('.fy-sbar__project')].map(node =>
      node.textContent?.replace(/\d+$/u, ''),
    );
    expect(projects).toEqual(['home-manager', 'ferretry']);
    const open = must(view.container.querySelector('[data-sbar-session="hadi-1"]'), 'the open session');
    expect(open.getAttribute('aria-current')).toBe('page');
    expect(open.querySelector('.fy-sbar__name')?.textContent).toBe('Hadi');
    expect(open.querySelector('.fy-sbar__sub')?.textContent).toBe('Fix the stuck sign-in');
    expect(open.querySelector('[data-sbar-dir]')?.textContent).toBe('/work/ferretry');
    // A session with no task of its own shows its folder once, not twice.
    const nameless = must(view.container.querySelector('[data-sbar-session="nameless"]'), 'the nameless session');
    expect(nameless.querySelector('.fy-sbar__sub')).toBeNull();
    expect(nameless.querySelector('[data-sbar-dir]')?.textContent).toBe('/work/home-manager');
    expect(view.container.querySelector('[data-sbar-session="maryah-1"] [data-sbar-needs-you]')).not.toBeNull();
    expect(view.container.querySelector('[data-sbar-session="hadi-1"] [data-sbar-needs-you]')).toBeNull();
    // A session with no callsign and no label falls back to its id rather than an empty row.
    expect(view.container.querySelector('[data-sbar-session="nameless"] .fy-sbar__name')?.textContent).toBe('nameless');
  });

  test('narrows the list with the filters and says when nothing matches', async () => {
    const { element } = bar({ sessions: [SESSIONS[0] as (typeof SESSIONS)[number]] });
    view = await mount(element);
    const chip = (id: string) => view?.container.querySelector<HTMLButtonElement>(`[data-sbar-filter="${id}"]`) ?? null;
    expect(chip('all')?.getAttribute('aria-pressed')).toBe('true');
    expect(chip('needs-you')?.textContent).toBe('Needs you 0');

    await click(chip('needs-you'), 'the Needs you filter');
    expect(chip('needs-you')?.getAttribute('aria-pressed')).toBe('true');
    expect(view.container.textContent).toContain('No sessions match Needs you.');

    await click(chip('running'), 'the Running filter');
    expect(view.container.querySelectorAll('[data-sbar-session]')).toHaveLength(1);
  });

  test('says it is still reading, and says plainly when nothing is running', async () => {
    const reading = bar({ sessions: null });
    view = await mount(reading.element);
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Reading sessions…');

    await view.render(bar({ sessions: [] }).element);
    expect(view.container.textContent).toContain('No sessions running.');
  });

  test('navigates from a row, a foot place and the new-session button', async () => {
    const { calls, element } = bar({ active: 'insights' });
    view = await mount(element);
    await click(view.container.querySelector('[data-sbar-session="maryah-1"]'), 'a session row');
    await click(view.container.querySelector('[data-sbar-place="settings"]'), 'Settings');
    await click(view.container.querySelector('[data-sbar-new]'), 'New session');
    expect(calls).toEqual([
      'navigate:/d/alpha/session/maryah-1',
      'navigate:/d/alpha/settings',
      'navigate:/d/alpha/new',
    ]);
    expect(view.container.querySelector('[data-sbar-place="insights"]')?.getAttribute('aria-current')).toBe('page');
  });

  test('opens the finder with the shortcut it claims, and folds itself to a rail', async () => {
    const { calls, element } = bar();
    view = await mount(element);
    const finder = must(
      view.container.querySelector<HTMLButtonElement>('[data-app-bar-destination-search]'),
      'the finder',
    );
    expect(finder.getAttribute('aria-keyshortcuts')).not.toBeNull();
    expect(finder.querySelector('kbd')).not.toBeNull();
    await click(finder, 'the finder');
    await click(view.container.querySelector('[data-sbar-collapse]'), 'Collapse');
    expect(calls).toEqual(['palette', 'collapse']);
  });

  test('gives a session page its own search, with a silent finder icon beside it', async () => {
    const { element } = bar({ search: <input aria-label="Search files & tasks" /> });
    view = await mount(element);
    expect(view.container.querySelector('input[aria-label="Search files & tasks"]')).not.toBeNull();
    const finder = must(view.container.querySelector('[data-app-bar-destination-search]'), 'the finder icon');
    expect(finder.getAttribute('aria-keyshortcuts')).toBeNull();
    expect(finder.textContent).toBe('');
  });

  test('switches machine and adds one from the machine menu', async () => {
    const { calls, element } = bar({
      update: { label: 'Update ready — reload', title: 'A newer version is installed.', tone: 'accent' },
      onApplyUpdate: () => calls.push('update'),
    });
    view = await mount(element);
    await click(view.container.querySelector('[data-sbar-update]'), 'the update offer');
    calls.length = 0;
    const machine = must(view.container.querySelector<HTMLButtonElement>('[data-sbar-machine]'), 'the machine');
    expect(machine.getAttribute('aria-label')).toBe('Machine: work-mac. Switch machine');
    await click(machine, 'the machine switcher');
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.map(item => item.textContent)).toEqual(['work-macthis one', 'kirin-box', 'Add a machine…']);
    await click(items[1] ?? null, 'kirin-box');
    await click(machine, 'the machine switcher');
    await click(
      [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === 'Add a machine…') ?? null,
      'Add a machine',
    );
    expect(calls).toEqual(['navigate:/d/beta', 'add-machine']);
    // Dismissed by its own close path, too.
    await click(machine, 'the machine switcher');
    await interact(() => pressKey(document, 'Escape'));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  test('offers "Pair a phone with ‹this machine›" above Add a machine, divided from the machines', async () => {
    const { calls, element } = bar({ onPairPhone: () => calls.push('pair-phone') });
    view = await mount(element);
    const machine = must(view.container.querySelector<HTMLButtonElement>('[data-sbar-machine]'), 'the machine');
    await click(machine, 'the machine switcher');
    const menu = must(document.querySelector('[role="menu"]'), 'the machine menu');
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.map(item => item.textContent)).toEqual([
      'work-macthis one',
      'kirin-box',
      'Pair a phone with work-mac…',
      'Add a machine…',
    ]);
    // One divider, between the machine list and the acts; each act carries its own mark.
    const separators = [...menu.querySelectorAll('[data-menu-separator]')];
    expect(separators).toHaveLength(1);
    expect(separators[0]?.nextElementSibling).toBe(items[2] as Element);
    expect(items[2]?.querySelector('svg')).not.toBeNull();
    expect(items[3]?.querySelector('svg')).not.toBeNull();

    await click(items[2] ?? null, 'Pair a phone');
    expect(calls).toEqual(['pair-phone']);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    // Focus is back on the switcher before the sheet opens, so closing the sheet returns there.
    expect(document.activeElement).toBe(machine);
  });

  test('does not offer pairing when the reader may not pair a device with this machine', async () => {
    const { element } = bar();
    view = await mount(element);
    await click(view.container.querySelector('[data-sbar-machine]'), 'the machine switcher');
    const menu = must(document.querySelector('[role="menu"]'), 'the machine menu');
    expect(menu.textContent).not.toContain('Pair a phone');
    // The divider still separates the machines from the one act left.
    expect(menu.querySelector('[data-menu-separator]')?.nextElementSibling?.textContent).toBe('Add a machine…');
  });

  test('carries the pairing entry into the phone drawer', async () => {
    const { calls, element } = bar({
      presentation: 'drawer',
      onClose: () => calls.push('close'),
      onPairPhone: () => calls.push('pair-phone'),
    });
    view = await mount(element);
    await click(view.container.querySelector('[data-sbar-machine]'), 'the machine switcher');
    await click(
      [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.startsWith('Pair a phone')) ??
        null,
      'Pair a phone',
    );
    // Pairing opens a sheet over the drawer; it is not a navigation, so the drawer stays.
    expect(calls).toEqual(['pair-phone']);
  });
});

describe('SessionsBar column width', () => {
  /** A remembered store over memory, so a commit is observable and no test touches localStorage. */
  const rails = () => {
    const saved = new Map<string, string>();
    return {
      saved,
      store: new WorkspaceRailPreferenceStore({
        getItem: key => saved.get(key) ?? null,
        setItem: (key, value) => void saved.set(key, value),
      }),
    };
  };
  const column = () => must(view?.container.querySelector<HTMLElement>('[data-sessions-bar="column"]'), 'the column');
  const edge = () =>
    must(view?.container.querySelector<HTMLElement>('[role="separator"][aria-label="Resize agents rail"]'), 'the edge');

  test('is resizable from its edge by keyboard, remembered, and reset by a double-click', async () => {
    const { saved, store } = rails();
    view = await mount(bar({ rails: store }).element);
    expect(column().style.width).toBe(`${WORKSPACE_RAIL_BOUNDS.left.initial}px`);

    await interact(() => pressKey(edge(), 'ArrowRight'));
    expect(column().style.width).toBe(`${WORKSPACE_RAIL_BOUNDS.left.initial + 16}px`);
    expect(JSON.parse(saved.get('fy-workspace-rails-v1') ?? '{}').left).toBe(WORKSPACE_RAIL_BOUNDS.left.initial + 16);

    // Remembered: a fresh bar over the same store opens at the width the reader left it.
    await view.unmount();
    view = await mount(
      bar({
        rails: new WorkspaceRailPreferenceStore({ getItem: key => saved.get(key) ?? null, setItem: () => undefined }),
      }).element,
    );
    expect(column().style.width).toBe(`${WORKSPACE_RAIL_BOUNDS.left.initial + 16}px`);
    await view.unmount();

    view = await mount(bar({ rails: store }).element);
    await interact(() => edge().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(column().style.width).toBe(`${WORKSPACE_RAIL_BOUNDS.left.initial}px`);
  });

  test('previews a drag without writing, and commits once when the pointer lets go', async () => {
    const { saved, store } = rails();
    view = await mount(bar({ rails: store }).element);
    const handle = edge();
    handle.setPointerCapture = () => undefined;
    const pointer = (type: string, clientX: number) =>
      handle.dispatchEvent(
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX }),
      );
    const parent = handle.parentElement as HTMLElement;
    parent.getBoundingClientRect = () => ({ width: 1200, height: 800 }) as DOMRect;

    await interact(() => pointer('pointerdown', 264));
    await interact(() => pointer('pointermove', 330));
    await interact(() => pointer('pointerup', 330));
    expect(column().style.width).toBe('330px');
    expect(JSON.parse(saved.get('fy-workspace-rails-v1') ?? '{}').left).toBe(330);
  });

  test('uses the page-wide store when none is handed in, and keeps the rail and drawer as they were', async () => {
    view = await mount(bar().element);
    expect(edge()).not.toBeNull();
    await view.unmount();
    view = await mount(bar({ presentation: 'rail', onExpand: () => undefined }).element);
    expect(view.container.querySelector('[aria-label="Resize agents rail"]')).toBeNull();
  });
});

describe('SessionsBar as a rail', () => {
  test('keeps the sessions as status dots and the places as icons, and expands back', async () => {
    const { calls, element } = bar({ presentation: 'rail', active: 'projects', onExpand: () => calls.push('expand') });
    view = await mount(element);
    expect(view.container.querySelector('[data-sessions-bar="rail"]')).not.toBeNull();
    const dots = [...view.container.querySelectorAll<HTMLAnchorElement>('.fy-sbar__dot')];
    expect(dots.map(dot => dot.getAttribute('aria-label'))).toEqual(['Maryah', 'nameless', 'Hadi']);
    expect(dots.find(dot => dot.getAttribute('aria-current') === 'page')?.getAttribute('aria-label')).toBe('Hadi');
    expect(view.container.querySelector('[aria-label="Projects"]')?.getAttribute('aria-current')).toBe('page');
    await click(dots[0] ?? null, 'a dot');
    await click(view.container.querySelector('[data-sbar-expand]'), 'Expand');
    await click(view.container.querySelector('[data-app-bar-destination-search]'), 'the finder');
    expect(calls).toEqual(['navigate:/d/alpha/session/maryah-1', 'expand', 'palette']);
  });

  test('draws no expand control when its host offers none', async () => {
    const { element } = bar({ presentation: 'rail', sessions: null });
    view = await mount(element);
    expect(view.container.querySelector('[data-sbar-expand]')).toBeNull();
    expect(view.container.querySelectorAll('.fy-sbar__dot')).toHaveLength(0);
  });
});

describe('SessionsBar as a phone drawer', () => {
  test('is a modal that closes itself on navigation, on its close button and on Escape', async () => {
    let closed = 0;
    const { calls, element } = bar({ presentation: 'drawer', onClose: () => (closed += 1) });
    view = await mount(element);
    const drawer = must(view.container.querySelector('[data-sessions-bar="drawer"]'), 'the drawer');
    expect(drawer.getAttribute('aria-modal')).toBe('true');
    expect(drawer.querySelector('[data-sbar-collapse]')).toBeNull();

    await click(drawer.querySelector('[data-sbar-session="maryah-1"]'), 'a row');
    expect(calls).toEqual(['navigate:/d/alpha/session/maryah-1']);
    expect(closed).toBe(1);

    await click(drawer.querySelector('.fy-sbar__top button[aria-label="Close sessions"]'), 'the close button');
    expect(closed).toBe(2);
    await interact(() => pressKey(drawer, 'Escape'));
    expect(closed).toBe(3);
  });

  test('closes quietly when its host handed it no close callback', async () => {
    const { element } = bar({ presentation: 'drawer' });
    view = await mount(element);
    await click(view.container.querySelector('[data-sbar-place="projects"]'), 'Projects');
    expect(view.container.querySelector('[data-sessions-bar="drawer"]')).not.toBeNull();
  });
});
