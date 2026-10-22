/**
 * Small browser-local choices: whether this device always reduces motion (from the session redesign),
 * where an external link opens, and whether the session list shows every paired machine or only the
 * one on screen.
 *
 * The values live in `lib/controls.ts`; this surface holds no state of its own. (It once shared the
 * file with "Show details", which went when the transcript stopped showing daemon bookkeeping.)
 */

import { cn } from '../../lib/class-names.ts';
import {
  type MotionPreference,
  OPEN_LINKS_IN,
  type OpenLinksIn,
  SESSIONS_LIST_SCOPES,
  type SessionsListScope,
} from '../../lib/controls.ts';

interface Choice<Value extends string> {
  readonly value: Value;
  readonly label: string;
  /** Absent: the label says it all. */
  readonly detail?: string;
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
            {choice.detail === undefined ? null : (
              <span className="mt-0.5 block text-meta leading-base text-muted">{choice.detail}</span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
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

/** Plain on purpose: the owner's copy is the two places, and the row's hint says what never changes. */
const OPEN_LINKS: Readonly<Record<OpenLinksIn, Choice<OpenLinksIn>>> = {
  browser: { value: 'browser', label: 'Your browser' },
  panel: { value: 'panel', label: 'Ferretry side panel' },
};

export function OpenLinksInSetting({
  openLinksIn,
  onChange,
}: {
  readonly openLinksIn: OpenLinksIn;
  readonly onChange: (openLinksIn: OpenLinksIn) => void;
}) {
  return (
    <ChoiceGroup
      choices={OPEN_LINKS_IN.map(value => OPEN_LINKS[value])}
      legend="Open links in"
      name="appearance-open-links-in"
      onSelect={onChange}
      selected={openLinksIn}
    />
  );
}

const SESSIONS_LIST: Readonly<Record<SessionsListScope, Choice<SessionsListScope>>> = {
  all: {
    value: 'all',
    label: 'All machines',
    detail: 'Every paired machine in one list, with everything that needs you at the top.',
  },
  current: {
    value: 'current',
    label: 'Current machine only',
    detail: 'Only the machine you are on. Switch machines from the machine menu.',
  },
};

export function SessionsListSetting({
  scope,
  onChange,
}: {
  readonly scope: SessionsListScope;
  readonly onChange: (scope: SessionsListScope) => void;
}) {
  return (
    <ChoiceGroup
      choices={SESSIONS_LIST_SCOPES.map(value => SESSIONS_LIST[value])}
      legend="Sessions list"
      name="behaviour-sessions-list"
      onSelect={onChange}
      selected={scope}
    />
  );
}
