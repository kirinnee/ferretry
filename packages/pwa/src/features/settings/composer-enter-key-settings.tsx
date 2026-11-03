/**
 * Settings › Composer › Send key — one segmented row for a keyboard, one for a phone, both browser-local.
 *
 * They are separate because the two devices disagree about the obvious answer: on a keyboard Enter
 * sending is what every chat app does and Shift+Enter is right there; on a phone the return key is
 * the only way to start a new line, and the ↑ button is always on screen to send. ⌘/Ctrl+Enter sends
 * on every device whichever is chosen, so neither action is ever unreachable — said behind the first
 * row's (i).
 */

import type { ComposerEnterKeyPreference } from '../../lib/composer-keybinding.ts';
import { OptionNotes, Segmented, SettingRow } from './setting-row.tsx';
import { settingDefinition } from './settings-catalog.ts';

export interface ComposerEnterKeySettingsProps {
  /** A keyboard's bare Enter. null = the default, Enter sends. */
  readonly preference: ComposerEnterKeyPreference | null;
  /** A phone's return key. null = the default, return starts a new line. */
  readonly phonePreference: ComposerEnterKeyPreference | null;
  readonly onChange: (patch: {
    readonly composerEnterKey?: ComposerEnterKeyPreference;
    readonly composerPhoneEnterKey?: ComposerEnterKeyPreference;
  }) => void;
}

interface SendKeyOption {
  readonly id: ComposerEnterKeyPreference;
  readonly label: string;
  readonly description: string;
}

const DESKTOP: readonly SendKeyOption[] = [
  { id: 'send', label: '↵ sends', description: '⇧↵ starts a new line.' },
  { id: 'newline', label: '⌘/Ctrl+↵ sends', description: '↵ starts a new line.' },
];

const PHONE: readonly SendKeyOption[] = [
  { id: 'newline', label: 'Return = new line', description: 'The ↑ button sends.' },
  { id: 'send', label: 'Return sends', description: 'A New line button appears beside it.' },
];

export const SEND_KEY_ALWAYS_NOTE = '⌘/Ctrl+↵ always sends, on every device.';

export function ComposerEnterKeySettings({ preference, phonePreference, onChange }: ComposerEnterKeySettingsProps) {
  const keyboard = preference ?? 'send';
  const phone = phonePreference ?? 'newline';
  return (
    <>
      <SettingRow
        settingId="composer-enter-key"
        name="Send key on a keyboard"
        hint={DESKTOP.find(option => option.id === keyboard)?.description}
        explanation={
          <>
            <p className="m-0">{settingDefinition('composer-enter-key').description}</p>
            <OptionNotes notes={DESKTOP.map(option => ({ label: option.label, detail: option.description }))} />
            <p className="m-0 mt-2">{SEND_KEY_ALWAYS_NOTE}</p>
          </>
        }
        wide
        control={() => (
          <Segmented
            label="On a keyboard"
            value={keyboard}
            options={DESKTOP.map(option => ({ id: option.id, label: option.label, title: option.description }))}
            onChange={id => onChange({ composerEnterKey: id })}
          />
        )}
      />
      <SettingRow
        name="Send key on a phone"
        hint={PHONE.find(option => option.id === phone)?.description}
        explanation={<OptionNotes notes={PHONE.map(option => ({ label: option.label, detail: option.description }))} />}
        wide
        control={() => (
          <Segmented
            label="On a phone"
            value={phone}
            options={PHONE.map(option => ({ id: option.id, label: option.label, title: option.description }))}
            onChange={id => onChange({ composerPhoneEnterKey: id })}
          />
        )}
      />
    </>
  );
}
