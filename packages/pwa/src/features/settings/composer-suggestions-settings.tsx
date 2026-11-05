/**
 * Settings › Behaviour › "Open suggestions with" — which keys open the composer's reference menu.
 *
 * Suggestions and grammar are deliberately different facts. Every choice here governs an offer —
 * whether typing a key opens the autocomplete popover — and none of them governs what the app
 * understands: a reference typed, pasted, or inserted by the transcript's Add to chat is parsed,
 * proved and linked exactly the same either way. The copy says that out loud (behind the row's (i)),
 * because a reader who reads "off" as "references stop working" would keep a menu they do not want
 * rather than lose a feature they do.
 *
 * The values live in `lib/controls.ts`, which is the sole owner of the browser key: these are
 * properties of the reader's screen, so they are shared by every paired daemon and switching daemon
 * must not change them. This surface holds no storage and no state of its own.
 */

import { type DeviceControls, SUGGESTION_KEYS, type SuggestionKeys } from '../../lib/controls.ts';
import { OptionNotes, Segmented, SettingRow, SettingSwitch } from './setting-row.tsx';
import { settingDefinition } from './settings-catalog.ts';

type ComposerSuggestionPreferences = Pick<DeviceControls, 'suggestionKeys' | 'skillSuggestions'>;

export const COMPOSER_SUGGESTIONS_EXPLANATION =
  'This changes what the composer offers, not what it understands. A key that opens no menu is ordinary text while you type; a reference you write or paste yourself still resolves and still links, and Add to chat is unaffected.';

export const COMPOSER_SUGGESTIONS_UNGOVERNED_NOTE =
  'The / commands and skills menu and the % terminals and browser menu open in every mode.';

interface KeysCopy {
  readonly label: string;
  readonly detail: string;
}

/** A mapped record rather than a list: a fourth mode is a compile error HERE until it has copy. */
const KEYS_COPY = {
  ladder: {
    label: '@ ladder',
    detail: '@ files · @@ agents · @@@ agenda · @@@@ tasks. Typing : ! or & in normal text never pops a menu.',
  },
  symbols: {
    label: 'Symbols',
    detail: '@ files · : agents · ! agenda · & tasks · % terminals. Faster once you know them.',
  },
  both: { label: 'Both', detail: 'Either way works.' },
} as const satisfies Record<SuggestionKeys, KeysCopy>;

export function ComposerSuggestionsSettings({
  preferences,
  onChange,
}: {
  /** Current device-local values, read by the host from the controls store. */
  readonly preferences: ComposerSuggestionPreferences;
  /** One field at a time; the host decides where a patch is persisted. */
  readonly onChange: (patch: Partial<ComposerSuggestionPreferences>) => void;
}) {
  const skills = preferences.skillSuggestions;
  return (
    <>
      <SettingRow
        settingId="composer-suggestions"
        name="Open suggestions with"
        hint={KEYS_COPY[preferences.suggestionKeys].detail}
        explanation={
          <>
            <p className="m-0">{settingDefinition('composer-suggestions').description}</p>
            <OptionNotes notes={SUGGESTION_KEYS.map(value => KEYS_COPY[value])} />
            <p className="m-0 mt-2">{COMPOSER_SUGGESTIONS_EXPLANATION}</p>
            <p className="m-0 mt-2 text-faint">{COMPOSER_SUGGESTIONS_UNGOVERNED_NOTE}</p>
          </>
        }
        wide
        control={() => (
          <Segmented
            label="Open suggestions with"
            value={preferences.suggestionKeys}
            options={SUGGESTION_KEYS.map(value => ({
              id: value,
              label: KEYS_COPY[value].label,
              title: KEYS_COPY[value].detail,
            }))}
            onChange={suggestionKeys => onChange({ suggestionKeys })}
          />
        )}
      />
      <SettingRow
        name="Suggest $ skills"
        hint="The $name skill form only."
        control={labelId => (
          <SettingSwitch
            checked={skills}
            labelledBy={labelId}
            onChange={skillSuggestions => onChange({ skillSuggestions })}
          />
        )}
      />
    </>
  );
}
