/** Browser-local Enter-key preference for the transcript composer. */

import { Check } from 'lucide-react';

import { useInputModality } from '../../hooks/use-input-modality.ts';
import { cn } from '../../lib/class-names.ts';
import { type ComposerEnterKeyPreference, composerEnterAction } from '../../lib/composer-keybinding.ts';

export interface ComposerEnterKeySettingsProps {
  /** null follows this device’s default instead of inheriting another device’s choice. */
  readonly preference: ComposerEnterKeyPreference | null;
  readonly onChange: (preference: ComposerEnterKeyPreference | null) => void;
}

const OPTIONS: ReadonlyArray<{
  readonly id: ComposerEnterKeyPreference;
  readonly label: string;
  readonly description: string;
}> = [
  { id: 'send', label: 'Enter sends', description: 'Shift+Enter writes a new line on a keyboard.' },
  { id: 'newline', label: 'Enter starts a new line', description: 'Shift+Enter sends on a keyboard.' },
];

/**
 * This preference belongs to Behaviour, not a daemon: it changes the reader’s
 * keyboard and follows this browser across every paired machine.
 */
export function ComposerEnterKeySettings({ preference, onChange }: ComposerEnterKeySettingsProps) {
  const modality = useInputModality();
  const recommended = composerEnterAction(null, modality.enterSends);
  const selected = composerEnterAction(preference, modality.enterSends);

  return (
    <div className="space-y-3">
      <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <legend className="sr-only">Enter key action</legend>
        {OPTIONS.map(option => {
          const checked = option.id === selected;
          return (
            <label
              key={option.id}
              className={cn(
                'flex min-h-[52px] min-w-0 cursor-pointer flex-col items-start justify-center rounded-control border px-control-x py-2 text-left transition-colors has-[:focus-visible]:outline-focus has-[:focus-visible]:outline-offset-focus',
                checked
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-border bg-surface-2 text-fg hover:border-accent',
              )}
            >
              <input
                type="radio"
                name="composer-enter-key"
                value={option.id}
                checked={checked}
                onChange={() => onChange(option.id)}
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
      {modality.touchAffected ? (
        <p className="m-0 text-meta leading-base text-muted">
          This device may not have Shift. The composer keeps its Send button visible, and shows New line whenever Enter
          sends, so neither action is unreachable.
        </p>
      ) : null}
      {preference !== null ? (
        <button type="button" className="kt-btn kt-btn--sm" onClick={() => onChange(null)}>
          Use this device’s default ({recommended === 'send' ? 'Enter sends' : 'Enter starts a new line'})
        </button>
      ) : (
        <p className="m-0 text-meta leading-base text-faint">
          Using this device’s default: {recommended === 'send' ? 'Enter sends' : 'Enter starts a new line'}.
        </p>
      )}
    </div>
  );
}
