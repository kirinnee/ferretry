import { daemonTitle } from '../daemons/daemon-list.ts';
import { daemonHomeHref, daemonSettingsHref, DEVICE_SETTINGS_HREF, HOME_HREF } from '../router/routes.ts';
import { useRouter } from '../router/router.tsx';
import {
  TEXT_SCALES,
  THEME_FAMILIES,
  THEME_MODES,
  type TextScale,
  type ThemeFamilyId,
  type ThemeMode,
} from '../theme/preferences.ts';
import { useRuntimeVersion, useShell } from './context.tsx';
import { firstRunEntry, ONBOARDING_SCREEN } from './first-run.ts';
import { PanelSlot, PluginView, ShellLine } from './views.tsx';
import { useEffect, useSyncExternalStore, type MouseEvent } from 'react';

/** An in-app link: a plain click navigates in place; a modifier or middle click is the browser's (a new tab). */
export function Link({
  to,
  children,
  className,
}: {
  readonly to: string;
  readonly children: React.ReactNode;
  readonly className?: string;
}) {
  const router = useRouter();
  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    router.navigate(to);
  };
  return (
    <a href={to} onClick={onClick} className={className}>
      {children}
    </a>
  );
}

/**
 * Home: every paired daemon, grouped by machine (§5.1). With none paired, FIRST RUN: the person goes to Onboarding's
 * daemon-less `/onboarding` screen (replacing this entry, so Back does not return to an empty home) — the shell draws
 * no setup steps of its own. If no Onboarding is installed there is nowhere to send them, so the plain sentence stays.
 */
export function DaemonListPage() {
  const { runtime, views, routes } = useShell();
  const router = useRouter();
  useRuntimeVersion(runtime);
  const groups = runtime.daemons.groups();
  const snapshot = runtime.daemons.snapshot();
  const entry = firstRunEntry({
    pairedDaemonIds: snapshot.daemons.map(paired => paired.daemon),
    selectedDaemonId: snapshot.selected,
    setupJourney: false,
  });
  const onboarding = views.screens.get(ONBOARDING_SCREEN);
  const sendTo = entry.kind === 'onboarding' && onboarding !== undefined ? routes.href(onboarding, {}) : undefined;
  useEffect(() => {
    if (sendTo !== undefined) router.navigate(sendTo, { replace: true });
  }, [sendTo, router]);
  if (groups.length === 0) {
    if (sendTo !== undefined) return <ShellLine>Opening setup…</ShellLine>;
    return (
      <section className="fy-page">
        <h1>No daemons yet</h1>
        <ShellLine>
          Pair this device with a daemon: run `fy pair` on that machine and open the link it prints here.
        </ShellLine>
      </section>
    );
  }
  return (
    <section className="fy-page">
      <h1>Daemons</h1>
      {groups.map(group => (
        <div key={group.machine} className="fy-machine">
          <h2>{group.machine}</h2>
          <ul>
            {group.daemons.map(daemon => (
              <li key={daemon.daemon}>
                <Link to={daemonHomeHref(daemon.daemon)}>{daemonTitle(daemon)}</Link>
                {' · '}
                <Link to={daemonSettingsHref(daemon.daemon)}>Settings</Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** A daemon's own page: its status panels (`daemon.status`), or the full-screen sentence. */
export function DaemonHomePage({ daemon }: { readonly daemon: string }) {
  const { runtime } = useShell();
  useRuntimeVersion(runtime);
  const paired = runtime.daemons.get(daemon);
  if (paired === undefined) return <ShellLine>This device is not paired with that daemon.</ShellLine>;
  return (
    <section className="fy-page">
      <h1>{daemonTitle(paired)}</h1>
      <PanelSlot daemon={daemon} slot="daemon.status" />
    </section>
  );
}

/** A daemon's settings: one tab per plugin, saved on that daemon (§5.2). */
export function DaemonSettingsPage({
  daemon,
  tab,
  tabId,
}: {
  readonly daemon: string;
  readonly tab?: string;
  readonly tabId?: string;
}) {
  const { runtime } = useShell();
  useRuntimeVersion(runtime);
  const tabs = runtime.surfaces.flatMap(entry =>
    (entry.manifest.ui?.settings ?? []).map(setting => ({ plugin: entry.id, ...setting })),
  );
  tabs.sort((a, b) => a.order - b.order || a.plugin.localeCompare(b.plugin));
  // A tab is found by its plugin AND its own id; a plugin's first tab is what `settings/<plugin>` names.
  const active =
    tabs.find(candidate => candidate.plugin === tab && (tabId === undefined || candidate.id === tabId)) ?? tabs[0];
  return (
    <section className="fy-page">
      <h1>Settings</h1>
      <nav className="fy-tabs" aria-label="Plugin settings">
        {tabs.map(candidate => (
          <Link
            key={`${candidate.plugin}.${candidate.id}`}
            to={daemonSettingsHref(daemon, candidate.plugin, candidate.id)}
            className={candidate === active ? 'fy-tab fy-tab--active' : 'fy-tab'}
          >
            {candidate.label}
          </Link>
        ))}
      </nav>
      {active === undefined ? (
        <ShellLine>No plugin on this daemon has settings.</ShellLine>
      ) : (
        <PluginView daemon={daemon} plugin={active.plugin} section="settings" id={active.id} props={{}} />
      )}
    </section>
  );
}

/** This device's settings (§5.2): theme, text size; saved in this browser, never on a daemon. */
export function DeviceSettingsPage() {
  const { themes, layout } = useShell();
  const preference = useSyncExternalStore(themes.subscribe, () => themes.snapshot());
  return (
    <section className="fy-page">
      <h1>This device</h1>
      <label>
        Theme{' '}
        <select value={preference.family} onChange={event => themes.setFamily(event.target.value as ThemeFamilyId)}>
          {THEME_FAMILIES.map(family => (
            <option key={family.id} value={family.id}>
              {family.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Mode{' '}
        <select value={preference.mode} onChange={event => themes.setMode(event.target.value as ThemeMode)}>
          {THEME_MODES.map(mode => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </label>
      <label>
        Text size{' '}
        <select value={preference.textScale} onChange={event => themes.setTextScale(event.target.value as TextScale)}>
          {TEXT_SCALES.map(scale => (
            <option key={scale} value={scale}>
              {scale}
            </option>
          ))}
        </select>
      </label>
      <p>
        Layout: <code>{layout.layout.id}</code>
        {layout.kind === 'refused'
          ? ` (the layout "${layout.refused}" was refused: ${layout.issues[0]?.message ?? ''})`
          : ''}
      </p>
    </section>
  );
}

export function NotFoundPage() {
  return (
    <section className="fy-page">
      <ShellLine>Nothing is here. </ShellLine>
      <Link to={HOME_HREF}>All daemons</Link> · <Link to={DEVICE_SETTINGS_HREF}>This device</Link>
    </section>
  );
}
