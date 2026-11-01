import { afterEach, describe, expect, it } from 'bun:test';
import { daemonId } from '../../src/lib/daemon-connection.ts';
import {
  APP_BAR_DESTINATIONS,
  APP_NAVIGATION,
  AppBar,
  type AppBarProps,
  AppTabBar,
  type AppTabBarProps,
  appBarDestinationForRoute,
  appBarTitle,
  crumbTrail,
  INSIGHTS_PLACES,
  MORE_PLACES,
  TAB_BAR_PLACES,
  mobileDestinationMenuOpen,
  SESSIONS_ENTRY,
  SidebarDrawerTrigger,
  showsTabBar,
  UPDATE_CHIP,
} from '../../src/shell/app-bar.tsx';
import { PALETTE_KEYSHORTCUTS, paletteShortcutLabel } from '../../src/shell/palette-shortcut.ts';
import { interact, mount } from '../support/dom.ts';

const DAEMON = daemonId('workshop');
const OTHER = daemonId('laptop');

type MediaListener = () => void;

const listeners = new Set<MediaListener>();
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
const originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');

/**
 * Layout mode is read from `innerWidth`; the reduced-motion query the bottom
 * sheet asks for must keep answering too. Both are process-wide globals, so
 * both are handed back in teardown — see the `afterEach` below.
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

/**
 * bun runs every suite in ONE process, so a width left behind here is a width
 * the next file renders at. The last case in this file is a phone case; without
 * this restore, the file that follows sees 390px and its desktop-only chrome
 * (a dashboard view switch, a permanent sidebar) is simply absent.
 */
afterEach(() => {
  listeners.clear();
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
  if (originalInnerWidth) Object.defineProperty(window, 'innerWidth', originalInnerWidth);
  else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'innerWidth');
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
    expect(appBarDestinationForRoute({ kind: 'projects', daemonId: DAEMON })).toBe('projects');
    expect(appBarDestinationForRoute({ kind: 'warden', daemonId: DAEMON })).toBe('warden');
    expect(appBarDestinationForRoute({ kind: 'analytics', daemonId: DAEMON })).toBe('analytics');
    expect(appBarDestinationForRoute({ kind: 'learning', daemonId: DAEMON })).toBe('learning');
    expect(appBarDestinationForRoute({ kind: 'sharing', daemonId: DAEMON })).toBe('sharing');
    expect(appBarDestinationForRoute({ kind: 'sharing', daemonId: DAEMON, tab: 'people' })).toBe('sharing');
    expect(appBarDestinationForRoute({ kind: 'settings', daemonId: DAEMON })).toBe('settings');
    expect(appBarDestinationForRoute({ kind: 'connection-picker' })).toBeNull();
    expect(appBarDestinationForRoute({ kind: 'imported-history', daemonId: DAEMON })).toBeNull();
  });

  it('marks the Agenda inbox as its own place', () => {
    expect(appBarDestinationForRoute({ kind: 'attention', daemonId: DAEMON })).toBe('attention');
    expect(showsTabBar({ kind: 'attention', daemonId: DAEMON })).toBe(true);
  });

  it('files the Board, and a card opened on it, under Board', () => {
    expect(appBarDestinationForRoute({ kind: 'board', daemonId: DAEMON })).toBe('board');
    expect(appBarDestinationForRoute({ kind: 'board', daemonId: DAEMON, taskId: 'F12' })).toBe('board');
  });

  it('files a session, and starting one, under Sessions, and a project under Projects', () => {
    expect(appBarDestinationForRoute({ kind: 'sessions', daemonId: DAEMON })).toBe('sessions');
    expect(appBarDestinationForRoute({ kind: 'session', daemonId: DAEMON, sessionId: 'abc' })).toBe('sessions');
    expect(appBarDestinationForRoute({ kind: 'new-session', daemonId: DAEMON })).toBe('sessions');
    expect(appBarDestinationForRoute({ kind: 'project-detail', daemonId: DAEMON, projectId: 'p-1' })).toBe('projects');
  });
});

describe('showsTabBar', () => {
  it('hides the phone bottom bar inside a session, where the composer owns the bottom of the screen', () => {
    expect(showsTabBar({ kind: 'session', daemonId: DAEMON, sessionId: 'abc' })).toBe(false);
    expect(showsTabBar({ kind: 'new-session', daemonId: DAEMON })).toBe(false);
  });

  it('shows it everywhere else', () => {
    expect(showsTabBar({ kind: 'sessions', daemonId: DAEMON })).toBe(true);
    expect(showsTabBar({ kind: 'projects', daemonId: DAEMON })).toBe(true);
    expect(showsTabBar({ kind: 'settings', daemonId: DAEMON })).toBe(true);
    expect(showsTabBar({ kind: 'connection-picker' })).toBe(true);
  });
});

describe('APP_NAVIGATION', () => {
  it('names Sessions first, then the app destinations, with no place twice', () => {
    expect(APP_NAVIGATION[0]).toBe(SESSIONS_ENTRY);
    expect(APP_NAVIGATION.slice(1)).toEqual([...APP_BAR_DESTINATIONS]);
    expect(APP_NAVIGATION.map(place => place.id)).toEqual([
      'sessions',
      'attention',
      'board',
      'projects',
      'sharing',
      'analytics',
      'warden',
      'learning',
      'settings',
    ]);
    expect(SESSIONS_ENTRY.path(DAEMON)).toBe('/d/workshop/sessions');
  });

  it('puts every place either on the phone bar or under More, never both', () => {
    expect(TAB_BAR_PLACES).toEqual(['sessions', 'attention', 'board']);
    expect(MORE_PLACES).toEqual(['projects', 'sharing', 'analytics', 'warden', 'learning', 'settings']);
    expect([...TAB_BAR_PLACES, ...MORE_PLACES].sort()).toEqual(APP_NAVIGATION.map(place => place.id).sort());
  });
});

describe('AppBar destinations', () => {
  it('scopes every destination to the daemon whose page the bar is on', async () => {
    setViewport(DESKTOP);
    const mounted = await mount(bar());
    const hrefs = linksOf(mounted.container, 'Destinations').map(link => link.getAttribute('href'));

    expect(hrefs).toEqual([
      '/d/workshop/sessions',
      '/d/workshop/inbox',
      '/d/workshop/board',
      '/d/workshop/projects',
      '/d/workshop/sharing',
      '/d/workshop/analytics',
      '/d/workshop/warden',
      '/d/workshop/learning',
      '/d/workshop/settings',
    ]);

    // ACCOUNTS IS DELIBERATELY ABSENT, asserted rather than left to a diff. It was a top-level
    // destination while everything it shows belongs to one daemon; it is Fleet's child panel inside
    // that daemon's own settings now, and Fleet has never been a destination here either. The row is
    // gone rather than pointed at a path the router no longer resolves.
    expect(hrefs.some(href => href?.endsWith('/accounts') === true)).toBe(false);

    // Switching daemons must move every destination with it — this is the
    // multi-daemon rule the single-daemon original could not express.
    await mounted.render(bar({ daemon: OTHER }));

    expect(linksOf(mounted.container, 'Destinations').map(link => link.getAttribute('href'))).toEqual([
      '/d/laptop/sessions',
      '/d/laptop/inbox',
      '/d/laptop/board',
      '/d/laptop/projects',
      '/d/laptop/sharing',
      '/d/laptop/analytics',
      '/d/laptop/warden',
      '/d/laptop/learning',
      '/d/laptop/settings',
    ]);

    await mounted.unmount();
  });

  it('draws them as plain text links, marking exactly the active one as the current page', async () => {
    setViewport(DESKTOP);
    const mounted = await mount(bar({ active: 'warden' }));
    const links = linksOf(mounted.container, 'Destinations');

    expect(links.map(link => link.getAttribute('aria-current'))).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      'page',
      null,
      null,
    ]);
    expect(links.map(link => link.textContent)).toEqual(APP_NAVIGATION.map(destination => destination.label));
    expect(links.map(link => link.getAttribute('data-app-nav'))).toEqual(APP_NAVIGATION.map(place => place.id));
    expect(links.map(link => link.getAttribute('title'))).toEqual(APP_NAVIGATION.map(place => place.title));
    expect(links.every(link => link.className === 'kt-appnav__link')).toBe(true);

    await mounted.render(bar({ active: 'sessions' }));
    expect(
      linksOf(mounted.container, 'Destinations').map(link => link.getAttribute('aria-current') === 'page'),
    ).toEqual([true, false, false, false, false, false, false, false, false]);

    await mounted.unmount();
  });

  it('badges Attention in the wide row with the same count, and only Attention', async () => {
    setViewport(DESKTOP);
    const mounted = await mount(bar({ agendaCount: 12 }));
    const agenda = linksOf(mounted.container, 'Destinations').find(
      link => link.getAttribute('data-app-nav') === 'attention',
    ) as HTMLAnchorElement;

    expect(agenda.querySelector('.fy-unread-badge [aria-hidden="true"]')?.textContent).toBe('12');
    expect(agenda.textContent).toBe('Inbox1212 open Inbox items');
    expect(mounted.container.querySelectorAll('.fy-unread-badge')).toHaveLength(1);

    await mounted.render(bar());
    expect(mounted.container.querySelector('.fy-unread-badge')).toBeNull();

    await mounted.unmount();
  });

  it('commits a plain click through the host navigation', async () => {
    setViewport(DESKTOP);
    const visited: string[] = [];
    const mounted = await mount(bar({ onNavigate: to => visited.push(to) }));
    const settings = mounted.container.querySelector('[data-app-nav="settings"]') as HTMLAnchorElement;

    const click = new Event('click', { bubbles: true, cancelable: true });
    Object.assign(click, { button: 0 });
    await interact(() => settings.dispatchEvent(click));

    expect(visited).toEqual(['/d/workshop/settings']);

    await mounted.unmount();
  });

  it('groups app destinations away from identity and the centred session-search seam', async () => {
    setViewport(DESKTOP);
    const mounted = await mount(bar());
    const primary = mounted.container.querySelector('[data-app-bar-primary]') as HTMLElement;
    const destinationRow = mounted.container.querySelector('[data-app-bar-destination-row]') as HTMLElement;
    const destinationNav = [...destinationRow.querySelectorAll('nav')].find(
      element => element.getAttribute('aria-label') === 'Destinations',
    ) as HTMLElement;

    expect(primary.querySelector('nav[aria-label="Breadcrumb"]')).not.toBeNull();
    expect(primary.querySelector('nav[aria-label="Destinations"]')).toBeNull();
    expect(destinationNav.querySelectorAll('a')).toHaveLength(APP_NAVIGATION.length);
    // Find is a search box at the end of the same row, beside the links rather than one of them.
    expect(destinationNav.querySelector('[data-app-bar-destination-search]')).toBeNull();
    const finder = destinationRow.querySelector('[data-app-bar-destination-search]') as HTMLButtonElement;
    expect(finder.className).toBe('kt-findbox');
    expect(finder.textContent).toContain('Search');
    expect(primary.querySelector('[data-app-bar-destination-search]')).toBeNull();

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
  it('lives with desktop destinations rather than impersonating current-session search', async () => {
    setViewport(DESKTOP);
    let opened = 0;
    const mounted = await mount(bar({ onOpenPalette: () => (opened += 1) }));
    const finder = mounted.container.querySelector('[data-app-bar-destination-search]') as HTMLButtonElement;
    const slot = mounted.container.querySelector('[data-app-bar-session-search-slot]') as HTMLElement;

    expect(finder.getAttribute('aria-keyshortcuts')).toBe(PALETTE_KEYSHORTCUTS);
    expect(finder.getAttribute('aria-label')).toBe('Find app destinations, settings & sessions');
    expect(finder.querySelector('kbd')?.textContent).toBe(paletteShortcutLabel());
    expect(slot.contains(finder)).toBe(false);

    await interact(() => finder.dispatchEvent(new Event('click', { bubbles: true })));

    expect(opened).toBe(1);

    await mounted.unmount();
  });

  it('keeps a Find button in the phone top bar when no bottom bar is under the page', async () => {
    setViewport(PHONE);
    let opened = 0;
    const mounted = await mount(bar({ onOpenPalette: () => (opened += 1) }));
    const primary = mounted.container.querySelector('[data-app-bar-primary]') as HTMLElement;
    const finder = primary.querySelector('[data-app-bar-destination-search]') as HTMLButtonElement;

    expect(finder.getAttribute('aria-label')).toBe('Find app destinations, settings & sessions');
    expect(finder.getAttribute('data-variant')).toBe('ghost');
    // On a phone the desktop row is not drawn at all, so this is the only Find.
    expect(mounted.container.querySelectorAll('[data-app-bar-destination-search]')).toHaveLength(1);
    expect(mounted.container.querySelector('[data-app-bar-destination-row]')).toBeNull();

    await interact(() => finder.dispatchEvent(new Event('click', { bubbles: true })));

    expect(opened).toBe(1);

    await mounted.unmount();
  });

  it('leaves Find to the bottom bar when the bottom bar is shown', async () => {
    setViewport(PHONE);
    const mounted = await mount(bar({ tabBarShown: true }));

    expect(mounted.container.querySelector('[data-app-bar-destination-search]')).toBeNull();

    await mounted.unmount();
  });
});

describe('AppBar current-session search seam', () => {
  it('reserves a centred slot without rendering a fake search', async () => {
    setViewport(DESKTOP);
    const mounted = await mount(bar());
    const primary = mounted.container.querySelector('[data-app-bar-primary]') as HTMLElement;
    const slot = mounted.container.querySelector('[data-app-bar-session-search-slot]') as HTMLElement;

    expect(primary.className).toContain('md:grid-cols-[minmax(0,1fr)_minmax(16rem,34rem)_minmax(0,1fr)]');
    expect(primary.className).toContain('py-md');
    expect(slot.className).toContain('justify-center');
    // Only the phone's page title, which the stylesheet hides wherever the breadcrumb shows.
    expect([...slot.children].map(child => child.getAttribute('data-app-bar-title'))).toEqual(['']);
    expect(slot.querySelector('button, input')).toBeNull();

    await mounted.unmount();
  });

  it("names the page in the slot below 480px, where the breadcrumb is hidden: the trail's last crumb", async () => {
    setViewport(PHONE);
    const mounted = await mount(bar());
    const title = mounted.container.querySelector('[data-app-bar-title]') as HTMLElement;
    expect(title.textContent).toBe('Fix flaky test');
    expect(title.className).toContain('min-[480px]:hidden');
    await mounted.unmount();

    const bare = await mount(bar({ crumbs: [] }));
    expect(bare.container.querySelector('[data-app-bar-title]')).toBeNull();
    await bare.unmount();
  });

  it('mounts item 6 in the reserved slot without moving app destinations', async () => {
    setViewport(DESKTOP);
    const mounted = await mount(bar({ currentSessionSearch: <input aria-label="Current session search" /> }));
    const slot = mounted.container.querySelector('[data-app-bar-session-search-slot]') as HTMLElement;
    const search = byLabel('Current session search') as HTMLInputElement;
    const destinations = linksOf(mounted.container, 'Destinations');
    const finder = mounted.container.querySelector('[data-app-bar-destination-search]') as HTMLButtonElement;

    expect(slot.contains(search)).toBe(true);
    expect(destinations).toHaveLength(APP_NAVIGATION.length);
    expect(destinations.every(link => !slot.contains(link))).toBe(true);
    expect(finder.getAttribute('aria-keyshortcuts')).not.toBeNull();
    expect(finder.textContent).toContain(paletteShortcutLabel());

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

  it('gives transient phone state a separate full-width row', async () => {
    setViewport(PHONE);
    const mounted = await mount(bar({ connectionStatus: 'reconnecting', updateReady: 'update' }));
    const primary = mounted.container.querySelector('[data-app-bar-primary]') as HTMLElement;
    const status = mounted.container.querySelector('[data-app-bar-status]') as HTMLElement;

    expect(primary.contains(status)).toBe(false);
    expect(status.className).toContain('min-h-control');
    expect(status.className).toContain('py-xs');
    expect(status.textContent).toContain('reconnecting');
    expect(status.textContent).toContain(UPDATE_CHIP.update.label);

    await mounted.unmount();
  });
});

describe('AppBar theme slot', () => {
  it('shows the theme quick switch top-right on desktop and on a phone, after the Find button', async () => {
    setViewport(DESKTOP);
    const mounted = await mount(bar({ themeToggle: <span data-theme-toggle="" /> }));

    expect(mounted.container.querySelector('[data-theme-toggle]')).not.toBeNull();

    await mounted.unmount();

    setViewport(PHONE);
    const phone = await mount(bar({ themeToggle: <span data-theme-toggle="" /> }));

    const end = phone.container.querySelector('[data-app-bar-primary]')?.lastElementChild;
    expect(end?.lastElementChild?.matches('[data-theme-toggle]')).toBe(true);

    await phone.unmount();
  });
});

describe('AppBar on a phone', () => {
  it('has no destination selector of its own: the bottom bar carries the places', async () => {
    setViewport(PHONE);
    const mounted = await mount(bar({ active: 'settings' }));
    const header = mounted.container.querySelector('header') as HTMLElement;

    expect(byLabel('Choose destination')).toBeNull();
    expect(linksOf(mounted.container, 'Destinations')).toEqual([]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // A sheet nested under this header would be trapped below the page by a stacking context.
    expect(header.className).not.toMatch(/backdrop|filter|transform/u);

    await mounted.unmount();
  });
});

const tabBar = (props: Partial<AppTabBarProps> = {}) => (
  <AppTabBar daemon={DAEMON} onOpenPalette={() => {}} {...props} />
);

const primaryClick = (): Event => {
  const click = new Event('click', { bubbles: true, cancelable: true });
  Object.assign(click, { button: 0 });
  return click;
};

describe('AppTabBar', () => {
  it('shows Sessions, Inbox, Board, Find and More, in that order, scoped to the daemon', async () => {
    setViewport(PHONE);
    const mounted = await mount(tabBar());
    const nav = mounted.container.querySelector('[data-app-tab-bar]') as HTMLElement;

    expect(nav.getAttribute('aria-label')).toBe('App');
    expect([...nav.querySelectorAll('[data-app-tab]')].map(item => item.getAttribute('data-app-tab'))).toEqual([
      'sessions',
      'attention',
      'board',
      'find',
      'more',
    ]);
    expect([...nav.querySelectorAll('[data-app-tab]')].map(item => item.textContent)).toEqual([
      'Sessions',
      'Inbox',
      'Board',
      'Find',
      'More',
    ]);
    expect([...nav.querySelectorAll('a')].map(link => link.getAttribute('href'))).toEqual([
      '/d/workshop/sessions',
      '/d/workshop/inbox',
      '/d/workshop/board',
    ]);

    await mounted.render(tabBar({ daemon: OTHER }));
    expect([...nav.querySelectorAll('a')].map(link => link.getAttribute('href'))).toEqual([
      '/d/laptop/sessions',
      '/d/laptop/inbox',
      '/d/laptop/board',
    ]);

    await mounted.unmount();
  });

  it('marks the current place, and marks More when the current place is under it', async () => {
    setViewport(PHONE);
    const mounted = await mount(tabBar({ active: 'board' }));
    const current = (): (string | null)[] =>
      [...mounted.container.querySelectorAll('[data-app-tab]')].map(item => item.getAttribute('aria-current'));

    expect(current()).toEqual([null, null, 'page', null, null]);

    for (const under of ['warden', 'projects', 'settings'] as const) {
      await mounted.render(tabBar({ active: under }));
      expect(current()).toEqual([null, null, null, null, 'page']);
    }

    await mounted.render(tabBar({ active: 'attention' }));
    expect(current()).toEqual([null, 'page', null, null, null]);

    await mounted.render(tabBar());
    expect(current()).toEqual([null, null, null, null, null]);

    await mounted.unmount();
  });

  it('leaves the screen to the keyboard: the bar hides and its More sheet closes', async () => {
    setViewport(PHONE);
    const mounted = await mount(tabBar());
    const nav = mounted.container.querySelector('[data-app-tab-bar]') as HTMLElement;
    const more = mounted.container.querySelector('[data-app-tab="more"]') as HTMLButtonElement;
    // The stylesheet hides `data-kb-hide` while <html data-keyboard="open">.
    expect(nav.hasAttribute('data-kb-hide')).toBe(true);

    await interact(() => more.dispatchEvent(new Event('click', { bubbles: true })));
    expect(more.getAttribute('aria-expanded')).toBe('true');

    try {
      await interact(() => document.documentElement.setAttribute('data-keyboard', 'open'));
      expect(more.getAttribute('aria-expanded')).toBe('false');
    } finally {
      document.documentElement.removeAttribute('data-keyboard');
    }

    await mounted.unmount();
  });

  it('badges the Agenda tab with the open count, says it in words, and draws nothing at zero', async () => {
    setViewport(PHONE);
    const mounted = await mount(tabBar({ agendaCount: 3 }));
    const tab = (): HTMLAnchorElement =>
      mounted.container.querySelector('[data-app-tab="attention"]') as HTMLAnchorElement;
    const badge = (): HTMLElement | null => tab().querySelector('[data-unread-badge] [aria-hidden="true"]');

    expect(tab().getAttribute('href')).toBe('/d/workshop/inbox');
    expect(badge()?.textContent).toBe('3');
    expect(badge()?.getAttribute('aria-hidden')).toBe('true');
    expect(tab().textContent).toBe('33 open Inbox itemsInbox');

    await mounted.render(tabBar({ agendaCount: 250 }));
    expect(badge()?.textContent).toBe('99+');
    expect(tab().textContent).toContain('250 open Inbox items');

    await mounted.render(tabBar({ agendaCount: 0 }));
    expect(badge()).toBeNull();
    expect(tab().textContent).toBe('Inbox');

    // No other tab ever carries the badge.
    await mounted.render(tabBar({ agendaCount: 5 }));
    expect(mounted.container.querySelectorAll('[data-unread-badge]')).toHaveLength(1);

    await mounted.unmount();
  });

  it('badges the Board tab with the cards that need the owner, in words, and draws nothing at zero', async () => {
    setViewport(PHONE);
    const mounted = await mount(tabBar({ boardCount: 4 }));
    const tab = (): HTMLAnchorElement => mounted.container.querySelector('[data-app-tab="board"]') as HTMLAnchorElement;
    const badge = (): HTMLElement | null => tab().querySelector('[data-unread-badge] [aria-hidden="true"]');

    expect(tab().getAttribute('href')).toBe('/d/workshop/board');
    expect(badge()?.textContent).toBe('4');
    expect(tab().textContent).toContain('4 board cards need you');

    await mounted.render(tabBar({ boardCount: 1 }));
    expect(tab().textContent).toContain('1 board card needs you');

    await mounted.render(tabBar({ boardCount: 0 }));
    expect(badge()).toBeNull();
    expect(tab().textContent).toBe('Board');

    // The Board's number never lands on another tab, and the Inbox keeps its own.
    await mounted.render(tabBar({ boardCount: 7, agendaCount: 2 }));
    expect(mounted.container.querySelectorAll('[data-unread-badge]')).toHaveLength(2);
    expect(mounted.container.querySelector('[data-app-tab="attention"] [data-unread-badge]')?.textContent).toContain(
      '2',
    );

    await mounted.unmount();
  });

  it('opens the palette from Find', async () => {
    setViewport(PHONE);
    let opened = 0;
    const mounted = await mount(tabBar({ onOpenPalette: () => (opened += 1) }));
    const find = mounted.container.querySelector('[data-app-tab="find"]') as HTMLButtonElement;

    expect(find.getAttribute('aria-label')).toBe('Find app destinations, settings & sessions');
    await interact(() => find.dispatchEvent(new Event('click', { bubbles: true })));

    expect(opened).toBe(1);

    await mounted.unmount();
  });

  it('navigates a bar place through the host', async () => {
    setViewport(PHONE);
    const visited: string[] = [];
    const mounted = await mount(tabBar({ onNavigate: to => visited.push(to) }));
    const board = mounted.container.querySelector('[data-app-tab="board"]') as HTMLAnchorElement;

    await interact(() => board.dispatchEvent(primaryClick()));

    expect(visited).toEqual(['/d/workshop/board']);

    await mounted.unmount();
  });

  it('opens More as a sheet of Projects, Sharing, Analytics, Warden, Learning and Settings, and closes it on a pick', async () => {
    setViewport(PHONE);
    const visited: string[] = [];
    const mounted = await mount(tabBar({ active: 'learning', onNavigate: to => visited.push(to) }));
    const more = mounted.container.querySelector('[data-app-tab="more"]') as HTMLButtonElement;

    expect(more.getAttribute('aria-haspopup')).toBe('dialog');
    expect(more.getAttribute('aria-expanded')).toBe('false');

    await interact(() => more.dispatchEvent(new Event('click', { bubbles: true })));

    expect(more.getAttribute('aria-expanded')).toBe('true');
    const sheet = document.getElementById(more.getAttribute('aria-controls') as string) as HTMLElement;
    expect(sheet.getAttribute('role')).toBe('dialog');
    const rows = [...sheet.querySelectorAll('[data-app-more]')] as HTMLAnchorElement[];
    expect(rows.map(row => row.getAttribute('data-app-more'))).toEqual([
      'projects',
      'sharing',
      'analytics',
      'warden',
      'learning',
      'settings',
    ]);
    expect(rows.map(row => row.getAttribute('href'))).toEqual([
      '/d/workshop/projects',
      '/d/workshop/sharing',
      '/d/workshop/analytics',
      '/d/workshop/warden',
      '/d/workshop/learning',
      '/d/workshop/settings',
    ]);
    expect(rows.map(row => row.getAttribute('aria-current'))).toEqual([null, null, null, null, 'page', null]);
    expect(rows[1]?.textContent).toContain('Sharing');
    expect(rows[3]?.textContent).toContain('Open fleet supervision and verdicts');

    await interact(() => rows[3]?.dispatchEvent(primaryClick()));

    expect(visited).toEqual(['/d/workshop/warden']);
    expect(more.getAttribute('aria-expanded')).toBe('false');

    await mounted.unmount();
  });

  it('offers What’s new in More when the shell has a door, closes the sheet and opens the notes', async () => {
    setViewport(PHONE);
    let opened = 0;
    const mounted = await mount(tabBar({ whatsNew: { open: () => (opened += 1), unread: true } }));
    const more = mounted.container.querySelector('[data-app-tab="more"]') as HTMLButtonElement;
    await interact(() => more.dispatchEvent(new Event('click', { bubbles: true })));
    const sheet = document.getElementById(more.getAttribute('aria-controls') as string) as HTMLElement;
    const row = sheet.querySelector('[data-app-more-whats-new]') as HTMLButtonElement;
    expect(row.textContent).toContain('What’s new');
    expect(row.querySelector('[data-app-more-whats-new-unread]')?.textContent).toBe('New');

    await interact(() => row.dispatchEvent(new Event('click', { bubbles: true })));

    expect(opened).toBe(1);
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await mounted.unmount();
  });

  it('lists What’s new in More without a New badge once it has been read, and not at all without a door', async () => {
    setViewport(PHONE);
    let mounted = await mount(tabBar({ whatsNew: { open: () => {}, unread: false } }));
    let more = mounted.container.querySelector('[data-app-tab="more"]') as HTMLButtonElement;
    await interact(() => more.dispatchEvent(new Event('click', { bubbles: true })));
    expect(document.querySelector('[data-app-more-whats-new]')).not.toBeNull();
    expect(document.querySelector('[data-app-more-whats-new-unread]')).toBeNull();
    await mounted.unmount();

    mounted = await mount(tabBar());
    more = mounted.container.querySelector('[data-app-tab="more"]') as HTMLButtonElement;
    await interact(() => more.dispatchEvent(new Event('click', { bubbles: true })));
    expect(document.querySelector('[data-app-more-whats-new]')).toBeNull();
    await mounted.unmount();
  });

  it('closes More when it is dismissed without a pick', async () => {
    setViewport(PHONE);
    const mounted = await mount(tabBar());
    const more = mounted.container.querySelector('[data-app-tab="more"]') as HTMLButtonElement;

    await interact(() => more.dispatchEvent(new Event('click', { bubbles: true })));
    expect(more.getAttribute('aria-expanded')).toBe('true');

    const dismiss = document.querySelector('[aria-label="Dismiss more places"]') as HTMLButtonElement;
    await interact(() => dismiss.dispatchEvent(new Event('click', { bubbles: true })));

    expect(more.getAttribute('aria-expanded')).toBe('false');

    await mounted.unmount();
  });

  it('follows a More pick with no host navigation, still closing the sheet', async () => {
    setViewport(PHONE);
    const mounted = await mount(tabBar());
    const more = mounted.container.querySelector('[data-app-tab="more"]') as HTMLButtonElement;

    await interact(() => more.dispatchEvent(new Event('click', { bubbles: true })));
    const sheet = document.getElementById(more.getAttribute('aria-controls') as string) as HTMLElement;
    const analytics = sheet.querySelector('[data-app-more="analytics"]') as HTMLAnchorElement;
    await interact(() => analytics.dispatchEvent(primaryClick()));

    expect(more.getAttribute('aria-expanded')).toBe('false');

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

describe('AppBar phone title', () => {
  it('names Insights for the three views under More, and nothing elsewhere', () => {
    expect(INSIGHTS_PLACES.map(appBarTitle)).toEqual(['Insights', 'Insights', 'Insights']);
    expect(appBarTitle('projects')).toBeNull();
    expect(appBarTitle('settings')).toBeNull();
    expect(appBarTitle(null)).toBeNull();
  });

  it('gives a phone one page title: "Insights" for its views, the last crumb everywhere else', async () => {
    setViewport(PHONE);
    const titles = (container: HTMLElement) =>
      [...container.querySelectorAll('[data-app-bar-title]')].map(title => title.textContent);
    const phone = await mount(
      bar({
        active: 'warden',
        crumbs: [{ label: 'Warden' }],
        onOpenSidebar: () => {},
        sessionCount: 7,
        tabBarShown: true,
      }),
    );
    expect(titles(phone.container)).toEqual(['Insights']);
    await phone.unmount();
    const elsewhere = await mount(bar({ active: 'settings', crumbs: [{ label: 'Settings' }], tabBarShown: true }));
    expect(titles(elsewhere.container)).toEqual(['Settings']);
    await elsewhere.unmount();
    const uncrumbed = await mount(bar({ active: 'learning', crumbs: [] }));
    expect(titles(uncrumbed.container)).toEqual(['Insights']);
    await uncrumbed.unmount();
    // A desktop shows the breadcrumb, and the stylesheet hides the title from 480px up.
    setViewport(DESKTOP);
    const desktop = await mount(bar({ active: 'analytics' }));
    const title = desktop.container.querySelector('[data-app-bar-title]') as HTMLElement;
    expect(title.className).toContain('min-[480px]:hidden');
    await desktop.unmount();
  });
});
