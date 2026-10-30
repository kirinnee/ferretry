/**
 * Settings › Behaviour › "Open suggestions with" — which keys open the composer's reference menu.
 *
 * Suggestions and grammar are deliberately different facts. Every choice here governs an offer —
 * whether typing a key opens the autocomplete popover — and none of them governs what the app
 * understands: a reference typed, pasted, or inserted by the transcript's Add to chat is parsed,
 * proved and linked exactly the same either way. The copy says that out loud, because a reader who
 * reads "off" as "references stop working" would keep a menu they do not want rather than lose a
 * feature they do.
 *
 * The values live in `lib/controls.ts`, which is the sole owner of the browser key: these are
 * properties of the reader's screen, so they are shared by every paired daemon and switching daemon
 * must not change them. This surface holds no storage and no state of its own.
 */

import { cn } from '../../lib/class-names.ts';
import { type DeviceControls, SUGGESTION_KEYS, type SuggestionKeys } from '../../lib/controls.ts';

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

function KeysOption({
  value,
  checked,
  onSelect,
}: {
  readonly value: SuggestionKeys;
  readonly checked: boolean;
  readonly onSelect: (value: SuggestionKeys) => void;
}) {
  const copy = KEYS_COPY[value];
  return (
    <label
      className={cn(
        'flex min-h-[44px] cursor-pointer items-start gap-3 rounded-control border px-control-x py-2',
        checked ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2 hover:border-accent',
      )}
      data-suggestion-keys={value}
    >
      <input
        checked={checked}
        className="mt-1 accent-[var(--accent)]"
        name="composer-suggestion-keys"
        onChange={() => onSelect(value)}
        type="radio"
        value={value}
      />
      <span className="min-w-0">
        <span className={cn('block text-ui font-semibold', checked ? 'text-accent' : 'text-fg')}>{copy.label}</span>
        <span className="mt-0.5 block text-meta leading-base text-muted">{copy.detail}</span>
      </span>
    </label>
  );
}

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
    <div className="flex flex-col gap-2">
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-ui font-semibold text-fg">Open suggestions with</legend>
        {SUGGESTION_KEYS.map(value => (
          <KeysOption
            checked={preferences.suggestionKeys === value}
            key={value}
            onSelect={next => onChange({ suggestionKeys: next })}
            value={value}
          />
        ))}
      </fieldset>
      <button
        type="button"
        role="switch"
        aria-checked={skills}
        onClick={() => onChange({ skillSuggestions: !skills })}
        className={cn(
          'flex min-h-[44px] w-full items-center justify-between gap-3 rounded-control border px-control-x py-2 text-left',
          skills ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2 hover:border-accent',
        )}
      >
        <span className="min-w-0">
          <span className={cn('block text-ui font-semibold', skills ? 'text-accent' : 'text-fg')}>
            Suggest $ skills
          </span>
          <span className="mt-0.5 block text-meta leading-base text-muted">The $name skill form only.</span>
        </span>
        <span
          aria-hidden="true"
          className={cn(
            'relative h-6 w-11 shrink-0 rounded-full border',
            skills ? 'border-accent bg-accent' : 'border-border-strong bg-surface',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-[18px] w-[18px] rounded-full bg-fg transition-transform',
              skills ? 'translate-x-[20px]' : 'translate-x-0.5',
            )}
          />
        </span>
      </button>
      <p className="m-0 text-cell leading-base text-muted">{COMPOSER_SUGGESTIONS_EXPLANATION}</p>
      <p className="m-0 text-meta leading-base text-faint">{COMPOSER_SUGGESTIONS_UNGOVERNED_NOTE}</p>
    </div>
  );
}
