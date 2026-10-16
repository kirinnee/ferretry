/**
 * Settings › Composer › Send key — one choice for a keyboard, one for a phone, both browser-local.
 *
 * They are separate because the two devices disagree about the obvious answer: on a keyboard Enter
 * sending is what every chat app does and Shift+Enter is right there; on a phone the return key is
 * the only way to start a new line, and the ↑ button is always on screen to send. ⌘/Ctrl+Enter sends
 * on every device whichever is chosen, so neither action is ever unreachable.
 */

import { Check } from 'lucide-react';

import { cn } from '../../lib/class-names.ts';
import type { ComposerEnterKeyPreference } from '../../lib/composer-keybinding.ts';

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

function SendKeyGroup({
  name,
  legend,
  options,
  selected,
  onSelect,
}: {
  readonly name: string;
  readonly legend: string;
  readonly options: readonly SendKeyOption[];
  readonly selected: ComposerEnterKeyPreference;
  readonly onSelect: (id: ComposerEnterKeyPreference) => void;
}) {
  return (
    <fieldset className="m-0 grid grid-cols-1 gap-2 border-0 p-0 sm:grid-cols-2">
      <legend className="mb-1 text-ui font-semibold text-fg">{legend}</legend>
      {options.map(option => {
        const checked = option.id === selected;
        return (
          <label
            key={option.id}
            className={cn(
              'flex min-h-[52px] min-w-0 cursor-pointer flex-col items-start justify-center rounded-control border px-control-x py-2 text-left transition-colors has-[:focus-visible]:outline-focus has-[:focus-visible]:outline-offset-focus',
              checked ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface-2 text-fg hover:border-accent',
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.id}
              checked={checked}
              onChange={() => onSelect(option.id)}
              className="sr-only"
            />
            <span className="flex w-full items-center gap-2 text-ui font-semibold">
              {option.label}
              {checked ? <Check size={14} className="ml-auto shrink-0" aria-hidden="true" /> : null}
            </span>
            <span className="text-meta leading-tight text-muted">{option.description}</span>
          </label>
        );
      })}
    </fieldset>
  );
}

export function ComposerEnterKeySettings({ preference, phonePreference, onChange }: ComposerEnterKeySettingsProps) {
  return (
    <div className="space-y-3">
      <SendKeyGroup
        legend="On a keyboard"
        name="composer-enter-key"
        onSelect={id => onChange({ composerEnterKey: id })}
        options={DESKTOP}
        selected={preference ?? 'send'}
      />
      <SendKeyGroup
        legend="On a phone"
        name="composer-phone-enter-key"
        onSelect={id => onChange({ composerPhoneEnterKey: id })}
        options={PHONE}
        selected={phonePreference ?? 'newline'}
      />
      <p className="m-0 text-meta leading-base text-faint">⌘/Ctrl+↵ always sends, on every device.</p>
    </div>
  );
}
