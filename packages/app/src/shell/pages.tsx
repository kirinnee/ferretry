import { daemonTitle } from '../daemons/daemon-list.ts';
import { daemonHomeHref, daemonSettingsHref, DEVICE_SETTINGS_HREF, HOME_HREF } from '../router/routes.ts';
import { destinationPath, useRouter } from '../router/router.tsx';
import { useRuntimeVersion, useShell } from './context.tsx';
import { firstRunEntry, ONBOARDING_SCREEN, PAIR_SCREEN } from './first-run.ts';
import { SettingGroup } from '../compose/setting-row.tsx';
import { CachedDataSetting } from './device-cached-data.tsx';
import { DeviceAppearance } from './device-appearance.tsx';
import { DevicePanels } from './device-panels.tsx';
import { Link } from './link.tsx';
import { SettingsNav } from './settings-nav.tsx';
import { resolveSettingsTab, SCOPE_WORDS, scopeOf } from './settings-tab.ts';
import { Loading } from '../ui/loading.tsx';
import { ResizeHandle } from '../ui/resize-handle.tsx';
import { PanelSlot, PluginView, ShellLine } from './views.tsx';
import { useEffect, useRef, type MouseEvent } from 'react';

export { Link };

/**
 * Home: every paired daemon, grouped by machine (§5.1). With a selected, still-paired daemon the app OPENS that machine
 * (`firstRunEntry`'s `fleet` answer, replacing this entry so Back does not return to a list the person skipped); with
 * pairings but no valid selection the list stays (the `picker` answer: never guess which machine they meant). With none
 * paired, FIRST RUN: the person goes to Onboarding's daemon-less `/onboarding` screen (replacing this entry, so Back
 * does not return to an empty home) — the shell draws no setup steps of its own. If no Onboarding is installed there is
 * nowhere to send them, so the plain sentence stays.
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
  const pair = views.screens.get(PAIR_SCREEN);
  // WHEN THE APP IS OPENED (no entry behind this one: a fresh tab, a deep link, a first entry), a paired device with a
  // real selection goes straight to that machine. Reaching the list on purpose ("All daemons", the picker) pushes an
  // entry on top of another, so it is never bounced away from the list it asked for.
  const opened = router.previousPath === undefined;
  const sendTo =
    entry.kind === 'fleet'
      ? opened
        ? daemonHomeHref(entry.daemonId)
        : undefined
      : entry.kind === 'onboarding' && onboarding !== undefined
        ? routes.href(onboarding, {})
        : undefined;
  useEffect(() => {
    if (sendTo !== undefined) router.navigate(sendTo, { replace: true });
  }, [sendTo, router]);
  if (sendTo !== undefined)
    return <Loading kind="page" label={entry.kind === 'fleet' ? 'Opening your machine…' : 'Opening setup…'} />;
  if (groups.length === 0) {
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
      {/* Access's own list: addresses, the selected tick, Forget on each, and Pair another daemon. */}
      {pair === undefined ? null : (
        <p>
          <Link to={routes.href(pair, {})}>Pair another daemon, or forget one</Link>
        </p>
      )}
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

/**
 * The phone's way back from a settings panel to the list. The list is the entry just behind the panel when the person came
 * through it, so that is Back (the history goes back; it does not grow); a deep link into a panel has no list behind it, so
 * the list REPLACES the panel. Either way a browser Back from the list never returns to the panel just left.
 */
function SettingsBackLink({ to }: { readonly to: string }) {
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
    if (router.previousPath === destinationPath(to)) router.back(to);
    else router.navigate(to, { replace: true });
  };
  return (
    <a href={to} onClick={onClick} className="fy-settings-back">
      ‹ Settings
    </a>
  );
}

/**
 * A daemon's settings: one tab per plugin, saved on that daemon (§5.2). Laid out as v4's Settings was: a machine header
 * (its name, whether it answers, and that these settings belong to THAT machine), the titled groups as a compact list
 * BESIDE the panel on a wide screen, the panel always at its own top. On a phone the list is a page of its own and a tab
 * opens full-screen with a way back (`shell.css` shows one or the other from `data-settings-open`).
 */
export function DaemonSettingsPage({
  daemon,
  tab,
  tabId,
}: {
  readonly daemon: string;
  readonly tab?: string;
  readonly tabId?: string;
}) {
  const { runtime, scroll, viewport } = useShell();
  const { entryKey } = useRouter();
  useRuntimeVersion(runtime);
  const paired = runtime.daemons.get(daemon);
  const online = runtime.online(daemon);
  const tabs = runtime.surfaces.flatMap(entry =>
    (entry.manifest.ui?.settings ?? []).map(setting => ({ plugin: entry.id, ...setting })),
  );
  tabs.sort((a, b) => a.order - b.order || a.plugin.localeCompare(b.plugin));
  // A tab is found by its plugin AND its own id; a plugin's first tab is what `settings/<plugin>` names, a bare tab id
  // names that tab, and a name nothing answers to is said so (never the first tab in its place).
  const choice = resolveSettingsTab(tabs, tab, tabId);
  // A phone's bare /settings is the LIST and nothing else: no tab is marked and none is mounted behind it (a wide screen
  // opens the first tab beside the list, so it keeps one).
  const listOnly = viewport === 'phone' && tab === undefined;
  const active = choice.kind === 'tab' && !listOnly ? choice.tab : undefined;
  // A tab the address NAMES (a click on its link, or a deep link) takes focus (a screen reader says its name) and the
  // page opens at ITS TOP: the panel sits beside the list now, so there is nothing to scroll past. A bare /settings
  // steals no focus, and a Back/Forward/reload whose scroll was saved is the scroll memory's to put back.
  const pageRef = useRef<HTMLDivElement>(null);
  const named = tab === undefined ? undefined : active === undefined ? undefined : `${active.plugin}/${active.id}`;
  useEffect(() => {
    const page = pageRef.current;
    if (named === undefined || page === null || scroll.page(entryKey) !== null) return;
    page.focus({ preventScroll: true });
    for (let node = page.parentElement; node !== null; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') node.scrollTop = 0;
    }
  }, [named, entryKey, scroll]);
  return (
    <section className="fy-page fy-settings" data-settings-open={named === undefined ? 'list' : 'panel'}>
      <header className="fy-settings-head">
        {/* A phone's way back from a panel to the list of them (hidden wherever the list is beside the panel). */}
        <SettingsBackLink to={daemonSettingsHref(daemon)} />
        <h1>Settings</h1>
        {paired === undefined ? null : (
          <p className="fy-settings-machine">
            <span className="fy-settings-machine__name">{daemonTitle(paired)}</span>
            <span className="fy-settings-machine__state" data-online={online ? 'true' : 'false'}>
              {online ? 'Online' : 'Offline'}
            </span>
            {active === undefined ? null : (
              <span className="fy-settings-machine__scope" data-scope={scopeOf(active)}>
                {SCOPE_WORDS[scopeOf(active)]}
              </span>
            )}
          </p>
        )}
        {active === undefined ? null : <p className="fy-settings-title">{active.label}</p>}
      </header>
      <div className="fy-settings-body">
        <SettingsNav
          daemon={daemon}
          machine={paired === undefined ? 'This machine' : daemonTitle(paired)}
          tabs={tabs}
          active={active}
          named={named !== undefined}
        />
        {viewport === 'phone' ? null : <ResizeHandle panel="settings-nav" edge="end" label="settings list" />}
        {choice.kind === 'none' ? (
          <ShellLine>No plugin on this daemon has settings.</ShellLine>
        ) : choice.kind === 'missing' ? (
          <ShellLine>{`There is no settings tab called "${choice.name}" on this daemon. Pick one from the list.`}</ShellLine>
        ) : listOnly ? null : (
          <section ref={pageRef} className="fy-settings-page" aria-label={choice.tab.label} tabIndex={-1}>
            <PluginView daemon={daemon} plugin={choice.tab.plugin} section="settings" id={choice.tab.id} props={{}} />
          </section>
        )}
      </div>
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
      {/* Which layout is in use is a fact of its own, said quietly under the groups, not as a bare line of page text. */}
      <p className="m-0 px-1 pt-3 text-meta text-muted" data-layout-in-use="">
        Layout in use: <code>{layout.layout.id}</code>
        {layout.kind === 'refused' ? (
          <span className="text-warn" role="status">
            {` — the layout "${layout.refused}" was refused: ${layout.issues[0]?.message ?? 'a name it holds is not installed'}`}
          </span>
        ) : null}
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
