/**
 * Settings › This device › KEEP RECENT CHATS FRESH.
 *
 * The interactive chats and the 40 most recently opened ones are read in the background (`lib/background-fresh.ts`),
 * so switching to one draws the current conversation at once. It spends this device's data and battery, which is why
 * it is a choice: off stops all of it, and "Not on cellular" holds it back where the browser can tell the link is
 * cellular (Chromium only; elsewhere that switch has nothing to act on, and says so).
 */

import type { DeviceControls } from '../../lib/controls.ts';
import { PanelSwitch } from './dictation-debug-settings.tsx';

export interface KeepChatsFreshSettingProps {
  readonly device: Pick<DeviceControls, 'keepChatsFresh' | 'keepChatsFreshNotOnCellular'>;
  readonly onChange: (patch: Partial<Pick<DeviceControls, 'keepChatsFresh' | 'keepChatsFreshNotOnCellular'>>) => void;
}

export function KeepChatsFreshSetting({ device, onChange }: KeepChatsFreshSettingProps) {
  return (
    <div className="grid gap-2" data-keep-chats-fresh={device.keepChatsFresh ? 'on' : 'off'}>
      <PanelSwitch
        checked={device.keepChatsFresh}
        label="Keep recent chats fresh in the background"
        detail="Interactive chats and the 40 you opened last stay up to date, so switching to one is instant. Paused while this tab is hidden or your browser asks to save data."
        onChange={keepChatsFresh => onChange({ keepChatsFresh })}
      />
      {device.keepChatsFresh ? (
        <PanelSwitch
          checked={device.keepChatsFreshNotOnCellular}
          label="Not on cellular"
          detail="Hold off while the browser says this device is on mobile data. Not every browser can tell."
          onChange={keepChatsFreshNotOnCellular => onChange({ keepChatsFreshNotOnCellular })}
        />
      ) : null}
    </div>
  );
}
