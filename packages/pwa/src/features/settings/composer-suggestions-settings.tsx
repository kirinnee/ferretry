/**
 * Settings controls for which composer reference families OFFER a menu.
 *
 * Suggestions and grammar are deliberately different facts. Every switch here
 * governs an offer — whether typing a sigil opens the autocomplete popover —
 * and none of them governs what the app understands: a reference typed, pasted,
 * or inserted by the transcript's Add to chat is parsed, proved and linked
 * exactly the same either way. The copy says that out loud, because a reader
 * who reads "off" as "references stop working" would keep a menu they do not
 * want rather than lose a feature they do.
 *
 * The values live in `lib/controls.ts`, which is the sole owner of the browser
 * key: these are properties of the reader's screen, so they are shared by every
 * paired daemon and switching daemon must not change them. This surface holds
 * no storage and no state of its own.
 */

import { cn } from '../../lib/class-names.ts';
import type { DeviceControls } from '../../lib/controls.ts';

/** The suggestion families, named against their owner rather than restated. */
type ComposerSuggestionPreferences = Pick<
  DeviceControls,
  'mentionSuggestions' | 'directReferenceSuggestions' | 'skillSuggestions'
>;

export const COMPOSER_SUGGESTIONS_EXPLANATION =
  'These switches change what the composer offers, not what it understands. With a family off, its sigil is ordinary text while you type and no menu opens; a reference you write or paste yourself still resolves and still links, and Add to chat is unaffected.';

export const COMPOSER_SUGGESTIONS_UNGOVERNED_NOTE =
  'The / command menu is never suppressed, and the % terminal and browser surfaces are not affected by any of these.';

interface SuggestionCopy {
  readonly label: string;
  readonly detail: string;
}

/**
 * A mapped type rather than a list: a fourth suggestion family added to
 * `ComposerSuggestionPreferences` is a compile error HERE until it has copy,
 * instead of a switch that quietly never renders.
 */
const SUGGESTION_COPY = {
  mentionSuggestions: {
    label: 'Suggest @ references',
    detail: 'The whole @ ladder — files with @, agents with @@, tasks with @@@, attention with @@@@.',
  },
  directReferenceSuggestions: {
    label: 'Suggest : & ! references',
    detail: 'The single-sigil forms: :agent, &task and !attention.',
  },
  skillSuggestions: {
    label: 'Suggest $ skills',
    detail: 'The $name skill form only.',
  },
} as const satisfies { readonly [K in keyof ComposerSuggestionPreferences]: SuggestionCopy };

const SUGGESTION_FIELDS = Object.keys(SUGGESTION_COPY) as readonly (keyof ComposerSuggestionPreferences)[];

function SuggestionSwitch({
  checked,
  label,
  detail,
  onChange,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly detail: string;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'flex min-h-[44px] w-full items-center justify-between gap-3 rounded-control border px-control-x py-2 text-left transition-colors',
        checked ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2 hover:border-accent',
      )}
    >
      <span className="min-w-0">
        <span className={cn('block text-ui font-semibold', checked ? 'text-accent' : 'text-fg')}>{label}</span>
        <span className="mt-0.5 block text-meta leading-base text-muted">{detail}</span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'relative h-6 w-11 shrink-0 rounded-full border transition-colors',
          checked ? 'border-accent bg-accent' : 'border-border-strong bg-surface',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-[18px] w-[18px] rounded-full bg-fg transition-transform',
            checked ? 'translate-x-[20px]' : 'translate-x-0.5',
          )}
        />
      </span>
    </button>
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
  return (
    <div className="flex flex-col gap-2">
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" aria-label="Composer reference suggestions">
        {SUGGESTION_FIELDS.map(field => (
          <SuggestionSwitch
            key={field}
            checked={preferences[field]}
            label={SUGGESTION_COPY[field].label}
            detail={SUGGESTION_COPY[field].detail}
            onChange={next => onChange({ [field]: next })}
          />
        ))}
      </fieldset>
      <p className="m-0 text-ui leading-base text-muted">{COMPOSER_SUGGESTIONS_EXPLANATION}</p>
      <p className="m-0 text-meta leading-base text-faint">{COMPOSER_SUGGESTIONS_UNGOVERNED_NOTE}</p>
    </div>
  );
}
