/**
 * "When a login runs out" (r10 S6): moving a ferret that hit a limit (`autoMove`). A rule, not a layer: it needs no AI and
 * spends nothing, so it is offered whenever the Warden is on. On is the default (an explicit off in warden.yaml is kept);
 * an agent that turns it back on waits for the owner.
 *
 * The switch and its words are one row; while it is on its settings follow as plain rows (no box in a box), the checkboxes
 * with their box left of the words, "Where to" a segmented choice, and the numbers on one input edge.
 */

import type { WardenAutoMoveTrigger, WardenConfig } from '../../../wire.ts';
import type { PickerAccount } from '../../../lib/account-picker.ts';
import { toggledMoveTarget, WARDEN_FORM_LIMITS, type WardenFormErrors } from '../warden-settings-model.ts';
import { Check, Fields, loginLabel, NumberField, Rows, Section, Segmented, Switch } from './fields.tsx';

const MOVE_TRIGGERS: readonly { readonly id: WardenAutoMoveTrigger; readonly label: string }[] = [
  { id: 'rate_limited', label: 'It hits a usage limit' },
  { id: 'budget_exceeded', label: 'Its login passes its hard spend budget' },
];

export function MoveToAnotherLogin({
  value,
  errors,
  runtimes,
  onChange,
}: {
  readonly value: WardenConfig;
  readonly errors: WardenFormErrors;
  readonly runtimes: readonly PickerAccount[];
  readonly onChange: (next: WardenConfig) => void;
}) {
  const moving = value.autoMove;
  const setMoving = (patch: Partial<WardenConfig['autoMove']>) =>
    onChange({ ...value, autoMove: { ...moving, ...patch } });
  const named = moving.targets.length > 0;
  const agents = runtimes;
  return (
    <Section
      title="When a login runs out"
      note="An agent that turns this on, or lets it stop jobs, waits for you to confirm."
    >
      <Rows>
        <div
          className="flex min-w-0 items-start justify-between gap-3"
          data-warden-layer="Move the ferret to another login"
        >
          <div className="min-w-0">
            <span className="fy-wf-check__label font-semibold">Move the ferret to another login</span>
            <span className="fy-wf-note block">
              Same chat, same task — only the login changes. It goes to a login of the same kind that is ready, switched
              on, under its budget and has quota left; with none, it waits and carries on at the reset. Off: the Warden
              tells you and you move it.
            </span>
          </div>
          <Switch
            on={moving.enabled}
            label="Move the ferret to another login on"
            shownLabel="On"
            onToggle={enabled => setMoving({ enabled })}
          />
        </div>
        {moving.enabled && (
          <>
            <fieldset className="fy-wf-checks" data-warden-move-when="">
              <legend className="fy-wf-legend">Move it when</legend>
              {MOVE_TRIGGERS.map(trigger => (
                <Check
                  key={trigger.id}
                  label={trigger.label}
                  checked={moving.when.includes(trigger.id)}
                  onChange={checked =>
                    setMoving({
                      when: checked
                        ? [...moving.when.filter(entry => entry !== trigger.id), trigger.id]
                        : moving.when.filter(entry => entry !== trigger.id),
                    })
                  }
                />
              ))}
              {moving.when.length === 0 && (
                <p className="fy-wf-note w-full text-warn">Pick at least one, or it never moves anything.</p>
              )}
            </fieldset>
            <Segmented
              label="Where to"
              options={['any', 'named'] as const}
              value={named ? 'named' : 'any'}
              format={option => (option === 'any' ? 'Any ready login, same provider' : 'Only these, in order')}
              onChange={option =>
                setMoving({
                  targets:
                    option === 'any'
                      ? []
                      : moving.targets.length > 0
                        ? moving.targets
                        : agents.slice(0, 1).map(runtime => runtime.wrapper),
                })
              }
            />
            {named && (
              <fieldset className="fy-wf-group flex min-w-0 flex-col" data-warden-move-targets="">
                <legend className="fy-wf-legend">Logins, tried in the order you tick them</legend>
                {agents.map(runtime => (
                  <Check
                    key={runtime.wrapper}
                    label={loginLabel(runtime.wrapper, runtimes)}
                    checked={moving.targets.includes(runtime.wrapper)}
                    onChange={checked => onChange(toggledMoveTarget(value, runtime.wrapper, checked))}
                  />
                ))}
                <p className="fy-wf-note">
                  Tried in this order: {moving.targets.join(' → ')}. A login of another provider is used only when it is
                  named here; another kind of CLI never is.
                </p>
              </fieldset>
            )}
            <Check
              label="Stop its background jobs if they are in the way"
              detail={
                moving.forceStopBackground
                  ? 'The Warden stops the jobs this ferret started itself — never anything else — tells the ferret which, then moves it if nothing else is in the way.'
                  : 'Off: the Warden asks the ferret to stop them and waits; if they still run, it tells you instead of moving it.'
              }
              checked={moving.forceStopBackground}
              onChange={forceStopBackground => setMoving({ forceStopBackground })}
            />
            <Fields>
              {!moving.forceStopBackground && (
                <NumberField
                  label="Wait for the ferret to stop them (min)"
                  value={moving.waitMinutes}
                  error={errors.moveWaitMinutes}
                  {...WARDEN_FORM_LIMITS.moveWaitMinutes}
                  step={1}
                  onChange={waitMinutes => setMoving({ waitMinutes })}
                />
              )}
              <NumberField
                label="Moves per ferret per hour"
                value={moving.maxMovesPerHour}
                error={errors.movesPerHour}
                {...WARDEN_FORM_LIMITS.movesPerHour}
                step={1}
                onChange={maxMovesPerHour => setMoving({ maxMovesPerHour })}
              />
              <NumberField
                label="Least quota left on the login it moves to (%)"
                value={moving.minHeadroomPercent}
                error={errors.minHeadroomPercent}
                {...WARDEN_FORM_LIMITS.minHeadroomPercent}
                step={1}
                onChange={minHeadroomPercent => setMoving({ minHeadroomPercent })}
              />
            </Fields>
            <p className="fy-wf-note">
              Never while it has an input open for you, holds a secret, or waits on a prompt. Every move is listed under
              Recent triggers.
            </p>
          </>
        )}
      </Rows>
    </Section>
  );
}
