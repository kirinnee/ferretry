/**
 * Settings › This device › "OPEN LINKS IN" (S-0519; shell contract S7): the `device.settings` panel for where a tap on an
 * external link opens. It reads and writes only this device's controls (`openLinksIn`), so it needs no machine; the
 * behaviour itself is what Browsers provides to the shell per machine (`lib/link-provision.ts`).
 *
 * "Your computer's default browser" is offered on every machine: the shell does not say which daemon shares this
 * computer, so the daemon decides (its route is for a caller on the host) and a link it refuses opens in this browser and
 * says so. The explanation names that.
 */

import { OPEN_LINKS_IN, type OpenLinksIn, Segmented, SettingGroup, SettingRow, useDeviceControls } from '@ferretry/app';
import type { ReactNode } from 'react';

const LABEL: Readonly<Record<OpenLinksIn, string>> = {
  browser: 'Your browser',
  panel: 'Ferretry side panel',
  computer: "Your computer's default browser",
};

const NOTES: readonly (readonly [OpenLinksIn, string])[] = [
  ['browser', 'A new tab in this browser (the real Safari from the installed app on an iPhone or iPad). The default.'],
  ['panel', "Ferretry's own preview, so the conversation stays where it is. Some sites refuse to be shown in a frame."],
  [
    'computer',
    'The default browser of the computer the machine runs on, so a link router can choose the profile. A machine that is not on this computer cannot do it: the link opens in this browser instead, and says so.',
  ],
];

export function OpenLinksInPanel(): ReactNode {
  const { device, set } = useDeviceControls();
  return (
    <SettingGroup label="Links">
      <SettingRow
        settingId="open-links-in"
        name="Open links in"
        hint="Cmd/Ctrl-click always opens a new tab"
        explanation={
          <ul className="m-0 list-none space-y-1 p-0" data-open-links-notes="">
            {NOTES.map(([id, text]) => (
              <li key={id}>
                <strong className="font-semibold text-fg">{LABEL[id]}.</strong> {text}
              </li>
            ))}
          </ul>
        }
        wide
        control={() => (
          <Segmented
            label="Open links in"
            value={device.openLinksIn}
            options={OPEN_LINKS_IN.map(id => ({ id, label: LABEL[id] }))}
            onChange={openLinksIn => set({ openLinksIn })}
          />
        )}
      />
    </SettingGroup>
  );
}
