import { describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import { daemonId } from '../../src/lib/daemon-connection.ts';
import type { SessionGroup } from '../../src/lib/fleet-grouping.ts';
import { buildLineage } from '../../src/lib/lineage.ts';
import {
  AgentSidebar,
  SIDEBAR_EXPANDED_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  SidebarBody,
  type SidebarFleet,
} from '../../src/shell/agent-sidebar.tsx';
import type { FleetFilterValues } from '../../src/shell/fleet-filters.tsx';
import { interact, mount, must, pressKey } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const alpha = daemonId('alpha');

const filters: FleetFilterValues = { query: '', mode: 'all', rcOnly: false, includeFinished: false };

/** `useLayoutMode` reads the live viewport, so each shape is a width. */
const setWidth = async (width: number): Promise<void> => {
  await interact(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width, writable: true });
    window.dispatchEvent(new Event('resize'));
  });
};

const group = (name: string, path: string, rows: readonly SessionView[]): SessionGroup => ({ name, path, rows });

const fleetOf = (groups: readonly SessionGroup[], overrides: Partial<SidebarFleet> = {}): SidebarFleet => {
  const rows = groups.flatMap(entry => [...entry.rows]);
  return {
    groups,
    lineage: buildLineage(rows),
    byId: new Map(rows.map(view => [view.config.id, view])),
    counts: { all: rows.length, auto: rows.length, interactive: 0 },
    shown: rows.length,
    total: rows.length,
    scope: null,
    ...overrides,
  };
};

const twoFolders = () =>
  fleetOf([
    group('ferretry', '/work/ferretry', [sessionView('s-1')]),
    group('kteam', '/work/kteam', [sessionView('s-2')]),
  ]);

const bodyProps = (fleet: SidebarFleet, overrides: Record<string, unknown> = {}) => ({
  canMutate: true,
  daemonId: alpha,
  filters,
  fleet,
  onFilterChange: () => undefined,
  onFocusFolder: () => undefined,
  ...overrides,
});

describe('SidebarBody', () => {
  test('draws every folder and counts shown against total', async () => {
    const screen = await mount(<SidebarBody {...bodyProps(twoFolders())} />);
    expect(screen.container.querySelectorAll('section').length).toBe(2);
    expect(screen.container.textContent).toContain('2/2');
    expect(must(screen.container.querySelector('a[href$="/new"]'), 'the new-session link')).toBeDefined();
    await screen.unmount();
  });

  test('pins the scoped folder first without reordering the rest', async () => {
    const fleet = twoFolders();
    const screen = await mount(<SidebarBody {...bodyProps({ ...fleet, scope: '/work/kteam' })} />);
    const headings = [...screen.container.querySelectorAll('h3')].map(node => node.textContent ?? '');
    expect(headings[0]).toContain('kteam');
    expect(must(screen.container.querySelector('h3'), 'the pinned heading').getAttribute('aria-current')).toBe('true');
    await screen.unmount();
  });

  test('tells an empty fleet apart from a fleet that the filters emptied', async () => {
    const empty = await mount(<SidebarBody {...bodyProps(fleetOf([]))} />);
    expect(empty.container.textContent).toContain('No sessions yet.');
    await empty.unmount();

    const filtered = await mount(
      <SidebarBody {...bodyProps(fleetOf([], { total: 12, counts: { all: 0, auto: 0, interactive: 0 } }))} />,
    );
    expect(filtered.container.textContent).toContain('No sessions match these filters.');
    await filtered.unmount();
  });

  test('keeps exactly one scroller, and contains its overscroll', async () => {
    const screen = await mount(<SidebarBody {...bodyProps(twoFolders())} />);
    const scrollers = [...screen.container.querySelectorAll('div')].filter(node =>
      node.className.includes('overflow-y-auto'),
    );
    expect(scrollers.length).toBe(1);
    expect(scrollers[0]?.className).toContain('overscroll-contain');
    await screen.unmount();
  });

  test('reports a folder focus and a filter change up to the host', async () => {
    const focused: string[] = [];
    const patches: Partial<FleetFilterValues>[] = [];
    const screen = await mount(
      <SidebarBody
        {...bodyProps(twoFolders(), {
          onFilterChange: (patch: Partial<FleetFilterValues>) => patches.push(patch),
          onFocusFolder: (path: string) => focused.push(path),
        })}
      />,
    );
    await interact(() =>
      must(screen.container.querySelector('h3 button'), 'the folder button').dispatchEvent(
        new Event('click', { bubbles: true }),
      ),
    );
    await interact(() =>
      must(
        [...screen.container.querySelectorAll('button')].find(button => button.textContent?.includes('Auto')),
        'the Auto segment',
      ).dispatchEvent(new Event('click', { bubbles: true })),
    );
    expect(focused).toEqual(['/work/ferretry']);
    expect(patches).toEqual([{ mode: 'auto' }]);
    await screen.unmount();
  });
});

describe('AgentSidebar', () => {
  const sidebarProps = (overrides: Record<string, unknown> = {}) => ({
    ...bodyProps(twoFolders()),
    collapsed: false,
    drawerOpen: false,
    onCloseDrawer: () => undefined,
    onCollapsedChange: () => undefined,
    ...overrides,
  });

  test('is a full column on a desktop viewport, with a way to collapse it', async () => {
    await setWidth(1440);
    const collapses: boolean[] = [];
    const screen = await mount(
      <AgentSidebar {...sidebarProps({ onCollapsedChange: (next: boolean) => collapses.push(next) })} />,
    );
    const nav = must(screen.container.querySelector('nav[aria-label="Fleet sessions"]'), 'the column');
    expect(nav.className).toContain(SIDEBAR_EXPANDED_WIDTH);
    await interact(() =>
      must(
        screen.container.querySelector('[aria-label="Collapse the fleet sidebar to an icon rail"]'),
        'the collapse button',
      ).dispatchEvent(new Event('click', { bubbles: true })),
    );
    expect(collapses).toEqual([true]);
    await screen.unmount();
  });

  test('honours a chosen rail where a full column would have fitted', async () => {
    await setWidth(1440);
    const screen = await mount(<AgentSidebar {...sidebarProps({ collapsed: true, rail: <span data-rail="yes" /> })} />);
    const nav = must(screen.container.querySelector('nav[aria-label="Fleet sessions"]'), 'the rail');
    expect(nav.className).toContain(SIDEBAR_RAIL_WIDTH);
    expect(nav.querySelector('[data-rail="yes"]')).not.toBeNull();
    await screen.unmount();
  });

  test('forces a rail on a mid-width viewport WITHOUT overwriting the preference', async () => {
    await setWidth(900);
    const collapses: boolean[] = [];
    const screen = await mount(
      <AgentSidebar
        {...sidebarProps({ collapsed: false, onCollapsedChange: (next: boolean) => collapses.push(next) })}
      />,
    );
    expect(must(screen.container.querySelector('nav'), 'the rail').className).toContain(SIDEBAR_RAIL_WIDTH);
    // The forced rail must never be written back as a preference.
    expect(collapses).toEqual([]);
    await screen.unmount();

    // Widening brings the untouched expanded preference straight back.
    await setWidth(1440);
    const widened = await mount(<AgentSidebar {...sidebarProps({ collapsed: false })} />);
    expect(must(widened.container.querySelector('nav'), 'the column').className).toContain(SIDEBAR_EXPANDED_WIDTH);
    await widened.unmount();
  });

  test('renders nothing in the layout flow while the drawer is shut', async () => {
    await setWidth(390);
    const screen = await mount(<AgentSidebar {...sidebarProps()} />);
    expect(screen.container.innerHTML).toBe('');
    await screen.unmount();
  });

  test('is a modal drawer with a scrim, a close button and an Escape route', async () => {
    await setWidth(390);
    const closed: string[] = [];
    const screen = await mount(
      <AgentSidebar {...sidebarProps({ drawerOpen: true, onCloseDrawer: () => closed.push('closed') })} />,
    );
    const dialog = must(screen.container.querySelector('[role="dialog"]'), 'the drawer');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Fleet sessions');
    // Both the scrim and the header carry the same labelled dismissal.
    expect(dialog.querySelectorAll('[aria-label="Close the fleet sidebar"]').length).toBe(2);
    expect(dialog.querySelector('nav[aria-label="Destinations"]')).toBeNull();
    expect(dialog.textContent).not.toContain('Warden');
    expect(dialog.textContent).not.toContain('Settings');

    await interact(() => pressKey(dialog, 'Escape'));
    expect(closed).toEqual(['closed']);
    await screen.unmount();
  });

  test('shuts the drawer from the scrim', async () => {
    await setWidth(390);
    const closed: string[] = [];
    const screen = await mount(
      <AgentSidebar {...sidebarProps({ drawerOpen: true, onCloseDrawer: () => closed.push('closed') })} />,
    );
    await interact(() =>
      must(screen.container.querySelector('.bg-scrim'), 'the scrim').dispatchEvent(
        new Event('click', { bubbles: true }),
      ),
    );
    expect(closed).toEqual(['closed']);
    await screen.unmount();
  });

  test('lands a pointer reader in the search box, and a touch reader on the dialog', async () => {
    await setWidth(390);
    const pointer = await mount(<AgentSidebar {...sidebarProps({ drawerOpen: true })} />);
    expect(document.activeElement).toBe(must(pointer.container.querySelector('input[type="text"]'), 'the search box'));
    await pointer.unmount();

    const touch = await mount(<AgentSidebar {...sidebarProps({ drawerOpen: true, touchAffected: true })} />);
    expect(document.activeElement).toBe(must(touch.container.querySelector('[role="dialog"]'), 'the drawer'));
    await touch.unmount();
  });

  test('latches the focus policy for the life of one opening', async () => {
    await setWidth(390);
    const props = sidebarProps({ drawerOpen: true });
    const screen = await mount(<AgentSidebar {...props} />);
    const searchBox = must(screen.container.querySelector('input[type="text"]'), 'the search box');
    expect(document.activeElement).toBe(searchBox);

    // A convertible switching modality mid-use must not yank focus away.
    await screen.render(<AgentSidebar {...props} touchAffected />);
    expect(document.activeElement).toBe(searchBox);
    await screen.unmount();
  });

  test('gives the folder headers the 44px touch floor inside the drawer', async () => {
    await setWidth(390);
    const screen = await mount(<AgentSidebar {...sidebarProps({ drawerOpen: true })} />);
    expect(must(screen.container.querySelector('h3 button'), 'the folder button').className).toContain('min-h-[44px]');
    await screen.unmount();
  });

  test('hosts the row menu and stop confirmation once, in every shape', async () => {
    const layers = <span data-layers="yes" />;
    await setWidth(1440);
    const column = await mount(<AgentSidebar {...sidebarProps({ layers })} />);
    expect(column.container.querySelectorAll('[data-layers="yes"]').length).toBe(1);
    await column.unmount();

    const rail = await mount(<AgentSidebar {...sidebarProps({ collapsed: true, layers })} />);
    expect(rail.container.querySelectorAll('[data-layers="yes"]').length).toBe(1);
    await rail.unmount();

    await setWidth(390);
    const drawer = await mount(<AgentSidebar {...sidebarProps({ drawerOpen: true, layers })} />);
    expect(drawer.container.querySelectorAll('[data-layers="yes"]').length).toBe(1);
    await drawer.unmount();
  });
});
