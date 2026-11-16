/**
 * The `device.settings` panels Ferrets draws on Settings › This device (shell contract S4): no daemon and no client,
 * because each reads and writes only this device's controls.
 *
 * "Group Needs you at the top" (S-0486, v4's Appearance › Layout row): whether the ferret list gathers the ferrets with
 * open Inbox items into a "Needs you" group at the top. Off keeps them in their folders, with just the count badge.
 */

import { SettingGroup, SettingRow, SettingSwitch, useDeviceControls } from '@ferretry/app';
import type { ReactNode } from 'react';

function NeedsYouPanel(): ReactNode {
  const { device, set } = useDeviceControls();
  return (
    <SettingGroup label="Ferret list">
      <SettingRow
        settingId="group-needs-you"
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
    </SettingGroup>
  );
}

export const deviceSettingsPanels = { 'needs-you': NeedsYouPanel } as const;
