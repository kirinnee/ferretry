import { BackgroundViews } from './background.tsx';
import { DevicePanels, NavCount, type NavForm } from './device-panels.tsx';
import { DeviceViews } from './device-views.tsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_LAYOUT } from '../layout/layout.ts';
import { CommandBar } from '../ui/command-bar.tsx';
import { useAppViewport } from '../ui/hooks/use-app-viewport.ts';
import { PALETTE_KEYSHORTCUTS, paletteShortcutLabel } from '../ui/palette-shortcut.ts';
import { buildPluginCommandSources, deviceLayoutSource, placeSource } from './command-sources.ts';
import { useScreenHref } from '../router/screen-href.ts';
import { daemonTitle } from '../daemons/daemon-list.ts';
import type { NavEntry } from '../layout/engine.ts';
import { daemonHomeHref, DEVICE_SETTINGS_HREF, HOME_HREF, pairAgainHref, type Route } from '../router/routes.ts';
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
import { PasskeyMount } from './passkey-mount.tsx';
import { PanelSlot, ScreenView, ShellLine } from './views.tsx';

/**
 * THE FRAME (§5.2): the shell's slots, placed by the layout. `nav` (or `bottom` when the layout puts nav there on a
 * phone), `top`, `main` (one screen at a time, by the router), `side` (wide screens, when the layout asks). Nothing
 * in the frame is a feature: every entry is a plugin's screen, or one of the shell's own items.
 */

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

function Nav({ daemon }: { readonly daemon: string | undefined }) {
  const { plan, routes } = useShell();
  const href = (entry: NavEntry): string | undefined => {
    if (entry.kind !== 'screen') return undefined;
    const { screen } = entry;
    if (screen.path.includes(':')) return undefined; // a screen that needs a subject is not a nav destination
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
          <Link key={key} to={to} className="fy-nav__item">
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

function DaemonPicker({ daemon }: { readonly daemon: string | undefined }) {
  const { runtime } = useShell();
  const router = useRouter();
  const groups = runtime.daemons.groups();
  if (groups.length === 0) return null;
  return (
    <select
      className="fy-daemon-picker"
      aria-label="Daemon"
      value={daemon ?? ''}
      onChange={event => {
        if (event.target.value === '') return router.navigate(HOME_HREF);
        runtime.daemons.select(event.target.value);
        router.navigate(daemonHomeHref(event.target.value));
      }}
    >
      <option value="">All daemons</option>
      {groups.map(group => (
        <optgroup key={group.machine} label={group.machine}>
          {group.daemons.map(entry => (
            <option key={entry.daemon} value={entry.daemon}>
              {daemonTitle(entry)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
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
              Search <kbd className="mono">{paletteShortcutLabel()}</kbd>
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

function Side({ daemon }: { readonly daemon: string | undefined }) {
  const { plan, viewport } = useShell();
  const { show, holds } = plan.side;
  if (show === 'never' || (show === 'wide-only' && viewport === 'phone') || holds.kind === 'none') return null;
  if (daemon === undefined) return null;
  if (holds.kind === 'screen' && holds.screen.path.includes(':')) return null; // needs a subject the route lacks
  return (
    <aside className="fy-side" data-slot="side">
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
  // `useScreenHref` answers a fresh function every render with the same answers; the sources read the latest one.
  const screenHrefOf = useScreenHref();
  const screenHrefRef = useRef(screenHrefOf);
  screenHrefRef.current = screenHrefOf;
  const daemons = runtime.daemons.snapshot().daemons;
  // A plugin source that was waiting on its daemon asks for a new listing by bumping this.
  const [answers, setAnswers] = useState(0);
  const changed = useCallback(() => setAnswers(current => current + 1), []);
  const daemon = props.daemon;
  // Built once per daemon (a source holds what its daemon last answered), and only while the bar is open.
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
          }),
    [daemon, props.open, runtime, router, changed],
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
      deviceLayoutSource(owner ?? DEFAULT_LAYOUT, layouts),
      ...pluginSources,
    ],
    [daemons, daemon, views, routes, router, owner, layouts, pluginSources, answers],
  );
  return <CommandBar open={props.open} focusSignal={props.focusSignal} onClose={props.onClose} sources={sources} />;
}

/**
 * The sentence that replaces a whole machine's page. A machine this page was refused on (`4403`) also offers the one
 * repair, "Pair again" (S12): its key and pairing are kept, so the person chooses whether to repeat the pairing.
 */
function WholeLine({ daemon, line }: { readonly daemon: string | undefined; readonly line: string }) {
  const { runtime } = useShell();
  const { navigate } = useRouter();
  const refused = daemon !== undefined && runtime.isRefused(daemon) ? daemon : undefined;
  return (
    <>
      <ShellLine tone="warn">{line}</ShellLine>
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
  return (
    <div className={`fy-frame fy-frame--nav-${plan.nav.side}`} data-layout={plan.layoutId}>
      <Nav daemon={daemon ?? runtime.daemons.snapshot().selected ?? undefined} />
      <div className="fy-body">
        <TopBar daemon={daemon} onSearch={openBar} />
        <div className="fy-columns">
          <main className="fy-main" data-slot="main">
            <PageScrollRegion entryKey={entryKey} memory={scroll}>
              {whole === undefined ? <Main route={route} /> : <WholeLine daemon={daemon} line={whole} />}
            </PageScrollRegion>
          </main>
          {whole === undefined ? <Side daemon={daemon} /> : null}
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
      <PasskeyMount onScreen={daemon ?? runtime.daemons.snapshot().selected} />
      {/* Every plugin's device views, once each (S3): the one taker of its keyed fragments, over every machine. */}
      <DeviceViews />
      {/* Every plugin's background views, once per paired daemon where it may run (S5): watchers and overlays. */}
      <BackgroundViews />
    </div>
  );
}
