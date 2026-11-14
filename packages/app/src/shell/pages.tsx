import { daemonTitle } from '../daemons/daemon-list.ts';
import { daemonHomeHref, daemonSettingsHref, DEVICE_SETTINGS_HREF, HOME_HREF } from '../router/routes.ts';
import { useRouter } from '../router/router.tsx';
import { useRuntimeVersion, useShell } from './context.tsx';
import { firstRunEntry, ONBOARDING_SCREEN } from './first-run.ts';
import { SettingGroup } from '../compose/setting-row.tsx';
import { CachedDataSetting } from './device-cached-data.tsx';
import { DeviceAppearance } from './device-appearance.tsx';
import { DevicePanels } from './device-panels.tsx';
import { groupSettingsTabs, resolveSettingsTab } from './settings-tab.ts';
import { PanelSlot, PluginView, ShellLine } from './views.tsx';
import { useEffect, type MouseEvent } from 'react';

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
  // A tab is found by its plugin AND its own id; a plugin's first tab is what `settings/<plugin>` names, a bare tab id
  // names that tab, and a name nothing answers to is said so (never the first tab in its place).
  const choice = resolveSettingsTab(tabs, tab, tabId);
  const active = choice.kind === 'tab' ? choice.tab : undefined;
  return (
    <section className="fy-page">
      <h1>Settings</h1>
      {/* This device's own settings (theme, text size, motion, notifications…) are saved in this browser, not on a daemon:
      the shell's own entry, one click from here as v4's Settings had it. Its address is the one a reload still serves. */}
      <p className="fy-settings-device">
        <Link to={DEVICE_SETTINGS_HREF}>This device</Link>
        <span className="fy-settings-device__hint">
          {' '}
          — theme, text size, motion and notifications, saved in this browser
        </span>
      </p>
      {/* v4's titled groups (`machine-panels.ts`); each plugin names its tab's group in its manifest. */}
      <nav className="fy-tabs fy-tabs--grouped" aria-label="Plugin settings">
        {groupSettingsTabs(tabs).map(group => (
          <section key={group.id} className="fy-tab-group" aria-labelledby={`fy-settings-group-${group.id}`}>
            <h2 id={`fy-settings-group-${group.id}`} className="fy-tab-group__title">
              {group.label}
            </h2>
            <div className="fy-tab-group__tabs">
              {group.tabs.map(candidate => (
                <Link
                  key={`${candidate.plugin}.${candidate.id}`}
                  to={daemonSettingsHref(daemon, candidate.plugin, candidate.id)}
                  className={candidate === active ? 'fy-tab fy-tab--active' : 'fy-tab'}
                >
                  {candidate.label}
                </Link>
              ))}
            </div>
          </section>
        ))}
      </nav>
      {choice.kind === 'none' ? (
        <ShellLine>No plugin on this daemon has settings.</ShellLine>
      ) : choice.kind === 'missing' ? (
        <ShellLine>{`There is no settings tab called "${choice.name}" on this daemon. Pick one above.`}</ShellLine>
      ) : (
        <PluginView daemon={daemon} plugin={choice.tab.plugin} section="settings" id={choice.tab.id} props={{}} />
      )}
    </section>
  );
}

/** This device's settings (§5.2): theme, mode, text size, motion; saved in this browser, never on a daemon. */
export function DeviceSettingsPage() {
  const { layout, scroll, runtime } = useShell();
  useRuntimeVersion(runtime);
  const daemons = runtime.daemons.groups().flatMap(group => group.daemons);
  return (
    <section className="fy-page">
      <h1>This device</h1>
      {/* The way back: each paired daemon keeps its own settings (what it runs, who may reach it), apart from these. */}
      {daemons.length === 0 ? null : (
        <ul className="fy-settings-daemons" aria-label="Daemon settings">
          {daemons.map(daemon => (
            <li key={daemon.daemon}>
              <Link to={daemonSettingsHref(daemon.daemon)}>{`Settings for ${daemonTitle(daemon)}`}</Link>
            </li>
          ))}
        </ul>
      )}
      <DeviceAppearance />
      {/* Panels plugins declare in device.settings (S4, M3): no machine needed, by order. */}
      <DevicePanels slot="device.settings" />
      <SettingGroup label="Storage">
        <CachedDataSetting onClear={async () => scroll.clear()} />
      </SettingGroup>
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
