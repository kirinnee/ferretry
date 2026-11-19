import { daemonSettingsHref, DEVICE_SETTINGS_HREF } from '../router/routes.ts';
import { Icon } from './icons.tsx';
import { Link } from './link.tsx';
import {
  groupSettingsTabs,
  SCOPE_WORDS,
  splitTabsByScope,
  type GroupableTab,
  type SettingsScope,
} from './settings-tab.ts';

/** What the nav needs of a tab to list it. */
export interface NavTab extends GroupableTab {
  readonly label: string;
  readonly icon?: string;
  readonly scope?: SettingsScope;
}

/**
 * THE SETTINGS LIST, split by WHERE a setting is kept: a block for this browser (the device page and every tab that
 * declares `scope: 'device'`) and a block for the machine (every device paired to it sees these). Each block holds its
 * tabs under their titled groups, only the group holding the current tab open. Text is the body colour and icons are
 * muted: the accent is spent on the one current item (a 3px bar and a soft fill), never on every link.
 */
export function SettingsNav({
  daemon,
  machine,
  tabs,
  active,
  named,
}: {
  readonly daemon: string;
  /** The machine's name, as the second block's heading says it. */
  readonly machine: string;
  readonly tabs: readonly NavTab[];
  readonly active: NavTab | undefined;
  /** A tab is named by the address (so the list marks it current for assistive tech, not just by colour). */
  readonly named: boolean;
}) {
  const { device, machine: machineTabs } = splitTabsByScope(tabs);
  const groups = (list: readonly NavTab[]) =>
    groupSettingsTabs(list).map(group => (
      <details key={group.id} className="fy-tab-group" open={group.tabs.some(candidate => candidate === active)}>
        <summary className="fy-tab-group__title">{group.label}</summary>
        <div className="fy-tab-group__tabs">
          {group.tabs.map(candidate => (
            <Link
              key={`${candidate.plugin}.${candidate.id}`}
              to={daemonSettingsHref(daemon, candidate.plugin, candidate.id)}
              className={candidate === active ? 'fy-tab fy-tab--active' : 'fy-tab'}
              current={candidate === active && named}
            >
              <Icon name={candidate.icon} />
              {candidate.label}
            </Link>
          ))}
        </div>
      </details>
    ));
  return (
    <nav className="fy-tabs fy-tabs--grouped fy-settings-nav" aria-label="Plugin settings">
      <section aria-labelledby="fy-settings-block-device" className="fy-settings-block">
        <p className="fy-settings-block__title" id="fy-settings-block-device">
          {SCOPE_WORDS.device}
        </p>
        {/* This device's own settings (theme, text size, motion, notifications…) are saved in this browser, not on a daemon:
        the shell's own entry. Its address is the one a reload still serves. */}
        <Link to={DEVICE_SETTINGS_HREF} className="fy-tab fy-settings-device">
          <Icon name="monitor" />
          This device
        </Link>
        {groups(device)}
      </section>
      {machineTabs.length === 0 ? null : (
        <section aria-labelledby="fy-settings-block-machine" className="fy-settings-block">
          <p className="fy-settings-block__title" id="fy-settings-block-machine">
            {`${machine} · every device`}
          </p>
          {groups(machineTabs)}
        </section>
      )}
    </nav>
  );
}
