import { BackgroundViews } from './background.tsx';
import { DevicePanels, NavCount, type NavForm } from './device-panels.tsx';
import { DeviceViews } from './device-views.tsx';
import { PhoneTitleBar } from './phone-title-bar.tsx';
import { ChevronDown, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_LAYOUT } from '../layout/layout.ts';
import { CommandBar } from '../ui/command-bar.tsx';
import { ContextMenu, type ContextMenuItem, type MenuAnchor } from '../ui/context-menu.tsx';
import { useInputModality } from '../ui/hooks/use-input-modality.ts';
import { useAppViewport } from '../ui/hooks/use-app-viewport.ts';
import { PALETTE_KEYSHORTCUTS, paletteShortcutLabel } from '../ui/palette-shortcut.ts';
import { buildPluginCommandSources, deviceLayoutSource, placeSource, settingsSource } from './command-sources.ts';
import { useScreenHref } from '../router/screen-href.ts';
import { daemonTitle } from '../daemons/daemon-list.ts';
import type { NavEntry } from '../layout/engine.ts';
import {
  daemonHomeHref,
  DEVICE_SETTINGS_HREF,
  HOME_HREF,
  needsSubject,
  pairAgainHref,
  type Route,
} from '../router/routes.ts';
import { useRouter } from '../router/router.tsx';
import { useRuntimeVersion, useShell } from './context.tsx';
import {
  DaemonHomePage,
  DaemonListPage,
  DaemonSettingsPage,
  DeviceSettingsPage,
  Link,
  NotFoundPage,
} from './pages.tsx';
import { PageScrollRegion } from '../scroll/page-scroll-region.tsx';
import { FrameRootContext } from './frame-root.tsx';
import { PasskeyMount } from './passkey-mount.tsx';
import { PanelSlot, ScreenView, ShellLine } from './views.tsx';

/**
 * THE FRAME (§5.2): the shell's slots, placed by the layout. `nav` (or `bottom` when the layout puts nav there on a
 * phone), `top`, `main` (one screen at a time, by the router), `side` (wide screens, when the layout asks). Nothing
 * in the frame is a feature: every entry is a plugin's screen, or one of the shell's own items.
 */

const ALL_DAEMONS = 'All daemons';
const ALL_DAEMONS_KEY = '';
const THIS_ONE = 'this one';

const routeDaemon = (route: Route): string | undefined =>
  'daemon' in route && typeof route.daemon === 'string' ? route.daemon : undefined;

function navHref(
  entry: NavEntry,
  daemon: string | undefined,
  href: (e: NavEntry) => string | undefined,
): string | undefined {
  if (entry.kind === 'shell') {
    if (entry.item === 'settings')
      return daemon === undefined ? DEVICE_SETTINGS_HREF : `${daemonHomeHref(daemon)}/settings`;
    return HOME_HREF;
  }
  return href(entry);
}

/** A ferret's chat (`ferrets/:ferret/chat`) is a page of the Ferrets place even though Conversation draws it: both start at `ferrets`. */
const sameSection = (path: string, entryPath: string): boolean => {
  const first = path.split('/')[0];
  return first !== undefined && first !== '' && first === entryPath.split('/')[0];
};

function Nav({ daemon }: { readonly daemon: string | undefined }) {
  const { plan, routes } = useShell();
  const { route } = useRouter();
  // The entry whose page is on screen: a plugin's entry for any screen of that plugin (the ferret page is Ferrets'), Settings for either settings page.
  const onScreen = (entry: NavEntry): boolean =>
    entry.kind === 'screen'
      ? route.kind === 'screen' &&
        (route.screen.plugin === entry.screen.plugin || sameSection(route.screen.path, entry.screen.path))
      : entry.item === 'settings' && (route.kind === 'device-settings' || route.kind === 'daemon-settings');
  const href = (entry: NavEntry): string | undefined => {
    if (entry.kind !== 'screen') return undefined;
    const { screen } = entry;
    if (needsSubject(screen.path)) return undefined; // a screen that needs a subject is not a nav destination
    if (screen.path.startsWith('/')) return routes.href(screen, {});
    return daemon === undefined ? undefined : routes.href(screen, {}, daemon);
  };
  const side = plan.nav.side;
  // A nav panel is drawn in a left or right nav of EVERY style (the default built-in is a list, compact is a rail), told which form it is
  // in; never on the top or bottom bar.
  const panelForm: NavForm | undefined =
    side === 'left' || side === 'right' ? (plan.nav.style === 'rail' ? 'rail' : 'column') : undefined;
  return (
    <nav
      className={`fy-nav fy-nav--${side} fy-nav--${plan.nav.style}`}
      data-slot={side === 'bottom' ? 'bottom' : 'nav'}
      // THE PHONE'S BOTTOM BAR STEPS ASIDE FOR THE KEYBOARD (design-system.css `[data-kb-hide]`): it is stateless links, so it
      // can go and come back intact, and it no longer covers the composer while someone types. Only a bar at the bottom: a
      // rail or top row does not sit over the keyboard, and desktop never sets `data-keyboard`.
      data-kb-hide={side === 'bottom' ? '' : undefined}
    >
      {plan.nav.entries.map(entry => {
        const to = navHref(entry, daemon, href);
        const label = entry.kind === 'screen' ? entry.screen.label : entry.item === 'settings' ? 'Settings' : 'Daemons';
        const key = entry.kind === 'screen' ? `${entry.screen.plugin}.${entry.screen.id}` : entry.item;
        // A plugin's count for its own entry, summed over every machine (S4), on every nav form.
        const badge =
          entry.kind === 'screen' ? (
            <NavCount key="count" plugin={entry.screen.plugin} screen={entry.screen.id} label={label} />
          ) : null;
        return to === undefined ? (
          <span key={key} className="fy-nav__item fy-nav__item--off">
            {label}
            {badge}
          </span>
        ) : (
          <Link key={key} to={to} className="fy-nav__item" current={onScreen(entry)}>
            {label}
            {badge}
          </Link>
        );
      })}
      {/* Device-level nav panels (S4, MJ3): drawn once, with no daemon, in the column and in the rail (each told its
      form), never on the phone bar. */}
      {panelForm === undefined ? null : <DevicePanels slot="nav" form={panelForm} />}
    </nav>
  );
}

/**
 * THE MACHINE SWITCHER, like v4's: a button that says which machine is on screen and opens a menu (the shared
 * ContextMenu — role=menu, arrows, Home/End, Escape back to the button, 44px rows on a touch screen). Every machine is
 * ONE row, in its own words, the one on screen marked "this one"; "All daemons" leads, marked the same way when the
 * list is what is showing.
 */
function DaemonPicker({ daemon }: { readonly daemon: string | undefined }) {
  const { runtime } = useShell();
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const { touchAffected } = useInputModality();
  const machines = runtime.daemons.groups().flatMap(group => group.daemons);
  if (machines.length === 0) return null;
  const current = machines.find(entry => entry.daemon === daemon);
  const name = current === undefined ? ALL_DAEMONS : daemonTitle(current);
  const items: readonly ContextMenuItem[] = [
    {
      key: ALL_DAEMONS_KEY,
      label: ALL_DAEMONS,
      ...(current === undefined ? { detail: THIS_ONE } : {}),
      onSelect: () => router.navigate(HOME_HREF),
    },
    ...machines.map(entry => ({
      key: entry.daemon,
      label: daemonTitle(entry),
      ...(entry.daemon === current?.daemon ? { detail: THIS_ONE } : {}),
      separatorBefore: entry === machines[0],
      onSelect: () => {
        runtime.daemons.select(entry.daemon);
        router.navigate(daemonHomeHref(entry.daemon));
      },
    })),
  ];
  return (
    <>
      <button
        aria-expanded={anchor !== null}
        aria-haspopup="menu"
        aria-label={`Machine: ${name}. Switch machine`}
        className="fy-daemon-picker"
        data-daemon-picker=""
        onClick={() => {
          const rect = trigger.current?.getBoundingClientRect();
          setAnchor({ x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
        }}
        ref={trigger}
        type="button"
      >
        <span className="fy-daemon-picker__name">{name}</span>
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      <ContextMenu
        anchor={anchor ?? { x: 0, y: 0 }}
        ariaLabel="Switch machine"
        items={items}
        onClose={() => setAnchor(null)}
        open={anchor !== null}
        touch={touchAffected}
        triggerRef={trigger}
      />
    </>
  );
}

function TopBar({ daemon, onSearch }: { readonly daemon: string | undefined; readonly onSearch: () => void }) {
  const { plan } = useShell();
  return (
    <header className="fy-top" data-slot="top">
      {plan.top.map(item => {
        if (item === 'daemon-picker') return <DaemonPicker key={item} daemon={daemon} />;
        if (item === 'search')
          return (
            <button
              key={item}
              type="button"
              className="fy-search"
              aria-keyshortcuts={PALETTE_KEYSHORTCUTS}
              onClick={onSearch}
            >
              <Search aria-hidden="true" size={16} className="fy-search__icon" />
              <span className="fy-search__label">Find</span>
              <kbd className="mono">{paletteShortcutLabel()}</kbd>
            </button>
          );
        return null;
      })}
    </header>
  );
}

function Main({ route }: { readonly route: Route }) {
  switch (route.kind) {
    case 'home':
      return <DaemonListPage />;
    case 'device-settings':
      return <DeviceSettingsPage />;
    case 'daemon-home':
      return <DaemonHomePage daemon={route.daemon} />;
    case 'daemon-settings':
      return (
        <DaemonSettingsPage
          daemon={route.daemon}
          {...(route.tab === undefined ? {} : { tab: route.tab })}
          {...(route.tabId === undefined ? {} : { tabId: route.tabId })}
        />
      );
    case 'screen':
      return <ScreenView daemon={route.daemon} screen={route.screen} params={route.params} />;
    case 'not-found':
      return <NotFoundPage />;
  }
}

function Side({ daemon, route }: { readonly daemon: string | undefined; readonly route: Route }) {
  const { plan, viewport } = useShell();
  const { show, holds } = plan.side;
  if (show === 'never' || (show === 'wide-only' && viewport === 'phone') || holds.kind === 'none') return null;
  if (daemon === undefined) return null;
  if (holds.kind === 'screen' && needsSubject(holds.screen.path)) return null; // needs a subject the route lacks
  // The page IS the screen the column holds (the ferret list on /ferrets): draw it once, in the page, not again beside it.
  if (
    holds.kind === 'screen' &&
    route.kind === 'screen' &&
    route.screen.plugin === holds.screen.plugin &&
    route.screen.id === holds.screen.id
  )
    return null;
  return (
    <aside className={`fy-side fy-side--${plan.side.at}`} data-slot="side">
      {holds.kind === 'screen' ? <ScreenView daemon={daemon} screen={holds.screen} params={{}} /> : null}
      {/* The side column that holds panels (S4): the `side` slot's panels, for the route's daemon. */}
      {holds.kind === 'panels' ? <PanelSlot daemon={daemon} slot="side" /> : null}
    </aside>
  );
}

/** Cmd/Ctrl+K from anywhere opens the bar (or re-focuses its query when it is open). */
function useCommandBarShortcut(open: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      open();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
}

/** The command bar with the shell's own sources (places, this device's layout commands) and the plugins' entries. */
function ShellCommandBar(props: {
  readonly daemon: string | undefined;
  readonly open: boolean;
  readonly focusSignal: number;
  readonly onClose: () => void;
}) {
  const { runtime, views, routes, owner, layouts } = useShell();
  const router = useRouter();
  const { route } = router;
  // The ferret whose page this is, for the entries that are about "this ferret" (Board's, S-0449).
  const ferret = route.kind === 'screen' ? route.params.ferret : undefined;
  // `useScreenHref` answers a fresh function every render with the same answers; the sources read the latest one.
  const screenHrefOf = useScreenHref();
  const screenHrefRef = useRef(screenHrefOf);
  screenHrefRef.current = screenHrefOf;
  // The bar follows which plugins the machine allows: opened right after a page loads, it is open BEFORE the machine has
  // said which plugins are on, and sources built then would have no plugin to ask and never be built again.
  useRuntimeVersion(runtime);
  const allowed =
    props.daemon === undefined
      ? ''
      : runtime.surfaces.map(entry => runtime.standing(props.daemon as string, entry.id).state).join(',');
  const daemons = runtime.daemons.snapshot().daemons;
  // A plugin source that was waiting on its daemon asks for a new listing by bumping this.
  const [answers, setAnswers] = useState(0);
  const changed = useCallback(() => setAnswers(current => current + 1), []);
  const daemon = props.daemon;
  // Built once per daemon and plugin set (a source holds what its daemon last answered), and only while the bar is open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `allowed` rebuilds the sources when a plugin becomes allowed.
  const pluginSources = useMemo(
    () =>
      daemon === undefined || !props.open
        ? []
        : buildPluginCommandSources({
            surfaces: runtime.surfaces,
            daemon,
            clientOf: plugin => runtime.client(daemon, plugin),
            navigate: href => router.navigate(href),
            screenHref: (...address) => screenHrefRef.current(...address),
            changed,
            ferret,
            appHook: name => runtime.appHook(daemon, name),
          }),
    [daemon, props.open, runtime, router, changed, ferret, allowed],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `answers` re-lists when a plugin source's answer arrives.
  const sources = useMemo(
    () => [
      placeSource({
        daemons,
        daemon,
        screens: [...views.screens.values()],
        routes,
        navigate: href => router.navigate(href),
      }),
      settingsSource({ daemon, surfaces: runtime.surfaces, navigate: href => router.navigate(href) }),
      deviceLayoutSource(owner ?? DEFAULT_LAYOUT, layouts),
      ...pluginSources,
    ],
    [daemons, daemon, views, routes, router, owner, layouts, pluginSources, answers, runtime],
  );
  return <CommandBar open={props.open} focusSignal={props.focusSignal} onClose={props.onClose} sources={sources} />;
}

/**
 * The sentence that replaces a whole machine's page. A machine this page was refused on (`4403`) also offers the one
 * repair, "Pair again" (S12): its key and pairing are kept, so the person chooses whether to repeat the pairing.
 *
 * THE CONNECTION SETTING IS ALWAYS REACHABLE FROM HERE: this page replaces every screen of the machine, including the
 * machine's own Connection panel, and how this device reaches a machine is a per-device choice kept in the browser — so
 * the link goes to This device's settings, which need no machine, rather than to a screen this very block hides.
 */
function WholeLine({ daemon, line }: { readonly daemon: string | undefined; readonly line: string }) {
  const { runtime } = useShell();
  // Which core piece (or that the list could not be read): the sentence above is the same for every cause.
  const why = daemon === undefined ? undefined : runtime.wholeDaemonDetail(daemon);
  const { navigate } = useRouter();
  const refused = daemon !== undefined && runtime.isRefused(daemon) ? daemon : undefined;
  return (
    <>
      <ShellLine tone="warn">{line}</ShellLine>
      {why === undefined ? null : <ShellLine>{`Why: ${why}.`}</ShellLine>}
      <p className="fy-shell-line" data-whole-daemon-connection="">
        <Link to={DEVICE_SETTINGS_HREF}>Connection settings</Link>
      </p>
      {refused === undefined ? null : (
        <button
          type="button"
          className="kt-btn"
          data-variant="primary"
          data-device-refused-pair=""
          onClick={() => navigate(pairAgainHref(refused))}
        >
          Pair again
        </button>
      )}
    </>
  );
}

export function Frame() {
  const { runtime, plan, scroll } = useShell();
  useRuntimeVersion(runtime);
  const { route, entryKey } = useRouter();
  const daemon = routeDaemon(route);
  const whole = daemon === undefined ? undefined : runtime.wholeDaemonLine(daemon);
  const [bar, setBar] = useState({ open: false, signal: 0 });
  const openBar = useCallback(() => setBar(current => ({ open: true, signal: current.signal + 1 })), []);
  const closeBar = useCallback(() => setBar(current => ({ ...current, open: false })), []);
  useCommandBarShortcut(openBar);
  // The visible height (`--app-h`) and the keyboard-open attribute every screen lays itself out by, as today.
  useAppViewport();
  // The frame root, handed to the shell's own overlays (the machine picker, S10) so they draw above every plugin sheet.
  const [frameRoot, setFrameRoot] = useState<HTMLElement | null>(null);
  return (
    <FrameRootContext.Provider value={frameRoot}>
      <div ref={setFrameRoot} className={`fy-frame fy-frame--nav-${plan.nav.side}`} data-layout={plan.layoutId}>
        <Nav daemon={daemon ?? runtime.daemons.snapshot().selected ?? undefined} />
        <div className="fy-body">
          <PhoneTitleBar daemon={daemon ?? runtime.daemons.snapshot().selected ?? undefined} />
          <TopBar daemon={daemon} onSearch={openBar} />
          {/* THE STATUS STRIP: where the views mounted at the frame root draw what they draw IN FLOW — a line a watcher
      says ("Couldn't reach it through the relay…"), a banner. They sit here, a row under the top bar and above the
      columns, never as a child of the frame's own row: a line placed beside the body is a COLUMN of the frame and takes its
      width from the page (the agenda's item column fell from v4's ~680px to 350px at 1280). An overlay a view draws is
      fixed or portalled and does not care where it is mounted; an empty strip takes no room. */}
          <div className="fy-status" data-slot="status">
            {/* Every plugin's device views, once each (S3): the one taker of its keyed fragments, over every machine. */}
            <DeviceViews />
            {/* Every plugin's background views, once per paired daemon where it may run (S5): watchers and overlays. */}
            <BackgroundViews />
          </div>
          <div className="fy-columns">
            {/* The side column is drawn first when the layout puts it on the left, so the reading and the tab order match the eye. */}
            {whole === undefined && plan.side.at === 'left' ? <Side daemon={daemon} route={route} /> : null}
            <main className="fy-main" data-slot="main">
              <PageScrollRegion entryKey={entryKey} memory={scroll}>
                {whole === undefined ? <Main route={route} /> : <WholeLine daemon={daemon} line={whole} />}
              </PageScrollRegion>
            </main>
            {whole === undefined && plan.side.at === 'right' ? <Side daemon={daemon} route={route} /> : null}
          </div>
        </div>
        <ShellCommandBar
          daemon={daemon ?? runtime.daemons.snapshot().selected ?? undefined}
          open={bar.open}
          focusSignal={bar.signal}
          onClose={closeBar}
        />
        {/* One passkey prompt for the whole app (Access's): any daemon call refused for want of an unlock or a step-up
      raises it, and only the machine on screen may raise a background one (G95, G105). */}
        <PasskeyMount onScreen={runtime.passkeyOnScreen.chosen() ?? daemon ?? runtime.daemons.snapshot().selected} />
      </div>
    </FrameRootContext.Provider>
  );
}
