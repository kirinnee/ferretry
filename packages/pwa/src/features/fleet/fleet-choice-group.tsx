/**
 * A set of options where one is chosen, rendered so that it LOOKS like one.
 *
 * The control this replaces put the selected option in a bordered pill and the unselected one in
 * plain grey text, which reads as a badge next to a label rather than as two things you can pick
 * between — the owner's exact words were "how do I know that's a button group?". Equal weight for
 * every option, a border and a tick on the chosen one, and a real `fieldset`/`legend` radio group
 * underneath are the whole fix, and none of it is new to this codebase: it is the same treatment
 * `composer-enter-key-settings.tsx` already uses, lifted so the fleet stepper cannot drift from it.
 *
 * Accessibility is structural rather than bolted on. The group is a `fieldset` with a `legend`
 * because this repo's rules reject `role=group` on a bare `div`; each option is a `<label>`
 * wrapping a visually-hidden `<input type=radio>`, so arrow keys, `checked` and the accessible name
 * all come from the platform. Focus is visible through `has-[:focus-visible]` on the card, because
 * the input itself is `sr-only` and a focus ring nobody can see is not one.
 */

import { Check } from 'lucide-react';
import { useId } from 'react';
import { cn } from '../../lib/class-names.ts';

export interface FleetChoice<T extends string> {
  readonly id: T;
  readonly label: string;
  /**
   * What choosing this one DOES, in one line, shown on the card rather than after the choice.
   *
   * Required, not optional. Every option in this feature has a consequence a person cannot guess —
   * "one shared document, edited once" and "this account's own copy" are the same control with
   * opposite results — and this codebase's rule is that a control carries its consequence where
   * somebody is standing.
   */
  readonly detail: string;
  /** A short marker on the card: `detected`, `unverified`. Absent for an ordinary option. */
  readonly badge?: string;
  readonly disabled?: boolean;
}

export interface FleetChoiceGroupProps<T extends string> {
  /** The visible question. It is the `legend`, so it names the group for a screen reader too. */
  readonly legend: string;
  readonly options: readonly FleetChoice<T>[];
  readonly value: T;
  readonly onChoose: (value: T) => void;
  readonly disabled?: boolean;
  /** Marks the group in the DOM so a test and a screenshot can find one group among several. */
  readonly name: string;
  /** One column by default; two on a wide screen when the options are short. */
  readonly columns?: 1 | 2;
}

export function FleetChoiceGroup<T extends string>({
  legend,
  options,
  value,
  onChoose,
  disabled = false,
  name,
  columns = 2,
}: FleetChoiceGroupProps<T>) {
  // Instance-scoped: two groups mounted together would otherwise share one radio name, and choosing
  // in the second would silently clear the first.
  const uid = useId();
  return (
    <fieldset
      className={cn('m-0 grid min-w-0 gap-2 border-0 p-0', columns === 2 && 'sm:grid-cols-2')}
      data-fleet-choice-group={name}
    >
      <legend className="mb-1 block text-cell font-medium text-fg">{legend}</legend>
      {options.map(option => {
        const checked = option.id === value;
        const unusable = disabled || option.disabled === true;
        return (
          <label
            key={option.id}
            className={cn(
              'flex min-h-[52px] min-w-0 cursor-pointer flex-col items-start justify-center gap-0.5 rounded-control border px-control-x py-2 text-left transition-colors has-[:focus-visible]:outline-focus has-[:focus-visible]:outline-offset-focus motion-reduce:transition-none',
              checked ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface-2 text-fg',
              unusable ? 'cursor-not-allowed opacity-60' : 'hover:border-accent',
            )}
            data-fleet-choice={option.id}
            data-fleet-choice-selected={String(checked)}
          >
            <input
              type="radio"
              name={`${uid}${name}`}
              className="sr-only"
              value={option.id}
              checked={checked}
              disabled={unusable}
              onChange={() => onChoose(option.id)}
            />
            <span className="flex w-full min-w-0 items-center gap-2 text-ui font-semibold">
              <span className="min-w-0 break-words">{option.label}</span>
              {option.badge === undefined ? null : (
                <span className="shrink-0 rounded-control bg-surface-3 px-1.5 py-0.5 text-meta font-normal text-muted">
                  {option.badge}
                </span>
              )}
              {checked ? <Check size={14} className="ml-auto shrink-0" aria-hidden="true" /> : null}
            </span>
            <span className="min-w-0 break-words text-meta leading-base text-muted">{option.detail}</span>
          </label>
        );
      })}
    </fieldset>
  );
}

export interface FleetCheckChoiceProps {
  readonly legend: string;
  readonly options: readonly FleetChoice<string>[];
  readonly selected: readonly string[];
  readonly onToggle: (id: string) => void;
  readonly disabled?: boolean;
  readonly name: string;
  /** Shown in place of the list when there is nothing to offer. An empty list is never silent. */
  readonly empty: string;
}

/**
 * The same card treatment where MORE THAN ONE may be chosen.
 *
 * A separate component rather than a mode of the one above, because the two are different controls:
 * radios are exclusive and checkboxes are not, the platform gives them different keyboard behaviour,
 * and a component that switched `type` on a prop would be one that renders a radio group somebody
 * expects to be multi-select. The cards look identical on purpose — the difference a person needs to
 * see is which ones are ticked, not which widget it is.
 */
export function FleetCheckChoice({
  legend,
  options,
  selected,
  onToggle,
  disabled = false,
  name,
  empty,
}: FleetCheckChoiceProps) {
  const uid = useId();
  const chosen = new Set(selected);
  return (
    <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0" data-fleet-check-group={name}>
      <legend className="mb-1 block text-cell font-medium text-fg">{legend}</legend>
      {options.length === 0 ? (
        <p className="m-0 text-meta leading-base text-muted" data-fleet-check-empty={name}>
          {empty}
        </p>
      ) : (
        options.map(option => {
          const checked = chosen.has(option.id);
          const unusable = disabled || option.disabled === true;
          return (
            <label
              key={option.id}
              className={cn(
                'flex min-h-[52px] min-w-0 cursor-pointer flex-col items-start justify-center gap-0.5 rounded-control border px-control-x py-2 text-left transition-colors has-[:focus-visible]:outline-focus has-[:focus-visible]:outline-offset-focus motion-reduce:transition-none',
                checked ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface-2 text-fg',
                unusable ? 'cursor-not-allowed opacity-60' : 'hover:border-accent',
              )}
              data-fleet-check={option.id}
              data-fleet-check-selected={String(checked)}
            >
              <input
                type="checkbox"
                name={`${uid}${name}`}
                className="sr-only"
                value={option.id}
                checked={checked}
                disabled={unusable}
                onChange={() => onToggle(option.id)}
              />
              <span className="flex w-full min-w-0 items-center gap-2 text-ui font-semibold">
                <span className="min-w-0 break-words font-mono">{option.label}</span>
                {option.badge === undefined ? null : (
                  <span className="shrink-0 rounded-control bg-surface-3 px-1.5 py-0.5 text-meta font-normal text-muted">
                    {option.badge}
                  </span>
                )}
                {checked ? <Check size={14} className="ml-auto shrink-0" aria-hidden="true" /> : null}
              </span>
              <span className="min-w-0 break-words text-meta leading-base text-muted">{option.detail}</span>
            </label>
          );
        })
      )}
    </fieldset>
  );
}
