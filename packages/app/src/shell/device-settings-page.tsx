import { SettingGroup } from '../compose/setting-row.tsx';
import { daemonTitle } from '../daemons/daemon-list.ts';
import { daemonSettingsHref } from '../router/routes.ts';
import { useRuntimeVersion, useShell } from './context.tsx';
import { CachedDataSetting } from './device-cached-data.tsx';
import { DeviceAppearance } from './device-appearance.tsx';
import { DevicePanels } from './device-panels.tsx';
import { Link } from './link.tsx';

/** This device's settings (§5.2): theme, mode, text size, motion; saved in this browser, never on a daemon. */
export function DeviceSettingsPage() {
  const { runtime } = useShell();
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
