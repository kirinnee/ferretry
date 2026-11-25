import { SettingGroup } from '../compose/setting-row.tsx';
import { distinctDaemonName } from '../daemons/machine-names.ts';
import { daemonSettingsHref, deviceSettingsHref } from '../router/routes.ts';
import { useRouter } from '../router/router.tsx';
import { Loading } from '../ui/loading.tsx';
import { useRuntimeVersion, useShell } from './context.tsx';
import { CachedDataSetting } from './device-cached-data.tsx';
import { DeviceAppearance } from './device-appearance.tsx';
import { DevicePanels } from './device-panels.tsx';
import { Link } from './link.tsx';
import { useEffect } from 'react';

/**
 * This device's settings as a page of their own (§5.2): theme, mode, text size, motion; saved in this browser, never on a daemon.
 * This is the RECOVERY page: it is drawn only when there is no machine to put them inside of (an unpaired device, or a
 * selected machine whose pages are blocked, whose Connection link comes here). Everywhere else `/settings` (an old
 * bookmark) REPLACES itself with the section of the selected machine's Settings, `/d/<daemon>/settings/device`.
 */
export function DeviceSettingsPage() {
  const { runtime } = useShell();
  const router = useRouter();
  useRuntimeVersion(runtime);
  const daemons = runtime.daemons.groups().flatMap(group => group.daemons);
  // A selected, still-paired machine whose pages are not blocked: the section lives inside its Settings. No selection is
  // never guessed at (the list below names each machine), as Home does.
  const { selected } = runtime.daemons.snapshot();
  const inside =
    selected !== null && runtime.daemons.get(selected) !== undefined && runtime.wholeDaemonLine(selected) === undefined
      ? deviceSettingsHref(selected)
      : undefined;
  useEffect(() => {
    if (inside !== undefined) router.navigate(inside, { replace: true });
  }, [inside, router]);
  if (inside !== undefined) return <Loading className="fy-loading--fill" kind="page" label="Opening settings…" />;
  return (
    <section className="fy-page">
      <h1>This device</h1>
      {/* The way back: each paired daemon keeps its own settings (what it runs, who may reach it), apart from these. */}
      {daemons.length === 0 ? null : (
        <ul className="fy-settings-daemons" aria-label="Daemon settings">
          {daemons.map(daemon => (
            <li key={daemon.daemon}>
              <Link
                to={daemonSettingsHref(daemon.daemon)}
              >{`Settings for ${distinctDaemonName(daemon, daemons)}`}</Link>
            </li>
          ))}
        </ul>
      )}
      <DeviceSettingsBody />
    </section>
  );
}

/** What this device's settings hold, drawn by the bare device page and by the section of a machine's Settings alike. */
export function DeviceSettingsBody() {
  const { layout, scroll } = useShell();
  return (
    <>
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
    </>
  );
}
