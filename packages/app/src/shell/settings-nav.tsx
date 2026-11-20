import { ChevronRight } from 'lucide-react';
import { useId, useLayoutEffect, useRef } from 'react';
import { daemonSettingsHref, DEVICE_SETTINGS_HREF } from '../router/routes.ts';
import { useRouter } from '../router/router.tsx';
import { SelectBox, type SelectOption } from '../ui/select-box.tsx';
import { Icon } from './icons.tsx';
import { Link } from './link.tsx';
import {
  DEVICE_BLOCK_HEADING,
  groupSettingsTabs,
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
  const listRef = useRef<HTMLElement>(null);
  const router = useRouter();
  const pickerId = useId();
  // The list beside the panel scrolls inside itself: bring the current tab into view by the scroller's own scroll and never the
  // page's (`scrollIntoView` would move every ancestor too). Above the panel (a mid-width window) there is no list to scroll, only
  // the picker below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `active` is when the current tab changes; the effect reads it from the DOM.
  useLayoutEffect(() => {
    const list = listRef.current;
    const current = list?.querySelector<HTMLElement>('.fy-tab--active');
    if (list === null || current === null || current === undefined) return;
    for (const scroller of [current.closest<HTMLElement>('.fy-settings-block'), list]) {
      if (scroller === null || scroller.scrollHeight <= scroller.clientHeight) continue;
      const edge = scroller.getBoundingClientRect();
      const at = current.getBoundingClientRect();
      if (at.bottom > edge.bottom) scroller.scrollTop += at.bottom - edge.bottom + 8;
      else if (at.top < edge.top) scroller.scrollTop -= edge.top - at.top + 8;
    }
  }, [active]);
  const { device, machine: machineTabs } = splitTabsByScope(tabs);
  const groups = (list: readonly NavTab[]) =>
    groupSettingsTabs(list).map(group => (
      <details key={group.id} className="fy-tab-group" open={group.tabs.some(candidate => candidate === active)}>
        <summary className="fy-tab-group__title">
          {group.label}
          <ChevronRight className="fy-tab-group__chevron" size={16} aria-hidden="true" />
        </summary>
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
  const hrefOf = (tab: NavTab): string => daemonSettingsHref(daemon, tab.plugin, tab.id);
  /** The mid-width picker: every page of both blocks, in the same titled groups, as one grouped select that is always fully visible. */
  const optionsOf = (blockTitle: string, list: readonly NavTab[], first?: SelectOption): SelectOption[] => {
    const grouped = groupSettingsTabs(list).flatMap((group, index): SelectOption[] => [
      ...(index === 0 && first !== undefined ? [{ ...first, group: `${blockTitle} · ${group.label}` }] : []),
      ...group.tabs.map(candidate => ({
        value: hrefOf(candidate),
        label: candidate.label,
        group: `${blockTitle} · ${group.label}`,
      })),
    ]);
    return grouped.length === 0 && first !== undefined ? [{ ...first, group: blockTitle }] : grouped;
  };
  const pickerOptions = [
    ...optionsOf(DEVICE_BLOCK_HEADING, device, { value: DEVICE_SETTINGS_HREF, label: 'This device' }),
    ...optionsOf(`${machine} · every device`, machineTabs),
  ];
  return (
    <nav ref={listRef} className="fy-tabs fy-tabs--grouped fy-settings-nav" aria-label="Plugin settings">
      <div className="fy-settings-picker" data-settings-picker="">
        <label className="fy-settings-picker__label" htmlFor={pickerId}>
          Settings page
        </label>
        <SelectBox
          id={pickerId}
          className="fy-settings-picker__select"
          label="Settings page"
          onChange={href => router.navigate(href)}
          options={pickerOptions}
          value={active === undefined ? DEVICE_SETTINGS_HREF : hrefOf(active)}
        />
      </div>
      <section aria-labelledby="fy-settings-block-device" className="fy-settings-block">
        <p className="fy-settings-block__title" id="fy-settings-block-device">
          {DEVICE_BLOCK_HEADING}
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
