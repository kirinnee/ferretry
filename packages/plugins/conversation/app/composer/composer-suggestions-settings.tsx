/**
 * Settings › Behaviour › "Open suggestions with" — which keys open the composer's reference menu.
 *
 * Suggestions and grammar are deliberately different facts. Every choice here governs an offer —
 * whether typing a key opens the autocomplete popover — and none of them governs what the app
 * understands: a reference typed, pasted, or inserted by the transcript's Add to chat is parsed,
 * proved and linked exactly the same either way. The copy says that out loud (behind the (i), one tap
 * away), because a reader who reads "off" as "references stop working" would keep a menu they do not
 * want rather than lose a feature they do.
 *
 * Three cards sit in a row, the keys each opens as a mono line; the selected mode's meaning is the one
 * line below them (only what is selected), and the preview beside them shows that mode alone. The
 * values live in `lib/controls.ts`, which is the sole owner of the browser key: these are properties
 * of the reader's screen, so they are shared by every paired daemon and switching daemon must not
 * change them. This surface holds no storage; the open/closed (i) is its only state.
 */

import { ChoiceCards, cn, type DeviceControls, SUGGESTION_KEYS, type SuggestionKeys } from '@ferretry/app';
import { Info } from 'lucide-react';
import { useState } from 'react';
import { SuggestionsPreview } from './previews/index.ts';
import './composer-suggestions-settings.css';

type ComposerSuggestionPreferences = Pick<DeviceControls, 'suggestionKeys' | 'skillSuggestions'>;

export const COMPOSER_SUGGESTIONS_EXPLANATION =
  'This changes what the composer offers, not what it understands. A key that opens no menu is ordinary text while you type; a reference you write or paste yourself still resolves and still links, and Add to chat is unaffected.';

export const COMPOSER_SUGGESTIONS_UNGOVERNED_NOTE =
  'The / commands and skills menu and the % terminals and browser menu open in every mode.';

/** The one-line intro; the longer words are behind the (i). */
export const COMPOSER_SUGGESTIONS_INTRO = 'Which keys open the reference menu.';

interface KeysCopy {
  readonly label: string;
  /** The keys, short enough to sit on the card as one mono line. */
  readonly keys: string;
  /** What they open: shown once, for the selected card only. */
  readonly detail: string;
}

/** A mapped record rather than a list: a fourth mode is a compile error HERE until it has copy. */
const KEYS_COPY = {
  ladder: {
    label: '@ ladder',
    keys: '@ @@ @@@ @@@@ %',
    detail:
      '@ files · @@ agents · @@@ asks · @@@@ tasks · % terminals. Typing : ! or & in normal text never pops a menu.',
  },
  symbols: {
    label: 'Symbols',
    keys: '@ : ! & %',
    detail: '@ files · : agents · ! asks · & tasks · % terminals. Faster once you know them.',
  },
  both: {
    label: 'Both',
    keys: '@ @@ @@@ @@@@ : ! & %',
    detail: '@ files · @@ or : agents · @@@ or ! asks · @@@@ or & tasks · % terminals. Either way works.',
  },
} as const satisfies Record<SuggestionKeys, KeysCopy>;

const OPTIONS = SUGGESTION_KEYS.map(id => ({
  id,
  title: KEYS_COPY[id].label,
  line: KEYS_COPY[id].keys,
}));

/** The (i): a small button that sits at the end of the line it explains. */
function InfoButton({
  label,
  open,
  onToggle,
}: {
  readonly label: string;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      aria-expanded={open}
      aria-label={label}
      className="ml-1 inline-flex h-6 w-6 items-center justify-center rounded-full align-middle text-muted hover:text-fg"
      onClick={onToggle}
      type="button"
    >
      <Info aria-hidden="true" size={16} />
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
  const [more, setMore] = useState(false);
  // The (i) travels with the last word, so it is never left alone on a line of its own.
  const detail = KEYS_COPY[preferences.suggestionKeys].detail;
  const cut = detail.lastIndexOf(' ') + 1;
  const lead = detail.slice(0, cut);
  const last = detail.slice(cut);
  const skills = preferences.skillSuggestions;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
        <div className="flex min-w-0 flex-1 basis-[34rem] flex-col gap-3">
          <div className="fy-cs-keys">
            <ChoiceCards
              label="Open suggestions with"
              onChange={next => onChange({ suggestionKeys: next as SuggestionKeys })}
              options={OPTIONS}
              value={preferences.suggestionKeys}
            />
          </div>
          <p className="m-0 text-meta leading-base text-muted" data-suggestions-detail="">
            {lead}
            <span className="whitespace-nowrap">
              {last}
              <InfoButton label="More about suggestions" onToggle={() => setMore(!more)} open={more} />
            </span>
          </p>
          {more ? (
            <div className="text-cell leading-base text-muted" data-suggestions-more="">
              <p className="m-0">{COMPOSER_SUGGESTIONS_EXPLANATION}</p>
              <p className="m-0 mt-1 text-faint">{COMPOSER_SUGGESTIONS_UNGOVERNED_NOTE}</p>
            </div>
          ) : null}
        </div>
        <div className="contents">
          <SuggestionsPreview keys={preferences.suggestionKeys} skills={skills} />
        </div>
      </div>
      <button
        aria-checked={skills}
        className="flex min-h-[44px] w-fit max-w-full cursor-pointer items-center gap-6 border-0 bg-transparent p-0 text-left focus-visible:outline-focus"
        onClick={() => onChange({ skillSuggestions: !skills })}
        role="switch"
        type="button"
      >
        <span className="min-w-0">
          <span className="block text-ui font-semibold text-fg">Suggest $ skills</span>
          <span className="block text-meta leading-base text-muted">The $name skill form only.</span>
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
    </div>
  );
}
