/**
 * The `device.settings` panels Ferrets draws on Settings › This device (shell contract S4): no daemon and no client,
 * because each reads and writes only this device's controls.
 *
 * "Group Needs you at the top" (S-0486, v4's Appearance › Layout row): whether the ferret list gathers the ferrets with
 * open Inbox items into a "Needs you" group at the top. Off keeps them in their folders, with just the count badge.
 */

import { Segmented, SettingGroup, SettingRow, SettingSwitch, useDeviceControls } from '@ferretry/app';
import type { ReactNode } from 'react';
import { DensityPreview, NeedsYouPreview } from './device-settings-previews.tsx';

const DENSITY_OPTIONS = [
  { id: 'full', label: 'Full' },
  { id: 'compact', label: 'Compact' },
  { id: 'minimal', label: 'Minimal' },
] as const;
const DENSITY_LABEL = { full: 'Full', compact: 'Compact', minimal: 'Minimal' } as const;

function NeedsYouPanel(): ReactNode {
  const { device, set } = useDeviceControls();
  return (
    <SettingGroup label="Ferret list">
      <SettingRow
        settingId="group-needs-you"
        preview={<NeedsYouPreview grouped={device.groupNeedsYou} />}
        name="Group Needs you at the top"
        hint="Sessions with open Inbox items go first"
        explanation="Lift the ferrets with open Inbox items into a Needs you group at the top of the ferret list. Off keeps those ferrets in their project group, with just the Inbox badge. Applies to this device."
        control={labelId => (
          <SettingSwitch
            checked={device.groupNeedsYou}
            labelledBy={labelId}
            onChange={groupNeedsYou => set({ groupNeedsYou })}
          />
        )}
      />
      <SettingRow
        settingId="density"
        preview={<DensityPreview density={device.density ?? 'full'} />}
        name="Density"
        hint={`Device default: ${DENSITY_LABEL[device.density ?? 'full']}`}
        explanation="How much each ferret shows in the list. Full is the list as drawn; Compact drops the folder and the marks (the title, the ferret and what it asks stay); Minimal is one line, the title and its badge. Applies to this device."
        wide
        control={() => (
          <div className="w-full md:w-72">
            <Segmented
              fill
              label="Density"
              value={device.density ?? 'full'}
              options={DENSITY_OPTIONS}
              onChange={density => set({ density })}
            />
          </div>
        )}
      />
    </SettingGroup>
  );
}

export const deviceSettingsPanels = { 'needs-you': NeedsYouPanel } as const;
