/**
 * "Investigation (the assigned warden)" (r10 S6): the login and model an investigation runs on, its effort, the failover
 * order, and how many run at a time. Shown only while the LLM layer is on. Rows split by hairlines; no inner boxes.
 */

import type { WardenAccount, WardenConfig, WardenLogin } from '../../../wire.ts';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useId } from 'react';
import { ModelSelect } from '@ferretry/app/ui';
import type { PickerAccount } from '../../../lib/account-picker.ts';
import {
  movedAccount,
  WARDEN_FORM_LIMITS,
  type WardenFormErrors,
  wardenEfforts,
  withLogin,
} from '../warden-settings-model.ts';
import { Fields, loginLabel, NumberField, Rows, Section, Segmented } from './fields.tsx';

export function InvestigationSection({
  value,
  onChange,
  errors,
  loginOptions,
  runtimes,
  login,
  machineDefault,
}: {
  readonly value: WardenConfig;
  readonly onChange: (next: WardenConfig) => void;
  readonly errors: WardenFormErrors;
  readonly loginOptions: readonly WardenAccount[];
  readonly runtimes: readonly PickerAccount[];
  readonly login: WardenLogin | undefined;
  readonly machineDefault: string | undefined;
}) {
  const name = useId();
  const head = value.accounts[0];
  // The login a model is pinned on: the chosen head, else the machine default it stands in for.
  const base = head ?? (machineDefault === undefined ? undefined : { agent: machineDefault });
  const unknown = (
    value.accounts.length > 0 ? value.accounts.map(account => account.agent) : (login?.unknown ?? [])
  ).filter(agent => login?.unknown.includes(agent) === true);
  const notSet = value.accounts.length === 0 && login?.source === 'not_set';
  const unchosen =
    machineDefault !== undefined
      ? `Machine default — ${machineDefault}`
      : notSet
        ? 'Not set — choose a login'
        : 'The machine’s default runtime';
  const logins = [
    ...value.accounts,
    ...loginOptions.filter(option => !value.accounts.some(account => account.agent === option.agent)),
  ];
  // The chosen login's runtime, for its model catalog (docs/model-catalog.md).
  const runtime = runtimes.find(candidate => candidate.wrapper === base?.agent);
  const { efforts, modelName } = wardenEfforts(runtime, head?.model);
  const setModel = (typed: string) => {
    const model = typed.trim();
    const { model: _old, ...agent } = base ?? { agent: '' };
    onChange(withLogin(value, model === '' ? agent : { ...agent, model }));
  };
  const fieldClass = 'kt-input min-h-[44px] rounded-control border border-border bg-surface-2 px-2 text-fg';

  return (
    <Section title="Investigation (the assigned warden)">
      <p className="fy-wf-note">
        A read-only LLM ferret that reads the transcript, pane, diffs and CI, then writes a report with a verdict: leave
        · nudge · resume · stop · needs you. Every verdict records who ran it and with which model.
      </p>
      <Rows>
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
            Login
            <select
              className={fieldClass}
              value={head?.agent ?? ''}
              onChange={event => {
                // The empty option hands the choice back to the machine's default runtime.
                if (event.target.value === '') return onChange({ ...value, accounts: [] });
                const picked = logins.find(account => account.agent === event.target.value);
                if (picked !== undefined) onChange(withLogin(value, picked));
              }}
            >
              <option value="">{unchosen}</option>
              {logins.map(account => (
                <option key={account.agent} value={account.agent}>
                  {loginLabel(account.agent, runtimes)}
                </option>
              ))}
            </select>
          </label>
          {runtime?.modelCatalog === undefined ? (
            <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
              Model
              <input
                type="text"
                placeholder="the login’s default"
                className={fieldClass}
                value={head?.model ?? ''}
                disabled={base === undefined}
                onChange={event => setModel(event.target.value)}
              />
            </label>
          ) : (
            <div className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
              <label htmlFor={`${name}-model`}>Model</label>
              <ModelSelect
                customIds={runtime.modelCatalog.customIds}
                defaultLabel="The login’s default"
                defaultModel={runtime.defaultModel}
                disabled={base === undefined}
                id={`${name}-model`}
                local={runtime.modelCatalog.local}
                models={runtime.models}
                onChange={setModel}
                value={head?.model ?? ''}
              />
            </div>
          )}
        </div>
        {(unknown.length > 0 || notSet) && (
          <div className="flex flex-col gap-1">
            {unknown.map(agent => (
              <p key={agent} role="alert" className="fy-wf-note text-warn" data-warden-unknown-login="">
                Unknown login ‘{agent}’ — choose one. This machine has no login by that name, so the Warden does not use
                it.
              </p>
            ))}
            {notSet && (
              <p role="alert" className="fy-wf-note text-warn" data-warden-login-not-set="">
                No login is set and this machine has no default runtime, so LLM investigations are unavailable. Choose a
                login above.
              </p>
            )}
          </div>
        )}
        {efforts.length === 0 ? (
          <p className="fy-wf-note" data-warden-no-effort="">
            {modelName} takes no reasoning effort, so the investigation runs at the model’s own.
          </p>
        ) : (
          <Segmented
            label="Effort"
            options={efforts}
            value={value.investigation.effort}
            format={effort => effort}
            onChange={effort => onChange({ ...value, investigation: { ...value.investigation, effort } })}
          />
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-cell font-medium text-fg">
            Failover order for the warden’s own login (strikes and cooldowns)
          </span>
          {value.accounts.length === 0 && (
            <p className="fy-wf-note">
              None chosen: investigations run on this machine’s default runtime, whatever it is when they start.
            </p>
          )}
          {value.accounts.length > 0 && (
            <ol className="fy-wf-rows fy-wf-list m-0 list-none p-0" aria-label="Failover order">
              {value.accounts.map((account, index) => (
                <li key={account.agent}>
                  <span className="mono text-meta text-faint">{index + 1}</span>
                  <span className="mono min-w-0 flex-1 break-all text-ui text-fg">{account.agent}</span>
                  <button
                    type="button"
                    className="kt-btn kt-btn--sm min-h-[44px] min-w-[44px]"
                    aria-label={`Move ${account.agent} up`}
                    disabled={index === 0}
                    onClick={() => onChange(movedAccount(value, index, -1))}
                  >
                    <ArrowUp size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="kt-btn kt-btn--sm min-h-[44px] min-w-[44px]"
                    aria-label={`Move ${account.agent} down`}
                    disabled={index === value.accounts.length - 1}
                    onClick={() => onChange(movedAccount(value, index, 1))}
                  >
                    <ArrowDown size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
        <Fields>
          <NumberField
            label="Investigations at a time"
            value={value.maxAssignedWardens}
            error={errors.maxAssignedWardens}
            {...WARDEN_FORM_LIMITS.atATime}
            step={1}
            onChange={maxAssignedWardens => onChange({ ...value, maxAssignedWardens })}
          />
        </Fields>
      </Rows>
    </Section>
  );
}
