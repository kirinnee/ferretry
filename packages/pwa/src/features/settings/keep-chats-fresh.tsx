/**
 * Settings › This device › KEEP RECENT CHATS FRESH, and its "Not on cellular" companion — two compact rows.
 *
 * The interactive chats and the 40 most recently opened ones are read in the background (`lib/background-fresh.ts`),
 * so switching to one draws the current conversation at once. It spends this device's data and battery, which is why
 * it is a choice: off stops all of it, and "Not on cellular" holds it back where the browser can tell the link is
 * cellular (Chromium only; elsewhere that switch has nothing to act on, and says so).
 */

import type { DeviceControls } from '../../lib/controls.ts';
import { SettingRow, SettingSwitch } from './setting-row.tsx';
import { settingDefinition } from './settings-catalog.ts';

export interface KeepChatsFreshSettingProps {
  readonly device: Pick<DeviceControls, 'keepChatsFresh' | 'keepChatsFreshNotOnCellular'>;
  readonly onChange: (patch: Partial<Pick<DeviceControls, 'keepChatsFresh' | 'keepChatsFreshNotOnCellular'>>) => void;
}

export function KeepChatsFreshSetting({ device, onChange }: KeepChatsFreshSettingProps) {
  return (
    <>
      <SettingRow
        settingId="keep-chats-fresh"
        name="Keep recent chats fresh"
        hint="The 40 you opened last stay up to date"
        explanation={`${settingDefinition('keep-chats-fresh').description} Interactive chats and the 40 you opened last stay up to date, so switching to one is instant. Paused while this tab is hidden or your browser asks to save data.`}
        control={labelId => (
          <SettingSwitch
            checked={device.keepChatsFresh}
            labelledBy={labelId}
            onChange={keepChatsFresh => onChange({ keepChatsFresh })}
          />
        )}
      />
      {device.keepChatsFresh ? (
        <SettingRow
          name="Not on cellular"
          hint="Hold off on mobile data"
          explanation="Hold off while the browser says this device is on mobile data. Not every browser can tell."
          control={labelId => (
            <SettingSwitch
              checked={device.keepChatsFreshNotOnCellular}
              labelledBy={labelId}
              onChange={keepChatsFreshNotOnCellular => onChange({ keepChatsFreshNotOnCellular })}
            />
          )}
        />
      ) : null}
    </>
  );
}
