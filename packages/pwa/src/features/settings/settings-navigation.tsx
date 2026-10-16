/**
 * Level two of Settings: which part of Settings is open, in the two forms the approved proposal draws.
 *
 * - DESKTOP — a sidebar list grouped "This device" (Appearance, Behaviour) and "Machines" (each paired
 *   machine by name with a status line, then "Add a machine"). The selected row is a soft filled pill
 *   with its own ink and a thin outline, never a side bar (`.kt-navpill`).
 * - PHONE — the same groups as inset cards on a recessed ground, one level per screen: a row opens its
 *   own screen, and that screen has "‹ Settings" to come back (`.kt-groupcard`).
 *
 * Daemons is gone as a section of its own: a machine is ONE place now, with its connection and
 * security on its Machine tab, so the list of machines here is the only machine picker in Settings.
 */

import { ChevronRight, Palette, Plus, SlidersHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { AccountStatus } from '../fleet/shell/account-status.tsx';
import { reachLabel, reachWord, type ShownReach, shownReachSummary } from '../fleet/shell/machine-reach.ts';
import { SETTINGS_SECTIONS, type SettingsSectionId } from './settings-catalog.ts';

/** One paired machine as Settings lists it. */
export interface SettingsMachineEntry {
  readonly daemonId: DaemonId;
  readonly name: string;
  readonly reach: ShownReach;
}

/** The sections that belong to this browser rather than to a machine, with their glyphs. */
const BROWSER_SECTIONS: readonly { readonly id: Exclude<SettingsSectionId, 'machines'>; readonly icon: ReactNode }[] = [
  { id: 'appearance', icon: <Palette size={16} aria-hidden="true" /> },
  { id: 'behaviour', icon: <SlidersHorizontal size={16} aria-hidden="true" /> },
];

const sectionLabel = (id: SettingsSectionId): string =>
  SETTINGS_SECTIONS.find(section => section.id === id)?.label ?? id;

export interface SettingsNavigationProps {
  readonly machines: readonly SettingsMachineEntry[];
  /** The section that is open; for Machines, `activeMachine` says which one. */
  readonly active: SettingsSectionId;
  readonly activeMachine: DaemonId;
  readonly onSection: (id: Exclude<SettingsSectionId, 'machines'>) => void;
  readonly onMachine: (daemonId: DaemonId) => void;
  readonly onAddMachine: () => void;
}

/** The desktop sidebar. */
export function SettingsSidebar({
  machines,
  active,
  activeMachine,
  onSection,
  onMachine,
  onAddMachine,
}: SettingsNavigationProps) {
  return (
    <nav aria-label="Settings" className="flex min-w-0 flex-col gap-3" data-settings-sidebar="">
      <div>
        <p className="kt-navgroup__title m-0" id="settings-group-browser">
          This device
        </p>
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-labelledby="settings-group-browser">
          {BROWSER_SECTIONS.map(section => (
            <li key={section.id}>
              <button
                type="button"
                className="kt-navpill"
                data-settings-section-choice={section.id}
                aria-current={active === section.id ? 'page' : undefined}
                onClick={() => onSection(section.id)}
              >
                <span className="flex w-4 shrink-0 justify-center" aria-hidden="true">
                  {section.icon}
                </span>
                <span className="min-w-0 flex-1 truncate">{sectionLabel(section.id)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="kt-navgroup__title m-0" id="settings-group-machines">
          Machines
        </p>
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-labelledby="settings-group-machines">
          {machines.map(machine => (
            <li key={machine.daemonId}>
              <button
                type="button"
                className="kt-navpill"
                data-settings-machine={String(machine.daemonId)}
                aria-current={active === 'machines' && machine.daemonId === activeMachine ? 'page' : undefined}
                onClick={() => onMachine(machine.daemonId)}
              >
                <span className="flex w-4 shrink-0 justify-center">
                  <AccountStatus word={reachWord(machine.reach)} label={reachLabel(machine.reach)} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{machine.name}</span>
                  <span className="kt-navpill__sub truncate">{shownReachSummary(machine.reach)}</span>
                </span>
              </button>
            </li>
          ))}
          <li>
            <button type="button" className="kt-navpill kt-navpill--add" data-machine-add="" onClick={onAddMachine}>
              <span className="flex w-4 shrink-0 justify-center" aria-hidden="true">
                <Plus size={16} />
              </span>
              <span className="min-w-0 flex-1">Add a machine</span>
            </button>
          </li>
        </ul>
      </div>
    </nav>
  );
}

function GroupRow({
  children,
  onClick,
  marker,
}: {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly marker: Record<string, string>;
}) {
  return (
    <button type="button" className="kt-grouprow" onClick={onClick} {...marker}>
      {children}
      <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted" />
    </button>
  );
}

/** The phone's first Settings screen: grouped cards you tap into. */
export function SettingsHome({
  machines,
  onSection,
  onMachine,
  onAddMachine,
}: Omit<SettingsNavigationProps, 'active' | 'activeMachine'>) {
  return (
    <nav aria-label="Settings" className="flex flex-col gap-5 py-2" data-settings-home="">
      <section className="flex flex-col gap-1.5" aria-labelledby="settings-home-browser">
        <h2 id="settings-home-browser" className="kt-navgroup__title m-0 px-1.5 py-0">
          This device
        </h2>
        <ul className="kt-groupcard m-0 list-none p-0">
          {BROWSER_SECTIONS.map(section => (
            <li key={section.id}>
              <GroupRow onClick={() => onSection(section.id)} marker={{ 'data-settings-section-choice': section.id }}>
                <span className="flex w-6 shrink-0 justify-center text-muted" aria-hidden="true">
                  {section.icon}
                </span>
                <span className="min-w-0 flex-1">{sectionLabel(section.id)}</span>
              </GroupRow>
            </li>
          ))}
        </ul>
        <p className="m-0 px-1.5 text-meta leading-base text-muted">
          Stored on this device only, never copied to a machine.
        </p>
      </section>

      <section className="flex flex-col gap-1.5" aria-labelledby="settings-home-machines">
        <h2 id="settings-home-machines" className="kt-navgroup__title m-0 px-1.5 py-0">
          Machines · {machines.length}
        </h2>
        {machines.length === 0 ? null : (
          <ul className="kt-groupcard m-0 list-none p-0">
            {machines.map(machine => (
              <li key={machine.daemonId}>
                <GroupRow
                  onClick={() => onMachine(machine.daemonId)}
                  marker={{ 'data-settings-machine': String(machine.daemonId) }}
                >
                  <span className="flex w-6 shrink-0 justify-center">
                    <AccountStatus word={reachWord(machine.reach)} label={reachLabel(machine.reach)} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-semibold">{machine.name}</span>
                    <span className="truncate text-meta text-muted">{shownReachSummary(machine.reach)}</span>
                  </span>
                </GroupRow>
              </li>
            ))}
          </ul>
        )}
        <div className="kt-groupcard mt-1.5">
          <button
            type="button"
            className="kt-grouprow justify-center font-semibold text-accent"
            data-machine-add=""
            onClick={onAddMachine}
          >
            <Plus size={16} aria-hidden="true" />
            Add a machine
          </button>
        </div>
        <p className="m-0 px-1.5 text-meta leading-base text-muted">
          Each machine keeps its own credentials, components, profiles and runtimes.
        </p>
      </section>
    </nav>
  );
}
