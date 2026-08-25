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
import { type ReactNode, useId } from 'react';
import { cn } from '../../lib/class-names.ts';
import { type FleetPickOrAddSource, PICK_OR_ADD_LABEL } from './fleet-stepper-model.ts';

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

/** One answer offered, carrying the facts about it this control cannot know. */
export interface FleetPickOrAddAnswer {
  readonly id: FleetPickOrAddSource;
  /** What choosing this one DOES, in the vocabulary of the thing being picked. */
  readonly detail: string;
  readonly disabled?: boolean;
  readonly badge?: string;
}

export interface FleetPickOrAddProps {
  /** The one question, asked as a person would ask it about this particular thing. */
  readonly legend: string;
  /** Marks this control in the DOM. The answer group is `<name>-source`. */
  readonly name: string;
  readonly answers: readonly FleetPickOrAddAnswer[];
  readonly value: FleetPickOrAddSource;
  readonly onChoose: (next: FleetPickOrAddSource) => void;
  readonly disabled?: boolean;
  /**
   * The control that appears under each answer.
   *
   * A map rather than a `children` slot, because "the sub-control follows the answer" is the rule being
   * extracted: with children, every caller re-decides it, and the one that gets it wrong renders a name
   * box under "use the one you already have".
   */
  readonly under: Readonly<Partial<Record<FleetPickOrAddSource, ReactNode>>>;
}

/**
 * PICK FROM WHAT EXISTS, OR ADD A NEW ONE — how every REQUIRED single choice in this feature is asked.
 *
 * The owner's rule is that a screen should "always ask to select from existing, then have an option to
 * jump to the entity type to add a new one there, or allow new, and auto add it to the entity type".
 * The instructions step had already grown into exactly that — three answers, a sub-control under
 * whichever was picked, and both add-new answers writing into the store so the next member can pick
 * them — and it was hand-rolled, so every step that needed the same shape would have hand-rolled it
 * again.
 *
 * What it owns is the two things that must not drift: the WORDS on the answers, and the rule that the
 * sub-control belongs under the answer it belongs to. The details stay with the caller because they are
 * facts about the thing being picked — how many there are, what editing a shared one costs, why an
 * import is unavailable — and a shared sentence for those would either be vague or wrong.
 *
 * NOT EVERY STEP IS THIS SHAPE, and forcing the ones that are not would be the second pattern rather
 * than the first. A radio group answers a question with exactly one answer; an OPTIONAL SET — models,
 * skills — is tick-cards over what exists with an inline add beneath them, which is the same rule with
 * the same two halves and needs no fourth answer whose only job is to mean "none of these".
 *
 * The union and its LABELS are `fleet-stepper-model.ts`', because which answers exist is a fact about
 * the question rather than about this control — and because a refusal has to be able to cite a label
 * it is sending somebody to, which a table private to a component cannot be asked for.
 */
export function FleetPickOrAdd({
  legend,
  name,
  answers,
  value,
  onChoose,
  disabled = false,
  under,
}: FleetPickOrAddProps) {
  return (
    <div className="grid min-w-0 gap-3" data-fleet-pick-or-add={name}>
      <FleetChoiceGroup
        legend={legend}
        name={`${name}-source`}
        columns={1}
        value={value}
        disabled={disabled}
        onChoose={onChoose}
        options={answers.map(answer => ({
          id: answer.id,
          label: PICK_OR_ADD_LABEL[answer.id],
          detail: answer.detail,
          ...(answer.disabled === true ? { disabled: true } : {}),
          ...(answer.badge === undefined ? {} : { badge: answer.badge }),
        }))}
      />
      {under[value]}
    </div>
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
  /**
   * Whether the labels are identifiers. Default true, because the first caller's are model ids.
   *
   * A monospace face is a claim that the string is data a person will retype exactly — which is right
   * for `claude-opus-5` and wrong for "Interactive", where it reads as a code word rather than as the
   * plain English it is.
   */
  readonly mono?: boolean;
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
  mono = true,
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
                <span className={cn('min-w-0 break-words', mono && 'font-mono')}>{option.label}</span>
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
