import { afterEach, describe, expect, it } from 'bun:test';
import { daemonId } from '../../src/lib/daemon-connection.ts';
import {
  FleetNavigationRail,
  nextFleetMode,
  type FleetNavigationRailProps,
} from '../../src/shell/fleet-navigation-rail.tsx';
import { interact, mount } from '../support/dom.ts';

const DAEMON = daemonId('workshop');

const setViewport = (width: number): void => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};

const rail = (props: Partial<FleetNavigationRailProps> = {}) => (
  <FleetNavigationRail
    daemon={DAEMON}
    sessionCount={4}
    mode="all"
    modeCounts={{ all: 4, auto: 3, interactive: 1 }}
    rcOnly={false}
    includeFinished={false}
    onExpand={() => {}}
    onSetMode={() => {}}
    onSetRcOnly={() => {}}
    onSetIncludeFinished={() => {}}
    {...props}
  />
);

afterEach(() => {
  setViewport(1_440);
  document.body.replaceChildren();
});

describe('nextFleetMode', () => {
  it('cycles through all, auto, interactive and back to all', () => {
    expect(nextFleetMode('all')).toBe('auto');
    expect(nextFleetMode('auto')).toBe('interactive');
    expect(nextFleetMode('interactive')).toBe('all');
  });
});

describe('FleetNavigationRail', () => {
  it('yields to the AppBar drawer trigger at phone widths', async () => {
    setViewport(390);
    const mounted = await mount(rail());

    expect(mounted.container.textContent).toBe('');
    await mounted.unmount();
  });

  it('builds every navigation link from its daemon rather than an ambient connection', async () => {
    const mounted = await mount(rail());
    const links = [...mounted.container.querySelectorAll('a')];

    expect(links.map(link => link.getAttribute('href'))).toEqual([
      '/d/workshop/new',
      '/d/workshop/warden',
      '/d/workshop/history',
      '/d/workshop/settings',
    ]);

    await mounted.unmount();
  });

  it('keeps the filter controls controlled and labels their next action', async () => {
    const calls: string[] = [];
    const mounted = await mount(
      rail({
        mode: 'auto',
        rcOnly: true,
        includeFinished: true,
        onExpand: () => calls.push('expand'),
        onSetMode: mode => calls.push(`mode:${mode}`),
        onSetRcOnly: value => calls.push(`rc:${value}`),
        onSetIncludeFinished: value => calls.push(`finished:${value}`),
      }),
    );
    const button = (label: string): HTMLButtonElement => {
      const element = mounted.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      if (element === null) throw new Error(`missing ${label}`);
      return element;
    };

    expect(button('Mode filter: Auto sessions (3) — click for Interactive sessions').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(button('Showing Remote Control sessions only — click to show all').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(button('Hide finished sessions').getAttribute('aria-pressed')).toBe('true');

    await interact(() => button('Search and filter the fleet (4 shown) — expands the sidebar').click());
    await interact(() => button('Mode filter: Auto sessions (3) — click for Interactive sessions').click());
    await interact(() => button('Showing Remote Control sessions only — click to show all').click());
    await interact(() => button('Hide finished sessions').click());

    expect(calls).toEqual(['expand', 'mode:interactive', 'rc:false', 'finished:false']);
    await mounted.unmount();
  });

  it('keeps the count bubble beside the themed control so it is not clipped', async () => {
    const mounted = await mount(rail({ sessionCount: 101 }));
    const trigger = mounted.container.querySelector('button[aria-label^="Search and filter"]');

    expect(trigger?.parentElement?.textContent).toContain('99+');
    expect(trigger?.querySelector('[aria-hidden="true"]')?.textContent).not.toContain('99+');
    await mounted.unmount();
  });
});
