/**
 * Settings › Warden: the controlled form, exported so the new-machine onboarding can set the Warden up
 * with exactly the same controls.
 *
 * It owns no state and reads nothing: the caller hands it a whole `WardenConfig`, the Jev key's status
 * and the errors, and gets the next config back on every change. Saving, and what the daemon answers,
 * are the caller's business (`warden-config-card.tsx` here).
 *
 * THE PIECES live in `form/` (r10 S6): `flag-layers.tsx` (the three layer cards, Jev's and the investigation's
 * settings, the privacy note), `investigation.tsx`, `sweep.tsx`, `login-runs-out.tsx` and the shared controls in
 * `fields.tsx`. This file only puts them in order. A section is a heading and rows split by hairlines; the only boxes
 * are the three layer cards, so no box sits inside another.
 *
 * THREE CARDS, ONE PER LAYER. The rules are always on and free; Jev and the LLM investigation are each switched on
 * alone, each with its own daily cap beside its settings, so what can spend is visible where it is turned on.
 */

import type { WardenAccount, WardenConfig, WardenLogin } from '../../wire.ts';
import type { PickerAccount } from '../../lib/account-picker.ts';
import { cn } from '../../ui.ts';
import { Check, Section, Switch } from './form/fields.tsx';
import { FlagLayers, wardenPrivacyNote } from './form/flag-layers.tsx';
import { InvestigationSection } from './form/investigation.tsx';
import { MoveToAnotherLogin } from './form/login-runs-out.tsx';
import { SweepSection } from './form/sweep.tsx';
import { RouteLink } from '../../ui.ts';
import { type JevKeyStatus, type WardenFormErrors, wardenSummary } from './warden-settings-model.ts';

export { wardenPrivacyNote };

export interface WardenSettingsFormProps {
  readonly value: WardenConfig;
  readonly onChange: (next: WardenConfig) => void;
  readonly jevKey: JevKeyStatus;
  readonly errors: WardenFormErrors;
  /** Logins the owner may pick for investigations, beyond those already in the failover order. */
  readonly loginOptions?: readonly WardenAccount[];
  /** The runtimes and the models each offers (docs/model-catalog.md): the model field lists the chosen login's. */
  readonly runtimes?: readonly PickerAccount[];
  /** Where the daemon says the login comes from, and which named logins this machine lacks. */
  readonly login?: WardenLogin;
  /** The machine default runtime an empty failover order runs on, when the daemon stood one in. */
  readonly machineDefault?: string;
  /** Settings › Speed-ups, where the Jev key is added. */
  readonly speedupsHref?: string;
  /** Settings › machine › Browser, where the browser's mode and proxy are (the Warden only closes leftovers). */
  readonly browserHref?: string;
  readonly onNavigate?: (to: string) => void;
  /** Names the stored Jev key in `warden.yaml` (names only, never a value). Offered when `jevKey` is `not_named`. */
  readonly onUseStoredKey?: () => void;
  /** The "use stored key" act is in flight. */
  readonly namingKey?: boolean;
}

const ACT_ALONE: readonly {
  readonly id: keyof WardenConfig['mayActAlone'];
  readonly label: string;
  readonly detail: string;
}[] = [
  { id: 'nudge', label: 'Nudge', detail: 'Sends a short “still there?” message.' },
  { id: 'resume', label: 'Resume or revive', detail: 'Hands a dead turn back to the ferret.' },
  {
    id: 'restart',
    label: 'Restart',
    detail: 'Relaunches a dead or frozen process with its conversation intact.',
  },
  { id: 'failover', label: 'Fail over', detail: 'Moves to the next login in the failover order when quota is out.' },
  { id: 'stop', label: 'Stop a ferret', detail: 'Off by default: a KILL verdict asks you first.' },
  {
    id: 'closeLeftovers',
    label: 'Close leftover browsers',
    detail: 'Closes a browser a finished ferret left running — by rule, no AI. The ferret is not touched.',
  },
];

export function WardenSettingsForm({
  value,
  onChange,
  jevKey,
  errors,
  loginOptions = [],
  runtimes = [],
  login,
  machineDefault,
  speedupsHref,
  browserHref,
  onNavigate,
  onUseStoredKey,
  namingKey = false,
}: WardenSettingsFormProps) {
  const base = value.accounts[0] ?? (machineDefault === undefined ? undefined : { agent: machineDefault });
  const alone = value.layers.llm || value.layers.jev;
  return (
    <div className="fy-wf" data-warden-form="">
      <section className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="m-0 text-row font-semibold text-fg">The Warden</h3>
          <p className="fy-wf-note">A supervisor that watches every ferret and steps in when one is stuck.</p>
        </div>
        <Switch on={value.enabled} label="Warden on" onToggle={enabled => onChange({ ...value, enabled })} />
      </section>

      <fieldset disabled={!value.enabled} className={cn('fy-wf m-0 border-0 p-0', !value.enabled && 'opacity-60')}>
        <FlagLayers
          value={value}
          onChange={onChange}
          jevKey={jevKey}
          errors={errors}
          speedupsHref={speedupsHref}
          onNavigate={onNavigate}
          onUseStoredKey={onUseStoredKey}
          namingKey={namingKey}
          privacyLogin={base?.agent ?? 'no login'}
        />

        {value.layers.llm && (
          <InvestigationSection
            value={value}
            onChange={onChange}
            errors={errors}
            loginOptions={loginOptions}
            runtimes={runtimes}
            login={login}
            machineDefault={machineDefault}
          />
        )}

        <SweepSection value={value} onChange={onChange} />

        {alone && (
          <Section title="May act alone">
            <div className="fy-wf-rows">
              {ACT_ALONE.map(action => (
                <Check
                  key={action.id}
                  label={action.label}
                  detail={action.detail}
                  checked={value.mayActAlone[action.id]}
                  onChange={checked =>
                    onChange({ ...value, mayActAlone: { ...value.mayActAlone, [action.id]: checked } })
                  }
                />
              ))}
            </div>
            {browserHref === undefined ? null : (
              <p className="fy-wf-note" data-warden-browser-link="">
                The browser’s mode and proxy are in{' '}
                <RouteLink
                  to={browserHref}
                  {...(onNavigate === undefined ? {} : { onNavigate })}
                  className="font-semibold text-accent"
                >
                  Settings › machine › Browser
                </RouteLink>
                .
              </p>
            )}
          </Section>
        )}

        <MoveToAnotherLogin value={value} errors={errors} runtimes={runtimes} onChange={onChange} />
      </fieldset>

      <p aria-live="polite" className="m-0 text-ui leading-base text-fg-soft" data-warden-summary="">
        {wardenSummary(value, jevKey.state === 'set', machineDefault)}
      </p>
    </div>
  );
}
