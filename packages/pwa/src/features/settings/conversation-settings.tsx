/**
 * Two small browser-local choices from the session redesign: whether the conversation opens its
 * folded bookkeeping ("Show details"), and whether this device always reduces motion.
 *
 * Both values live in `lib/controls.ts`; this surface holds no state of its own.
 */

import { cn } from '../../lib/class-names.ts';
import type { MotionPreference } from '../../lib/controls.ts';

interface Choice<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly detail: string;
}

function ChoiceGroup<Value extends string>({
  name,
  legend,
  choices,
  selected,
  onSelect,
}: {
  readonly name: string;
  readonly legend: string;
  readonly choices: readonly Choice<Value>[];
  readonly selected: Value;
  readonly onSelect: (value: Value) => void;
}) {
  return (
    <fieldset className="m-0 grid grid-cols-1 gap-2 border-0 p-0 sm:grid-cols-2">
      <legend className="sr-only">{legend}</legend>
      {choices.map(choice => (
        <label
          className={cn(
            'flex min-h-[44px] cursor-pointer items-start gap-3 rounded-control border px-control-x py-2',
            choice.value === selected
              ? 'border-accent bg-accent-soft'
              : 'border-border bg-surface-2 hover:border-accent',
          )}
          key={choice.value}
        >
          <input
            checked={choice.value === selected}
            className="mt-1"
            name={name}
            onChange={() => onSelect(choice.value)}
            type="radio"
            value={choice.value}
          />
          <span className="min-w-0">
            <span className="block text-ui font-semibold text-fg">{choice.label}</span>
            <span className="mt-0.5 block text-meta leading-base text-muted">{choice.detail}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

const DETAILS: readonly Choice<'hidden' | 'shown'>[] = [
  { value: 'hidden', label: 'Details hidden', detail: 'Reasoning, token and daemon lines fold behind “Show details”.' },
  { value: 'shown', label: 'Details shown', detail: 'Every folded run opens by itself.' },
];

export function ShowDetailsSetting({
  showDetails,
  onChange,
}: {
  readonly showDetails: boolean;
  readonly onChange: (showDetails: boolean) => void;
}) {
  return (
    <ChoiceGroup
      choices={DETAILS}
      legend="Show details"
      name="conversation-show-details"
      onSelect={value => onChange(value === 'shown')}
      selected={showDetails ? 'shown' : 'hidden'}
    />
  );
}

const MOTION: readonly Choice<MotionPreference>[] = [
  { value: 'system', label: 'Follow the system', detail: 'Animations play unless this device asks for less motion.' },
  { value: 'reduced', label: 'Reduced', detail: 'Spinners and transitions stay still on this device.' },
];

export function MotionSetting({
  motion,
  onChange,
}: {
  readonly motion: MotionPreference;
  readonly onChange: (motion: MotionPreference) => void;
}) {
  return (
    <ChoiceGroup choices={MOTION} legend="Motion" name="appearance-motion" onSelect={onChange} selected={motion} />
  );
}
