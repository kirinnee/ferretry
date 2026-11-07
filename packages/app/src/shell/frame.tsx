import { daemonTitle } from '../daemons/daemon-list.ts';
import type { NavEntry } from '../layout/engine.ts';
import { daemonHomeHref, DEVICE_SETTINGS_HREF, HOME_HREF, type Route } from '../router/routes.ts';
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
import { ScreenView, ShellLine } from './views.tsx';

/**
 * THE FRAME (§5.2): the shell's slots, placed by the layout. `nav` (or `bottom` when the layout puts nav there on a
 * phone), `top`, `main` (one screen at a time, by the router), `side` (wide screens, when the layout asks). Nothing
 * in the frame is a feature: every entry is a plugin's screen, or one of the shell's own items.
 */

const routeDaemon = (route: Route): string | undefined =>
  'daemon' in route && typeof route.daemon === 'string' ? route.daemon : undefined;

function navHref(entry: NavEntry, daemon: string | undefined, href: (e: NavEntry) => string | undefined): string | undefined {
  if (entry.kind === 'shell') {
    if (entry.item === 'settings') return daemon === undefined ? DEVICE_SETTINGS_HREF : `${daemonHomeHref(daemon)}/settings`;
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
  return (
    <nav className={`fy-nav fy-nav--${side} fy-nav--${plan.nav.style}`} data-slot={side === 'bottom' ? 'bottom' : 'nav'}>
      {plan.nav.entries.map(entry => {
        const to = navHref(entry, daemon, href);
        const label = entry.kind === 'screen' ? entry.screen.label : entry.item === 'settings' ? 'Settings' : 'Daemons';
        const key = entry.kind === 'screen' ? `${entry.screen.plugin}.${entry.screen.id}` : entry.item;
        return to === undefined ? (
          <span key={key} className="fy-nav__item fy-nav__item--off">
            {label}
          </span>
        ) : (
          <Link key={key} to={to} className="fy-nav__item">
            {label}
          </Link>
        );
      })}
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

function TopBar({ daemon }: { readonly daemon: string | undefined }) {
  const { plan } = useShell();
  return (
    <header className="fy-top" data-slot="top">
      {plan.top.map(item => {
        if (item === 'daemon-picker') return <DaemonPicker key={item} daemon={daemon} />;
        // GAP: search and the command bar (`fy layout set` from the app) are not built in the shell yet.
        if (item === 'search') return <input key={item} className="fy-search" type="search" placeholder="Search" disabled />;
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
      return <DaemonSettingsPage daemon={route.daemon} {...(route.tab === undefined ? {} : { tab: route.tab })} />;
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
    </aside>
  );
}

export function Frame() {
  const { runtime, plan } = useShell();
  useRuntimeVersion(runtime);
  const { route } = useRouter();
  const daemon = routeDaemon(route);
  const whole = daemon === undefined ? undefined : runtime.wholeDaemonLine(daemon);
  return (
    <div className={`fy-frame fy-frame--nav-${plan.nav.side}`} data-layout={plan.layoutId}>
      <Nav daemon={daemon ?? runtime.daemons.snapshot().selected ?? undefined} />
      <div className="fy-body">
        <TopBar daemon={daemon} />
        <div className="fy-columns">
          <main className="fy-main" data-slot="main">
            {whole === undefined ? <Main route={route} /> : <ShellLine tone="warn">{whole}</ShellLine>}
          </main>
          {whole === undefined ? <Side daemon={daemon} /> : null}
        </div>
      </div>
    </div>
  );
}
