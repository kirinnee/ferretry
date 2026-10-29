import { afterEach, describe, expect, test } from 'bun:test';
import type { ComponentProps } from 'react';
import type { MachineSource } from '../../src/lib/all-machines.ts';
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
    state: {
      status: 'awaiting_user',
      attention: { open: 1, first: 'A1', ask: 'Ask?', latestAt: recent },
      lastActivityAt: recent,
    },
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
      initialMode="all"
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
      groupNeedsYou={props.machineSources !== undefined}
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
  test('shows a one-line preview of the question a waiting ferret asks, on its row', async () => {
    const asking = sessionView('asker-1', {
      config: { teammate: 'asker', cwd: '/work/ferretry', mode: 'interactive' },
      state: {
        status: 'awaiting_question',
        attention: { open: 1, first: 'A1', ask: 'Rebase onto main first?', latestAt: recent },
        pendingQuestion: { toolUseId: 't1', questions: [{ question: 'Rebase onto main first?' }] },
      },
    });
    view = await mount(bar({ sessions: [...SESSIONS, asking] }).element);
    const row = must(view.container.querySelector('[data-sbar-session="asker-1"]'), 'the asking row');
    expect(row.querySelector('[data-sbar-question]')?.textContent).toBe('Rebase onto main first?');
    expect(row.getAttribute('title')).toContain('Rebase onto main first?');
  });

  test('lists sessions by project, marks the open one, and badges the one that needs the reader', async () => {
    const { element } = bar();
    view = await mount(element);
    const projects = [...view.container.querySelectorAll('.fy-sbar__project')].map(node =>
      node.textContent?.replace(/\d+$/u, ''),
    );
    expect(projects).toEqual(['home-manager', 'ferretry']);
    const open = must(view.container.querySelector('[data-sbar-session="hadi-1"]'), 'the open session');
    expect(open.getAttribute('aria-current')).toBe('page');
    // The title is the task; the ferret doing it is the small second line, with its initial.
    expect(open.querySelector('.fy-sbar__name')?.textContent).toBe('Fix the stuck sign-in');
    expect(open.querySelector('[data-sbar-ferret] .fy-sbar__ferret-name')?.textContent).toBe('Hadi');
    expect(open.querySelector('[data-sbar-ferret] .fy-sbar__initial')?.textContent).toBe('H');
    expect(open.querySelector('[data-sbar-dir]')?.textContent).toBe('/work/ferretry');
    // A session with no task of its own shows its folder once, not twice.
    const nameless = must(view.container.querySelector('[data-sbar-session="nameless"]'), 'the nameless session');
    expect(nameless.querySelector('.fy-sbar__sub')).toBeNull();
    expect(nameless.querySelector('[data-sbar-ferret]')).toBeNull();
    expect(nameless.querySelector('[data-sbar-dir]')?.textContent).toBe('/work/home-manager');
    // Only a session that is actually waiting on a question echoes it.
    expect(view.container.querySelector('[data-sbar-session="hadi-1"] [data-sbar-question]')).toBeNull();
    // A session with no callsign and no label falls back to its id rather than an empty row.
    expect(view.container.querySelector('[data-sbar-session="nameless"] .fy-sbar__name')?.textContent).toBe('nameless');
  });

  test('titles a row by its task and falls back to the ferret when there is no task title', async () => {
    const taskless = sessionView('taskless-1', {
      config: { teammate: 'pim', label: undefined as never, name: undefined as never, cwd: '/work/ferretry' },
    });
    const labelOnly = sessionView('label-only', {
      config: { teammate: undefined as never, label: 'Home Manager', cwd: '/work/ferretry' },
    });
    view = await mount(bar({ sessions: [...SESSIONS, taskless, labelOnly] }).element);
    const row = (id: string) => must(view?.container.querySelector(`[data-sbar-session="${id}"]`) ?? null, id);
    expect(row('maryah-1').querySelector('.fy-sbar__name')?.textContent).toBe('Diene work');
    expect(row('maryah-1').querySelector('.fy-sbar__ferret-name')?.textContent).toBe('Maryah');
    expect(row('taskless-1').querySelector('.fy-sbar__name')?.textContent).toBe('Pim');
    expect(row('taskless-1').querySelector('[data-sbar-ferret]')).toBeNull();
    expect(row('label-only').querySelector('.fy-sbar__name')?.textContent).toBe('Home Manager');
    expect(row('label-only').querySelector('[data-sbar-ferret]')).toBeNull();
    expect(row('maryah-1').getAttribute('title')).toContain('Diene work — Maryah');
  });

  test('marks a ferret instructed to learn with the cap alone, unless it needs the reader', async () => {
    const { element } = bar({ learningPassive: new Set(['hadi-1', 'maryah-1']) });
    view = await mount(element);
    const chip = (id: string) => view?.container.querySelector(`[data-sbar-session="${id}"] [data-learning-passive]`);
    expect(chip('hadi-1')?.textContent).toBe('');
    expect(chip('hadi-1')?.getAttribute('aria-label')).toContain('Learning: passive');
    // "needs you" is the more urgent fact, and the row has one slot for it.
    expect(chip('maryah-1')).toBeNull();
    expect(chip('nameless')).toBeNull();
  });

  test('marks Hypermedia and Pack mode beside the cap, only while each is on', async () => {
    const told = sessionView('told-1', { config: { teammate: 'ora', mode: 'interactive', cwd: '/work/ferretry' } });
    const untold = sessionView('untold-1', {
      config: { teammate: 'pim', mode: 'interactive', hypermedia: false, pack: false, cwd: '/work/ferretry' },
    });
    const { element } = bar({ sessions: [told, untold], learningPassive: new Set(['told-1']) });
    view = await mount(element);
    const marks = (id: string) =>
      [...(view?.container.querySelectorAll(`[data-sbar-session="${id}"] [data-switch-marks] > *`) ?? [])].map(
        node => node.getAttribute('data-switch-mark') ?? 'learning',
      );
    expect(marks('told-1')).toEqual(['learning', 'hypermedia', 'pack']);
    expect(marks('untold-1')).toEqual([]);
    // A row is a link, so its marks are pictures with words, never controls of their own.
    expect(view.container.querySelector('[data-sbar-session="told-1"] button')).toBeNull();
  });

  test('hides stopped sessions until "Show stopped" is ticked, and says how many it is hiding', async () => {
    const stopped = sessionView('old-1', {
      config: { teammate: 'ora', label: 'Finished work', cwd: '/work/ferretry' },
      state: { status: 'completed', lastActivityAt: recent },
    });
    const { element } = bar({ sessions: [...SESSIONS, stopped] });
    view = await mount(element);
    const ids = () =>
      [...(view?.container.querySelectorAll('[data-sbar-session]') ?? [])].map(node =>
        node.getAttribute('data-sbar-session'),
      );
    const box = () => view?.container.querySelector<HTMLInputElement>('[data-sbar-show-stopped]') ?? null;
    expect(ids()).not.toContain('old-1');
    expect(box()?.checked).toBe(false);
    expect(view.container.querySelector('[data-sbar-hidden-stopped]')?.textContent).toBe('1');
    expect(view.container.querySelector('[data-sbar-filter="all"] .fy-sbar__count')?.textContent).toBe('3');

    await click(box(), 'Show stopped');
    expect(ids()).toContain('old-1');
    expect(box()?.checked).toBe(true);
    expect(view.container.querySelector('[data-sbar-hidden-stopped]')).toBeNull();
    expect(view.container.querySelector('[data-sbar-filter="all"] .fy-sbar__count')?.textContent).toBe('4');

    await click(box(), 'Show stopped');
    expect(ids()).not.toContain('old-1');
  });

  test('keeps the open session listed even when it has stopped', async () => {
    const stopped = sessionView('hadi-1', {
      config: { teammate: 'hadi', label: 'Done', cwd: '/work/ferretry' },
      state: { status: 'stopped' },
    });
    view = await mount(bar({ sessions: [stopped] }).element);
    expect(view.container.querySelector('[data-sbar-session="hadi-1"]')).not.toBeNull();
    await view.render(bar({ sessions: [stopped], activeSessionId: null }).element);
    expect(view.container.querySelector('[data-sbar-session="hadi-1"]')).toBeNull();
    expect(view.container.querySelector('.fy-sbar__empty')?.textContent).toBe(
      'No live sessions — 1 stopped. Tick Show stopped.',
    );
  });

  test('narrows by kind with live counts, and says plainly when a kind has nothing', async () => {
    const person = sessionView('pat-1', {
      config: { teammate: 'pat', label: 'Pairing', mode: 'interactive', cwd: '/work/ferretry' },
    });
    const { element } = bar({ sessions: [SESSIONS[0] as (typeof SESSIONS)[number], person] });
    view = await mount(element);
    const segment = (id: string) =>
      view?.container.querySelector<HTMLButtonElement>(`[data-sbar-filter="${id}"]`) ?? null;
    const ids = () =>
      [...(view?.container.querySelectorAll('[data-sbar-session]') ?? [])].map(node =>
        node.getAttribute('data-sbar-session'),
      );
    expect(segment('all')?.getAttribute('aria-pressed')).toBe('true');
    expect(['all', 'auto', 'interactive'].map(id => segment(id)?.textContent)).toEqual([
      'All2',
      'Agents1',
      'Interactive1',
    ]);

    await click(segment('interactive'), 'Interactive');
    expect(segment('interactive')?.getAttribute('aria-pressed')).toBe('true');
    expect(ids()).toEqual(['pat-1']);
    // The numbers are what each segment would show, so choosing one leaves the others' alone.
    expect(['all', 'auto', 'interactive'].map(id => segment(id)?.textContent)).toEqual([
      'All2',
      'Agents1',
      'Interactive1',
    ]);

    await click(segment('auto'), 'Agents');
    expect(ids()).toEqual(['hadi-1']);

    await view.render(bar({ sessions: [SESSIONS[0] as (typeof SESSIONS)[number]] }).element);
    await click(segment('interactive'), 'Interactive');
    expect(view.container.textContent).toContain('No interactive sessions.');
  });

  test('opens on Interactive, listed first, until the device remembers another kind', async () => {
    const person = sessionView('pat-1', {
      config: { teammate: 'pat', label: 'Pairing', mode: 'interactive', cwd: '/work/ferretry' },
    });
    const sessions = [SESSIONS[0] as (typeof SESSIONS)[number], person];
    const chosen: string[] = [];
    const segments = () =>
      [...(view?.container.querySelectorAll<HTMLButtonElement>('[data-sbar-filter]') ?? [])].map(node => [
        node.getAttribute('data-sbar-filter'),
        node.getAttribute('aria-pressed'),
      ]);
    const ids = () =>
      [...(view?.container.querySelectorAll('[data-sbar-session]') ?? [])].map(node =>
        node.getAttribute('data-sbar-session'),
      );

    view = await mount(bar({ sessions, initialMode: null, onModeChange: mode => chosen.push(mode) }).element);
    expect(segments()).toEqual([
      ['interactive', 'true'],
      ['all', 'false'],
      ['auto', 'false'],
    ]);
    expect(ids()).toEqual(['pat-1']);

    await click(view.container.querySelector('[data-sbar-filter="auto"]'), 'Agents');
    await click(view.container.querySelector('[data-sbar-show-stopped]'), 'Show stopped');
    await click(view.container.querySelector('[data-sbar-filter="auto"]'), 'Agents');
    expect(chosen).toEqual(['auto']);

    await view.unmount();
    view = await mount(bar({ sessions, initialMode: 'auto' }).element);
    expect(segments()[2]).toEqual(['auto', 'true']);
    expect(ids()).toEqual(['hadi-1']);
  });

  test('says it is still reading, and says plainly when nothing is running', async () => {
    const reading = bar({ sessions: null });
    view = await mount(reading.element);
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Reading sessions…');

    await view.render(bar({ sessions: [] }).element);
    expect(view.container.textContent).toContain('No sessions running.');
  });

  test('leads an empty list with Create a runtime while the machine has none', async () => {
    const { calls, element } = bar({ sessions: [], createRuntimeHref: '#settings/work-mac/runtimes' });
    view = await mount(element);
    expect(view.container.textContent).toContain('nothing can start until this machine has a runtime');
    const link = view.container.querySelector<HTMLElement>('[data-sessions-create-runtime]');
    expect(link?.textContent).toBe('Create a runtime');
    await click(link, 'Create a runtime');
    expect(calls).toContain('navigate:#settings/work-mac/runtimes');
  });

  test('navigates from a row, a foot place and the new-session button', async () => {
    const { calls, element } = bar({ active: 'insights' });
    view = await mount(element);
    await click(view.container.querySelector('[data-sbar-session="maryah-1"]'), 'a session row');
    await click(view.container.querySelector('[data-sbar-place="settings"]'), 'Settings');
    await click(view.container.querySelector('[data-sbar-new]'), 'New session');
    expect(calls).toEqual([
      'navigate:/d/alpha/session/maryah-1?attention=A1',
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

describe('SessionsBar row density', () => {
  const column = (): Element =>
    must(view?.container.querySelector('[data-sessions-bar="column"]') ?? null, 'the column');
  const options = (): Element | null => view?.container.querySelector('[data-sbar-options]') ?? null;
  const items = (): string[] =>
    [...document.querySelectorAll('[role="menuitem"]')].map(
      node => node.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    );

  test('draws one-line rows unless the reader chose Full, on the column and on the drawer', async () => {
    view = await mount(bar().element);
    expect(column().getAttribute('data-sbar-density')).toBe('compact');
    await view.unmount();
    view = await mount(bar({ density: 'full' }).element);
    expect(column().getAttribute('data-sbar-density')).toBe('comfortable');
    await view.unmount();
    view = await mount(bar({ density: 'minimal', presentation: 'drawer' }).element);
    expect(view.container.querySelector('.fy-sbar--drawer')?.getAttribute('data-sbar-density')).toBe('compact');
    await view.unmount();
    view = await mount(bar({ density: 'full', presentation: 'drawer' }).element);
    expect(view.container.querySelector('.fy-sbar--drawer')?.getAttribute('data-sbar-density')).toBe('comfortable');
  });

  test('keeps the ferret and the directory in the row, inside one detail wrapper', async () => {
    view = await mount(bar().element);
    const row = must(view.container.querySelector('[data-sbar-session="hadi-1"]'), 'a row');
    const detail = must(row.querySelector('[data-sbar-detail]'), 'the detail');
    expect(detail.querySelector('[data-sbar-ferret]')).not.toBeNull();
    expect(detail.querySelector('[data-sbar-dir]')).not.toBeNull();
  });

  test('offers the density menu only to a host that can store the choice', async () => {
    view = await mount(bar().element);
    expect(options()).toBeNull();
  });

  test('says which density is in force and writes the one the reader picks', async () => {
    const chosen: string[] = [];
    view = await mount(bar({ onDensityChange: next => chosen.push(next) }).element);
    await click(options(), 'the options button');
    expect(items()).toEqual(['Compactcurrent', 'Comfortable']);
    await click(document.querySelector('[role="menuitem"]:nth-child(2)'), 'Comfortable');
    expect(chosen).toEqual(['full']);
    await view.unmount();

    view = await mount(bar({ density: 'full', onDensityChange: next => chosen.push(next) }).element);
    await click(options(), 'the options button');
    expect(items()).toEqual(['Compact', 'Comfortablecurrent']);
    await click(document.querySelector('[role="menuitem"]:nth-child(1)'), 'Compact');
    expect(chosen).toEqual(['full', 'compact']);
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
    expect(dots.map(dot => dot.getAttribute('aria-label'))).toEqual(['Maryah — 1 open Inbox item', 'nameless', 'Hadi']);
    expect(dots.find(dot => dot.getAttribute('aria-current') === 'page')?.getAttribute('aria-label')).toBe('Hadi');
    expect(view.container.querySelector('[aria-label="Projects"]')?.getAttribute('aria-current')).toBe('page');
    await click(dots[0] ?? null, 'a dot');
    await click(view.container.querySelector('[data-sbar-expand]'), 'Expand');
    await click(view.container.querySelector('[data-app-bar-destination-search]'), 'the finder');
    expect(calls).toEqual(['navigate:/d/alpha/session/maryah-1?attention=A1', 'expand', 'palette']);
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
    expect(calls).toEqual(['navigate:/d/alpha/session/maryah-1?attention=A1']);
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

describe('SessionsBar across every machine', () => {
  const BETA = 'beta' as DaemonId;
  const source = (
    daemonId: DaemonId,
    name: string,
    sessions: MachineSource['slice']['sessions'],
    reach: MachineSource['reach'],
    readAt?: number,
  ): MachineSource => ({
    daemonId,
    name,
    reach,
    projects: [],
    slice: {
      sessions,
      byId: new Map(),
      status: 'ready',
      error: null,
      ...(readAt === undefined ? {} : { readAt }),
    },
  });
  const BETA_SESSIONS = [
    sessionView('hadi-1', { config: { teammate: 'pim', label: 'Same id, other machine', cwd: '/work/site' } }),
    sessionView('ask-1', {
      config: { teammate: 'ora', label: 'A question', cwd: '/work/site' },
      state: {
        status: 'awaiting_question',
        attention: { open: 1, first: 'A1', ask: 'Ask?', latestAt: recent },
      },
    }),
  ];
  const sources = (betaReach: MachineSource['reach'] = 'offline'): readonly MachineSource[] => [
    source(DAEMON, 'work-mac', SESSIONS, 'online'),
    source(BETA, 'kirin-box', BETA_SESSIONS, betaReach, NOW - 5 * 60_000),
  ];

  test('pins what needs the reader with its machine, then lists each machine and greys an offline one', async () => {
    const { element, calls } = bar({ machineSources: sources(), now: NOW, learningPassive: new Set(['hadi-1']) });
    view = await mount(element);
    const pinned = must(view.container.querySelector('[data-sbar-needs-you-group]'), 'Needs you');
    expect(
      [...pinned.querySelectorAll('[data-sbar-session]')].map(node => node.getAttribute('data-sbar-session')),
    ).toEqual(['maryah-1']);
    expect(pinned.querySelector('[data-machine-chip]')?.textContent).toBe('work-mac');
    const heads = [...view.container.querySelectorAll('.fy-sbar__machine-label')].map(node => node.textContent);
    expect(heads).toEqual(['work-mac', 'kirin-box']);
    const offline = must(view.container.querySelector('[data-machine-reach="offline"]'), 'the offline machine');
    expect(offline.querySelector('.fy-sbar__machine-reach')?.textContent).toBe('offline · last seen 5m');
    // The waiting session on the offline machine stays home with its badge.
    expect(offline.querySelector('[data-sbar-session="ask-1"]')).not.toBeNull();
    // An online machine is said to be online without a word on screen.
    expect(view.container.querySelector('[data-sbar-machine-group="alpha"] .sr-only')?.textContent).toBe('online');
    // The same id on two machines: only this machine's is open, and only it reads this machine's learners.
    const twins = [...view.container.querySelectorAll('[data-sbar-session="hadi-1"]')];
    expect(twins.map(node => node.getAttribute('aria-current'))).toEqual(['page', null]);
    expect(twins.map(node => node.querySelector('[data-learning-passive]') !== null)).toEqual([true, false]);
    // A row opens its own machine.
    await click(offline.querySelector('[data-sbar-session="hadi-1"]'), 'the other machine’s row');
    expect(calls.at(-1)).toBe('navigate:/d/beta/session/hadi-1');
    expect(view.container.querySelector('[data-sbar-filter="all"] .fy-sbar__count')?.textContent).toBe('5');
  });

  test('marks each machine’s learners from that machine’s own set, whichever machine is on screen', async () => {
    // "hadi-1" runs on both machines; only the OTHER machine says its own learns.
    const { element } = bar({
      machineSources: sources('online'),
      now: NOW,
      learningPassive: new Set(['maryah-1']),
      machineLearners: new Map([[BETA, new Set(['hadi-1'])]]),
    });
    view = await mount(element);
    const learns = (machine: string, id: string) =>
      view?.container.querySelector(
        `[data-sbar-machine-group="${machine}"] [data-sbar-session="${id}"] [data-learning-passive]`,
      ) !== null;
    expect([learns(DAEMON, 'hadi-1'), learns(BETA, 'hadi-1')]).toEqual([false, true]);
    // A machine missing from the map: the one on screen falls back to its own set, never another's.
    await view.render(
      bar({
        machineSources: sources('online'),
        now: NOW,
        learningPassive: new Set(['hadi-1']),
        machineLearners: new Map(),
      }).element,
    );
    expect([learns(DAEMON, 'hadi-1'), learns(BETA, 'hadi-1')]).toEqual([true, false]);
  });

  test('an online machine pins its own question, and a machine whose sessions all moved says so', async () => {
    const { element } = bar({ machineSources: [source(BETA, 'kirin-box', [BETA_SESSIONS[1]!], 'online')], now: NOW });
    view = await mount(element);
    expect(view.container.querySelector('[data-sbar-needs-you-group] [data-sbar-session="ask-1"]')).not.toBeNull();
    expect(view.container.querySelector('[data-sbar-machine-group="beta"] .fy-sbar__empty')?.textContent).toBe(
      'Everything here is in Needs you.',
    );
  });

  test('says reading until a machine answers, no sessions on an empty one, and nothing matching a chip', async () => {
    view = await mount(bar({ machineSources: [source(DAEMON, 'work-mac', null, 'reading')] }).element);
    expect(view.container.querySelector('.fy-sbar__list [role="status"]')?.textContent).toBe('Reading sessions…');
    await view.render(bar({ machineSources: [source(DAEMON, 'work-mac', [], 'online')] }).element);
    expect(view.container.querySelector('[data-sbar-machine-group] .fy-sbar__empty')?.textContent).toBe('No sessions.');
    await click(view.container.querySelector('[data-sbar-filter="interactive"]'), 'Interactive');
    expect(view.container.querySelector('.fy-sbar__list .fy-sbar__empty')?.textContent).toBe(
      'No interactive sessions.',
    );
  });

  test('filters every machine alike, hides what stopped on either, and the rail follows', async () => {
    const stoppedBeta = sessionView('end-1', {
      config: { teammate: 'ula', label: 'Over', cwd: '/work/site', mode: 'interactive' },
      state: { status: 'completed' },
    });
    const machineSources = [
      source(DAEMON, 'work-mac', SESSIONS, 'online'),
      source(BETA, 'kirin-box', [...BETA_SESSIONS, stoppedBeta], 'online'),
    ];
    view = await mount(bar({ machineSources, now: NOW }).element);
    const rows = () =>
      [...(view?.container.querySelectorAll('[data-sbar-session]') ?? [])].map(node =>
        node.getAttribute('data-sbar-session'),
      );
    expect(rows()).not.toContain('end-1');
    expect(view.container.querySelector('[data-sbar-hidden-stopped]')?.textContent).toBe('1');
    await click(view.container.querySelector('[data-sbar-show-stopped]'), 'Show stopped');
    expect(rows()).toContain('end-1');

    await click(view.container.querySelector('[data-sbar-filter="interactive"]'), 'Interactive');
    expect(rows()).toEqual(['end-1']);
    expect(view.container.querySelectorAll('[data-sbar-machine-group]')).toHaveLength(1);
  });

  test('the rail follows the column’s filter', async () => {
    const stopped = sessionView('old-1', { config: { label: 'Finished' }, state: { status: 'completed' } });
    const { element } = bar({ sessions: [SESSIONS[0] as (typeof SESSIONS)[number], stopped] });
    view = await mount(element);
    await click(view.container.querySelector('[data-sbar-show-stopped]'), 'Show stopped');
    expect(view.container.querySelector('[data-sbar-session="old-1"]')).not.toBeNull();
    await view.render(
      bar({ presentation: 'rail', sessions: [SESSIONS[0] as (typeof SESSIONS)[number], stopped] }).element,
    );
    expect(view.container.querySelectorAll('.fy-sbar__dot')).toHaveLength(2);
  });

  test('"+ New" asks which machine, this one first', async () => {
    const { element, calls } = bar({ machineSources: sources('online') });
    view = await mount(element);
    await click(view.container.querySelector('[data-new-session-menu]'), '+ New');
    const items = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menu"][aria-label="New session on"] [role="menuitem"]'),
    ];
    expect(items.map(item => item.textContent)).toEqual(['work-macthis one', 'kirin-box']);
    await interact(() => items[1]?.click());
    expect(calls.at(-1)).toBe('navigate:/d/beta/new');
  });

  test('one machine keeps the plain link', async () => {
    view = await mount(bar({ machineSources: sources(), machines: [{ daemonId: DAEMON, name: 'work-mac' }] }).element);
    expect(view.container.querySelector('[data-new-session-menu]')).toBeNull();
    expect(view.container.querySelector('[data-sbar-new]')).not.toBeNull();
  });

  test('the rail draws every machine’s dots, Needs you first, each naming its machine', async () => {
    const { element, calls } = bar({
      presentation: 'rail',
      machineSources: sources('online'),
      onExpand: () => undefined,
    });
    view = await mount(element);
    const dots = [...view.container.querySelectorAll('.fy-sbar__dot')];
    expect(dots.map(dot => dot.getAttribute('aria-label'))).toEqual([
      'Ora on kirin-box — 1 open Inbox item',
      'Maryah on work-mac — 1 open Inbox item',
      'Hadi on work-mac',
      'nameless on work-mac',
      'Pim on kirin-box',
    ]);
    expect(dots.map(dot => dot.getAttribute('aria-current'))).toEqual([null, null, 'page', null, null]);
    expect(view.container.querySelector('[data-new-session-menu]')).not.toBeNull();
    await click(dots[0] ?? null, 'a dot');
    expect(calls.at(-1)).toBe('navigate:/d/beta/session/ask-1?attention=A1');
  });
});
