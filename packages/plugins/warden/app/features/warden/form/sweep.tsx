/** How often the sweep runs, and which events also start one (r10 S6): a segmented choice and inline checkboxes. */

import { WARDEN_SWEEP_INTERVALS, type WardenConfig, type WardenEventTrigger } from '../../../wire.ts';
import { Check, Section, Segmented } from './fields.tsx';

const EVENTS: readonly { readonly id: WardenEventTrigger; readonly label: string }[] = [
  { id: 'turnEnd', label: 'Turn end' },
  { id: 'question', label: 'Question asked' },
  { id: 'paneDied', label: 'Pane died' },
];

export function SweepSection({
  value,
  onChange,
}: {
  readonly value: WardenConfig;
  readonly onChange: (next: WardenConfig) => void;
}) {
  return (
    <Section
      title="Sweep"
      note="It also reacts to events, so a stuck ferret is noticed sooner. The sweep itself is free."
    >
      <Segmented
        label="How often the sweep runs"
        options={WARDEN_SWEEP_INTERVALS}
        value={value.intervalMinutes}
        format={minutes => `${minutes} min`}
        onChange={intervalMinutes => onChange({ ...value, intervalMinutes })}
      />
      <fieldset className="fy-wf-checks">
        <legend className="fy-wf-legend">Also sweep on</legend>
        {EVENTS.map(event => (
          <Check
            key={event.id}
            label={event.label}
            checked={value.events[event.id]}
            onChange={checked => onChange({ ...value, events: { ...value.events, [event.id]: checked } })}
          />
        ))}
      </fieldset>
    </Section>
  );
}
