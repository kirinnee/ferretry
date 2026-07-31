import { afterEach, describe, expect, it } from 'bun:test';
import {
  APP_BAR_DESTINATIONS,
  AppBar,
  type AppBarProps,
  SidebarDrawerTrigger,
  UPDATE_CHIP,
  appBarDestinationForRoute,
  crumbTrail,
  mobileDestinationMenuOpen,
} from '../../src/shell/app-bar.tsx';
import { daemonId } from '../../src/lib/daemon-connection.ts';
import { PALETTE_KEYSHORTCUTS } from '../../src/shell/palette-shortcut.ts';
import { interact, mount } from '../support/dom.ts';

const DAEMON = daemonId('workshop');
const OTHER = daemonId('laptop');

type MediaListener = () => void;

const listeners = new Set<MediaListener>();
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

/**
 * Layout mode is read from `innerWidth`; the reduced-motion query the bottom
 * sheet asks for must keep answering too.
 */
const setViewport = (width: number): void => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({
      matches: false,
      addEventListener: (_: string, listener: MediaListener) => listeners.add(listener),
      removeEventListener: (_: string, listener: MediaListener) => listeners.delete(listener),
    }),
  });
};

const DESKTOP = 1440;
const PHONE = 390;

const bar = (props: Partial<AppBarProps> = {}) => (
  <AppBar
    crumbs={[{ href: '/d/workshop', label: 'Sessions' }, { label: 'Fix flaky test' }]}
    daemon={DAEMON}
    onOpenPalette={() => {}}
    {...props}
  />
);

const linksOf = (container: HTMLElement, navLabel: string): HTMLAnchorElement[] => {
  const nav = [...container.querySelectorAll('nav')].find(
    element => element.getAttribute('aria-label') === navLabel && element.querySelector('a'),
  );
  return nav ? [...nav.querySelectorAll('a')] : [];
};

const byLabel = (label: string): HTMLElement | null => document.querySelector(`[aria-label="${label}"]`);

afterEach(() => {
  listeners.clear();
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
});

describe('mobileDestinationMenuOpen', () => {
  it('opens on open and closes on both dismiss and select', () => {
    expect(mobileDestinationMenuOpen(false, 'open')).toBe(true);
    expect(mobileDestinationMenuOpen(true, 'dismiss')).toBe(false);
    // Selecting commits: the next page is already arriving underneath.
    expect(mobileDestinationMenuOpen(true, 'select')).toBe(false);
  });
});

describe('appBarDestinationForRoute', () => {
  it('marks the app-level destinations and nothing else', () => {
    expect(appBarDestinationForRoute({ kind: 'warden', daemonId: DAEMON })).toBe('warden');
    expect(appBarDestinationForRoute({ kind: 'analytics', daemonId: DAEMON })).toBe('analytics');
    expect(appBarDestinationForRoute({ kind: 'learning', daemonId: DAEMON })).toBe('learning');
    expect(appBarDestinationForRoute({ kind: 'settings', daemonId: DAEMON })).toBe('settings');
    expect(appBarDestinationForRoute({ kind: 'sessions', daemonId: DAEMON })).toBeNull();
    expect(appBarDestinationForRoute({ kind: 'connection-picker' })).toBeNull();
  });
});

describe('AppBar destinations', () => {
  it('scopes every destination to the daemon whose page the bar is on', async () => {
    setViewport(DESKTOP);
    const mounted = await mount(bar());
    const hrefs = linksOf(mounted.container, 'Destinations').map(link => link.getAttribute('href'));

    expect(hrefs).toEqual([
      '/d/workshop/analytics',
      '/d/workshop/warden',
      '/d/workshop/learning',
      '/d/workshop/settings',
    ]);

    // Switching daemons must move every destination with it — this is the
    // multi-daemon rule the single-daemon original could not express.
    await mounted.render(bar({ daemon: OTHER }));

    expect(linksOf(mounted.container, 'Destinations').map(link => link.getAttribute('href'))).toEqual([
      '/d/laptop/analytics',
      '/d/laptop/warden',
      '/d/laptop/learning',
      '/d/laptop/settings',
    ]);

    await mounted.unmount();
  });

  it('marks exactly the active destination as the current page', async () => {
    setViewport(DESKTOP);
    const mounted = await mount(bar({ active: 'warden' }));
    const links = linksOf(mounted.container, 'Destinations');

    expect(links.map(link => link.getAttribute('aria-current'))).toEqual([null, 'page', null, null]);
    expect(links.map(link => link.getAttribute('aria-label'))).toEqual(
      APP_BAR_DESTINATIONS.map(destination => destination.label),
    );

    await mounted.unmount();
  });
});

describe('crumbTrail', () => {
  it('keys by the accumulated path, so a repeated label is still distinct', () => {
    const steps = crumbTrail([{ label: 'kteam' }, { label: 'kteam' }]);

    expect(steps.map(step => step.trail)).toEqual(['kteam', 'kteam kteam']);
    expect(steps.map(step => step.last)).toEqual([false, true]);
  });

  it('has no last crumb at all when there is no breadcrumb', () => {
    expect(crumbTrail([])).toEqual([]);
  });
});

describe('AppBar breadcrumb', () => {
  it('links every crumb but the last, which is the page the reader is on', async () => {
    setViewport(DESKTOP);
    const mounted = await mount(bar());
    const crumbNav = [...mounted.container.querySelectorAll('nav')].find(
      element => element.getAttribute('aria-label') === 'Breadcrumb',
    ) as HTMLElement;

    expect(crumbNav.querySelectorAll('a')).toHaveLength(1);
    expect(crumbNav.querySelector('a')?.getAttribute('href')).toBe('/d/workshop');
    expect(crumbNav.textContent).toContain('Fix flaky test');
    // One separator between two crumbs, never a trailing one.
    expect(crumbNav.textContent?.split('/').length).toBe(2);

    await mounted.unmount();
  });
});

describe('AppBar command palette entry', () => {
  it('is always reachable and declares both live shortcuts', async () => {
    setViewport(PHONE);
    let opened = 0;
    const mounted = await mount(bar({ onOpenPalette: () => (opened += 1) }));
    const search = mounted.container.querySelector('[data-app-bar-search]') as HTMLButtonElement;

    expect(search.getAttribute('aria-keyshortcuts')).toBe(PALETTE_KEYSHORTCUTS);
    expect(search.getAttribute('aria-label')).toBe('Open command palette');

    await interact(() => search.dispatchEvent(new Event('click', { bubbles: true })));

    expect(opened).toBe(1);

    await mounted.unmount();
  });
});

describe('AppBar connection state', () => {
  it('says nothing at all while the stream is open', async () => {
    setViewport(DESKTOP);
    const mounted = await mount(bar({ connectionStatus: 'open' }));

    expect(mounted.container.querySelector('.kt-dot')).toBeNull();

    await mounted.unmount();
  });

  it('is a quiet dot while connecting or reconnecting, never an instruction', async () => {
    setViewport(DESKTOP);
    const mounted = await mount(bar({ connectionStatus: 'connecting' }));

    expect(mounted.container.querySelector('.kt-dot')?.className).toContain('bg-warn');
    expect(mounted.container.textContent).toContain('connecting');

    await mounted.render(bar({ connectionStatus: 'reconnecting' }));

    expect(mounted.container.querySelector('.kt-dot')?.className).toContain('bg-err');
    expect(mounted.container.textContent).toContain('reconnecting');
    expect(mounted.container.textContent).not.toContain('refresh');

    await mounted.unmount();
  });
});

describe('AppBar update chip', () => {
  it('is hidden until there is something to offer', async () => {
    setViewport(DESKTOP);
    const mounted = await mount(bar());

    expect(mounted.container.querySelector('.kt-badge')).toBeNull();

    await mounted.unmount();
  });

  it('offers a reload without ever performing one, and tones recovery as a warning', async () => {
    setViewport(DESKTOP);
    let applied = 0;
    const mounted = await mount(bar({ updateReady: 'update', onApplyUpdate: () => (applied += 1) }));
    const chip = mounted.container.querySelector('.kt-badge') as HTMLButtonElement;

    expect(chip.textContent).toContain(UPDATE_CHIP.update.label);
    expect(chip.getAttribute('title')).toBe(UPDATE_CHIP.update.title);
    expect(chip.getAttribute('data-tone')).toBe('accent');
    expect(chip.getAttribute('aria-live')).toBe('polite');

    await interact(() => chip.dispatchEvent(new Event('click', { bubbles: true })));

    expect(applied).toBe(1);

    await mounted.render(bar({ updateReady: 'recovery' }));
    const recovery = mounted.container.querySelector('.kt-badge') as HTMLButtonElement;

    expect(recovery.getAttribute('data-tone')).toBe('warn');
    // The recovery title names no cause, because the chip cannot tell them apart.
    expect(recovery.getAttribute('title')).not.toContain('version');

    await mounted.unmount();
  });

  it('tolerates a chip with no handler, because the offer is still true', async () => {
    setViewport(DESKTOP);
    const mounted = await mount(bar({ updateReady: 'recovery' }));

    await interact(() =>
      (mounted.container.querySelector('.kt-badge') as HTMLButtonElement).dispatchEvent(
        new Event('click', { bubbles: true }),
      ),
    );

    await mounted.unmount();
  });
});

describe('AppBar theme slot', () => {
  it('shows the theme control on desktop and hides it behind Settings on a phone', async () => {
    setViewport(DESKTOP);
    const mounted = await mount(bar({ themeToggle: <span data-theme-toggle="" /> }));

    expect(mounted.container.querySelector('[data-theme-toggle]')).not.toBeNull();

    await mounted.unmount();

    setViewport(PHONE);
    const phone = await mount(bar({ themeToggle: <span data-theme-toggle="" /> }));

    expect(phone.container.querySelector('[data-theme-toggle]')).toBeNull();

    await phone.unmount();
  });
});

describe('AppBar phone destination selector', () => {
  it('replaces the desktop tab group with a real modal selector', async () => {
    setViewport(DESKTOP);
    const desktop = await mount(bar());

    expect(byLabel('Choose destination')).toBeNull();

    await desktop.unmount();

    setViewport(PHONE);
    const mounted = await mount(bar());
    const trigger = byLabel('Choose destination') as HTMLButtonElement;

    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await interact(() => trigger.dispatchEvent(new Event('click', { bubbles: true })));

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(trigger.getAttribute('aria-controls') as string)).not.toBeNull();

    await mounted.unmount();
  });

  it('closes the selector when a destination is picked and when it is dismissed', async () => {
    setViewport(PHONE);
    const mounted = await mount(bar());
    const trigger = byLabel('Choose destination') as HTMLButtonElement;

    await interact(() => trigger.dispatchEvent(new Event('click', { bubbles: true })));
    const sheet = document.getElementById(trigger.getAttribute('aria-controls') as string) as HTMLElement;
    const picked = [...sheet.querySelectorAll('a')].find(
      link => link.getAttribute('href') === '/d/workshop/settings',
    ) as HTMLAnchorElement;

    // A plain left click navigates AND closes the menu.
    const click = new Event('click', { bubbles: true, cancelable: true });
    Object.assign(click, { button: 0 });
    await interact(() => picked.dispatchEvent(click));

    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    await interact(() => trigger.dispatchEvent(new Event('click', { bubbles: true })));

    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    const dismiss = [...sheet.querySelectorAll('button')].find(
      button => button.textContent?.trim() === 'Dismiss',
    ) as HTMLButtonElement;
    await interact(() => dismiss.dispatchEvent(new Event('click', { bubbles: true })));

    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    await mounted.unmount();
  });
});

describe('SidebarDrawerTrigger', () => {
  it('renders only at drawer widths, where no permanent column fits', async () => {
    setViewport(DESKTOP);
    const desktop = await mount(bar({ onOpenSidebar: () => {}, sessionCount: 7 }));

    expect(byLabel('Open the fleet sidebar')).toBeNull();

    await desktop.unmount();

    setViewport(PHONE);
    let opened = 0;
    const mounted = await mount(bar({ onOpenSidebar: () => (opened += 1), sessionCount: 7 }));
    const trigger = byLabel('Open the fleet sidebar') as HTMLButtonElement;

    expect(trigger.textContent).toContain('7');

    await interact(() => trigger.dispatchEvent(new Event('click', { bubbles: true })));

    expect(opened).toBe(1);

    await mounted.unmount();
  });

  it('is absent entirely on destinations that have no fleet sidebar', async () => {
    setViewport(PHONE);
    const mounted = await mount(bar());

    expect(byLabel('Open the fleet sidebar')).toBeNull();

    await mounted.unmount();
  });

  it('reports zero rather than nothing when the fleet is empty', async () => {
    setViewport(PHONE);
    const mounted = await mount(<SidebarDrawerTrigger onOpen={() => {}} sessionCount={0} />);

    expect(mounted.container.textContent).toContain('0');

    await mounted.unmount();
  });
});
