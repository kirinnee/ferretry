/**
 * Settings › Warden: the controlled form, exported so the new-machine onboarding can set the Warden up
 * with exactly the same controls.
 *
 * It owns no state and reads nothing: the caller hands it a whole `WardenConfig`, the Jev key's status
 * and the errors, and gets the next config back on every change. Saving, and what the daemon answers,
 * are the caller's business (`warden-config-card.tsx` here).
 *
 * THREE ROWS, ONE PER LAYER. The rules are always on and free; Jev and the LLM investigation are each
 * switched on alone, each with its own daily cap beside it, so what can spend is visible where it is
 * turned on.
 *
 * WHAT LEAVES THE MACHINE is said under the layers, every time, in words a person can check: the rules
 * send nothing; an investigation runs on the owner's own login and reads the transcript, pane, diffs
 * and CI; Jev is sent a short, redacted summary with every stored secret masked. The Jev key itself is not entered here — it lives in Settings › Speed-ups, which is the one
 * place a key is pasted, tested and replaced.
 */

import {
  WARDEN_GUARD_THRESHOLD_RANGE,
  WARDEN_JEV_ACT_THRESHOLD_RANGE,
  WARDEN_SWEEP_INTERVALS,
  type WardenAccount,
  type WardenAutoMigrateTrigger,
  type WardenConfig,
  type WardenEventTrigger,
  type WardenFailoverPolicy,
  type WardenJevAct,
  type WardenLayers,
  type WardenLogin,
  type WardenMayActAlone,
} from '@ferretry/protocol';
import { ArrowDown, ArrowUp, ExternalLink } from 'lucide-react';
import { type ReactNode, useId } from 'react';

import { ModelSelect } from '../../components/model-select.tsx';
import type { PickerAccount } from '../../lib/account-picker-catalog.ts';
import { cn } from '../../lib/class-names.ts';
import { Badge } from '../../shell/primitives.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import {
  type JevKeyStatus,
  movedAccount,
  toggledMoveTarget,
  WARDEN_FORM_LIMITS,
  type WardenFormErrors,
  wardenEfforts,
  wardenSummary,
  withLogin,
} from './warden-settings-model.ts';

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
}

const EVENTS: readonly { readonly id: WardenEventTrigger; readonly label: string }[] = [
  { id: 'turnEnd', label: 'Turn end' },
  { id: 'question', label: 'Question asked' },
  { id: 'paneDied', label: 'Pane died' },
];

const ACT_ALONE: readonly { readonly id: keyof WardenMayActAlone; readonly label: string; readonly detail: string }[] =
  [
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

/** The acts Jev may do alone, in the order the rows run: gentlest first. Each is also one of the may-act-alone switches. */
const JEV_ACTS: readonly { readonly id: WardenJevAct; readonly label: string }[] = [
  { id: 'nudge', label: 'Nudge' },
  { id: 'resume', label: 'Resume or revive' },
  { id: 'restart', label: 'Restart' },
  { id: 'stop', label: 'Stop a ferret' },
];

/** Both Jev bars move in 5% steps across their ranges. */
const THRESHOLD_STEP = 0.05;

/** What the slider says for a bar: the percent, or “Never” at the top, where Jev never does the act alone. */
export const jevActBarLabel = (bar: number): string => (bar >= 1 ? 'Never' : `${Math.round(bar * 100)}%`);

/** The privacy sentence for the layers that are on: what leaves this machine, and to whom. */
export const wardenPrivacyNote = (layers: WardenLayers, login: string): string => {
  if (!layers.jev && !layers.llm) return 'What leaves this machine: nothing. The rules send nothing anywhere.';
  const investigation = layers.llm
    ? ` Investigations run on your own login (${login}) and read the transcript, pane, diffs and CI.`
    : '';
  const jev = layers.jev
    ? ' A short, redacted summary of a flagged ferret — its recent turns and screen tail, with every stored secret masked — is sent to TypeSafe AI (Jev).'
    : '';
  return `What leaves this machine:${jev}${investigation}`;
};

const KEY_PILL: Readonly<
  Record<JevKeyStatus['state'], { readonly label: string; readonly tone: 'ok' | 'warn' | 'pend' }>
> = {
  set: { label: 'key set', tone: 'ok' },
  missing: { label: 'needs Jev key', tone: 'warn' },
  unknown: { label: 'key status unknown', tone: 'pend' },
};

/** A login in the picker: its name, then the harness and the label the Runtimes tab shows for it. */
export const loginLabel = (agent: string, runtimes: readonly PickerAccount[]): string => {
  const runtime = runtimes.find(candidate => candidate.wrapper === agent);
  if (runtime === undefined) return agent;
  return [agent, runtime.kind, ...(runtime.displayName === agent ? [] : [runtime.displayName])].join(' · ');
};

/** A cleared number field is `NaN` until fixed; the model reports it rather than a silent zero. */
const numberFrom = (raw: string): number => (raw.trim() === '' ? Number.NaN : Number(raw));

function Card({
  title,
  note,
  children,
}: {
  readonly title?: string;
  readonly note?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="kt-panel flex min-w-0 flex-col gap-3 p-panel">
      {title !== undefined && <h3 className="m-0 text-row font-semibold text-fg">{title}</h3>}
      {children}
      {note !== undefined && <p className="m-0 text-meta leading-base text-muted">{note}</p>}
    </section>
  );
}

function NumberField({
  label,
  value,
  error,
  min,
  max,
  step,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly error: string | undefined;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly onChange: (next: number) => void;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
      {label}
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        aria-invalid={error === undefined ? undefined : true}
        className="kt-input min-h-[44px] w-full max-w-[12rem] rounded-control border border-border bg-surface-2 px-2 text-fg"
        value={Number.isFinite(value) ? value : ''}
        onChange={event => onChange(numberFrom(event.target.value))}
      />
      {error !== undefined && <span className="text-meta font-normal text-err">{error}</span>}
    </label>
  );
}

function Check({
  checked,
  label,
  detail,
  onChange,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly detail?: string;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex min-h-[44px] cursor-pointer items-start gap-3 py-1">
      <input
        type="checkbox"
        className="mt-1 accent-[var(--accent)]"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-ui font-medium text-fg">{label}</span>
        {detail !== undefined && <span className="block text-meta leading-base text-muted">{detail}</span>}
      </span>
    </label>
  );
}

function Segments<T extends string | number>({
  label,
  name,
  options,
  value,
  format,
  onChange,
}: {
  readonly label: string;
  readonly name: string;
  readonly options: readonly T[];
  readonly value: T;
  readonly format: (option: T) => string;
  readonly onChange: (next: T) => void;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
      <legend className="mb-1 text-cell font-medium text-fg">{label}</legend>
      <div className="flex flex-wrap gap-xs">
        {options.map(option => (
          <label
            key={option}
            className={cn(
              'flex min-h-[44px] min-w-[44px] cursor-pointer items-center gap-xs rounded-control border px-control-x text-ui',
              option === value ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface-2 text-fg',
            )}
          >
            <input
              type="radio"
              name={name}
              className="accent-[var(--accent)]"
              checked={option === value}
              onChange={() => onChange(option)}
            />
            {format(option)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The cooldown, in one line under the layers. */
const WARDEN_COOLDOWN_NOTE =
  'A cleared flag stays quiet for a while; each time the same flag is cleared again the wait doubles, up to 4 h.';

const FAILOVER_POLICIES: readonly WardenFailoverPolicy[] = ['fallback', 'round_robin'];

const FAILOVER_POLICY_LABELS: Readonly<Record<WardenFailoverPolicy, string>> = {
  fallback: 'First, then the next if it fails',
  round_robin: 'Take turns',
};

/** An on/off switch: the track and its knob, and the word. */
function Switch({
  on,
  label,
  onToggle,
}: {
  readonly on: boolean;
  readonly label: string;
  readonly onToggle: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onToggle(!on)}
      className="flex min-h-[44px] shrink-0 items-center gap-sm rounded-control px-control-x text-ui font-semibold text-fg"
    >
      <span
        aria-hidden="true"
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full border transition-colors',
          on ? 'border-accent bg-accent' : 'border-border-strong bg-surface',
        )}
      >
        <span
          className={cn(
            'absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-fg transition-transform',
            on ? 'translate-x-[18px]' : 'translate-x-[2px]',
          )}
        />
      </span>
      {on ? 'On' : 'Off'}
    </button>
  );
}

/**
 * One layer: its name and what it does, its switch — none for the rules, which cannot be turned off —
 * and, while it is on, its own settings and cap.
 */
function LayerRow({
  title,
  detail,
  badges,
  on,
  onToggle,
  children,
}: {
  readonly title: string;
  readonly detail: string;
  readonly badges?: ReactNode;
  readonly on?: boolean;
  readonly onToggle?: (next: boolean) => void;
  readonly children?: ReactNode;
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-3 rounded-control border border-border-strong bg-surface-2 px-cell-x py-2"
      data-warden-layer={title}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="flex flex-wrap items-center gap-xs text-ui font-semibold text-fg">
            {title}
            {badges}
          </span>
          <span className="mt-0.5 block text-meta leading-base text-muted">{detail}</span>
        </div>
        {on !== undefined && onToggle !== undefined && <Switch on={on} label={`${title} on`} onToggle={onToggle} />}
      </div>
      {on === true && children}
    </div>
  );
}

const MOVE_TRIGGERS: readonly { readonly id: WardenAutoMigrateTrigger; readonly label: string }[] = [
  { id: 'rate_limited', label: 'It hits a usage limit' },
  { id: 'budget_exceeded', label: 'Its login passes its hard spend budget' },
];

/**
 * Moving a ferret that hit a limit (`autoMigrate`). A rule, not a layer: it needs no AI and spends nothing, so it
 * is offered whenever the Warden is on. Off is the default; an agent that turns it on waits for the owner.
 */
function MoveToAnotherLogin({
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
  const name = useId();
  const moving = value.autoMigrate;
  const setMoving = (patch: Partial<WardenConfig['autoMigrate']>) =>
    onChange({ ...value, autoMigrate: { ...moving, ...patch } });
  const named = moving.targets.length > 0;
  const agents = runtimes.filter(runtime => runtime.agent);
  return (
    <Card
      title="When a login runs out"
      note="An agent that turns this on, or lets it stop jobs, waits for you to confirm."
    >
      <LayerRow
        title="Move the ferret to another login"
        detail="Same chat, same card — only the login changes. It goes to a login of the same kind that is ready, switched on, under its budget and has quota left. Off: the Warden tells you and you move it."
        on={moving.enabled}
        onToggle={enabled => setMoving({ enabled })}
      >
        <fieldset className="m-0 flex min-w-0 flex-col border-0 p-0" data-warden-move-when="">
          <legend className="mb-1 text-cell font-medium text-fg">Move it when</legend>
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
            <p className="m-0 text-meta leading-base text-warn">Pick at least one, or it never moves anything.</p>
          )}
        </fieldset>
        <Segments
          label="Where to"
          name={`${name}-where`}
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
          <fieldset className="m-0 flex min-w-0 flex-col border-0 p-0" data-warden-move-targets="">
            <legend className="mb-1 text-cell font-medium text-fg">Logins, tried in the order you tick them</legend>
            {agents.map(runtime => (
              <Check
                key={runtime.wrapper}
                label={loginLabel(runtime.wrapper, runtimes)}
                checked={moving.targets.includes(runtime.wrapper)}
                onChange={checked => onChange(toggledMoveTarget(value, runtime.wrapper, checked))}
              />
            ))}
            <p className="m-0 text-meta leading-base text-muted">
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
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
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
        </div>
        <p className="m-0 text-meta leading-base text-muted">
          Never while it has a card open for you, holds a secret, or waits on a prompt. Every move is listed under
          Recent triggers.
        </p>
      </LayerRow>
    </Card>
  );
}

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
}: WardenSettingsFormProps) {
  const name = useId();
  const llm = value.layers.llm;
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
  const keyPill = KEY_PILL[jevKey.state];
  const set = (patch: Partial<WardenConfig>) => onChange({ ...value, ...patch });
  // The chosen login's runtime, for its model catalog (docs/model-catalog.md).
  const runtime = runtimes.find(candidate => candidate.wrapper === base?.agent);
  const { efforts, modelName } = wardenEfforts(runtime, head?.model);
  const setModel = (typed: string) => {
    const model = typed.trim();
    const { model: _old, ...agent } = base ?? { agent: '' };
    onChange(withLogin(value, model === '' ? agent : { ...agent, model }));
  };

  return (
    <div className="flex min-w-0 flex-col gap-3" data-warden-form="">
      <section className="kt-panel flex flex-wrap items-center justify-between gap-3 p-panel">
        <div className="min-w-0">
          <h3 className="m-0 text-row font-semibold text-fg">The Warden</h3>
          <p className="m-0 text-meta leading-base text-muted">
            A supervisor that watches every ferret and steps in when one is stuck.
          </p>
        </div>
        <Switch on={value.enabled} label="Warden on" onToggle={enabled => set({ enabled })} />
      </section>

      <fieldset disabled={!value.enabled} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0 disabled:opacity-60">
        <Card title="What happens to a flag" note={WARDEN_COOLDOWN_NOTE}>
          <LayerRow
            title="Rules"
            detail="Always on while the Warden is. Free checks flag a stuck, idle or broken ferret for you."
            badges={<Badge tone="ok">always on · free</Badge>}
          />
          <LayerRow
            title="Jev"
            detail="A fast typed decision model looks at each flag first. It clears the ones it is sure are healthy and, when it is very sure, does the simple fix itself."
            badges={value.layers.jev ? <Badge tone={keyPill.tone}>{keyPill.label}</Badge> : undefined}
            on={value.layers.jev}
            onToggle={jev => set({ layers: { ...value.layers, jev } })}
          >
            {jevKey.state !== 'set' && (
              <div className="rounded-control border border-warn-border bg-warn-bg px-cell-x py-2 text-meta leading-base text-warn">
                <p className="m-0 font-semibold">
                  {jevKey.state === 'missing' ? 'No Jev key yet.' : 'Could not check the Jev key.'}
                </p>
                <p className="m-0 mt-xs text-fg-soft">
                  Without a key, every flag {value.layers.llm ? 'goes to an investigation' : 'is shown to you'}. Add it
                  in{' '}
                  {speedupsHref === undefined ? (
                    'Settings › Speed-ups'
                  ) : (
                    <RouteLink
                      to={speedupsHref}
                      {...(onNavigate === undefined ? {} : { onNavigate })}
                      className="font-semibold text-accent"
                    >
                      Settings › Speed-ups
                    </RouteLink>
                  )}
                  .
                </p>
                {jevKey.keyUrl !== undefined && (
                  <p className="m-0 mt-xs break-all text-fg-soft">
                    Get a key: {jevKey.keyUrl}{' '}
                    <a
                      href={jevKey.keyUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-semibold text-accent"
                    >
                      Get a key
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  </p>
                )}
              </div>
            )}
            <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
              Leaves a flag alone only when at least this sure it is healthy
              <span className="flex items-center gap-sm">
                <input
                  type="range"
                  min={WARDEN_GUARD_THRESHOLD_RANGE.min}
                  max={WARDEN_GUARD_THRESHOLD_RANGE.max}
                  step={THRESHOLD_STEP}
                  aria-valuetext={`${Math.round(value.guard.threshold * 100)}%`}
                  className="min-h-[44px] min-w-0 flex-1 accent-[var(--accent)]"
                  value={value.guard.threshold}
                  onChange={event => set({ guard: { ...value.guard, threshold: Number(event.target.value) } })}
                />
                <output className="mono w-14 text-right text-ui">{jevActBarLabel(value.guard.threshold)}</output>
              </span>
              <span className="text-meta font-normal leading-base text-muted">
                Lower: more cleared and cheaper. Higher: more passed on and safer.
              </span>
            </label>
            <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" data-warden-jev-acts="">
              <legend className="mb-1 text-cell font-medium text-fg">What Jev may do alone</legend>
              <p className="m-0 text-meta leading-base text-muted">
                Jev acts only when it is at least this sure and the matching “may act alone” switch is on. Otherwise the
                flag goes to an investigation, or to you.
              </p>
              {JEV_ACTS.map(act => {
                const allowed = value.mayActAlone[act.id];
                const bar = value.jevActs[act.id];
                return (
                  <label
                    key={act.id}
                    className={cn(
                      'flex min-w-0 flex-col gap-1 text-cell font-medium text-fg',
                      !allowed && 'opacity-60',
                    )}
                    data-warden-jev-act={act.id}
                  >
                    {act.label}
                    <span className="flex items-center gap-sm">
                      <input
                        type="range"
                        min={WARDEN_JEV_ACT_THRESHOLD_RANGE.min}
                        max={WARDEN_JEV_ACT_THRESHOLD_RANGE.max}
                        step={THRESHOLD_STEP}
                        disabled={!allowed}
                        aria-valuetext={bar >= 1 ? 'Never alone' : `${jevActBarLabel(bar)} sure`}
                        className="min-h-[44px] min-w-0 flex-1 accent-[var(--accent)]"
                        value={bar}
                        onChange={event => set({ jevActs: { ...value.jevActs, [act.id]: Number(event.target.value) } })}
                      />
                      <output className="mono w-14 text-right text-ui">{jevActBarLabel(bar)}</output>
                    </span>
                    {!allowed && (
                      <span className="text-meta font-normal leading-base text-muted">
                        Off — the Warden may not {act.label.toLowerCase()} alone
                      </span>
                    )}
                  </label>
                );
              })}
            </fieldset>
            <NumberField
              label="Jev cap ($/day)"
              value={value.caps.jevUsdPerDay}
              error={errors.jevUsdPerDay}
              {...WARDEN_FORM_LIMITS.capUsd}
              step={0.1}
              onChange={jevUsdPerDay => set({ caps: { ...value.caps, jevUsdPerDay } })}
            />
          </LayerRow>
          <LayerRow
            title="LLM investigation"
            detail={
              value.layers.jev
                ? 'A read-only investigation looks at each flag Jev did not clear. Off: those flags are shown to you instead.'
                : 'A read-only investigation looks at every flag. Off: flags are shown to you instead.'
            }
            on={value.layers.llm}
            onToggle={llm => set({ layers: { ...value.layers, llm } })}
          >
            <Segments
              label="AI logins"
              name={`${name}-rotation`}
              options={FAILOVER_POLICIES}
              value={value.failover.policy}
              format={policy => FAILOVER_POLICY_LABELS[policy]}
              onChange={policy => set({ failover: { ...value.failover, policy } })}
            />
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
              <NumberField
                label="LLM cap ($/day)"
                value={value.caps.investigationUsdPerDay}
                error={errors.investigationUsdPerDay}
                {...WARDEN_FORM_LIMITS.capUsd}
                step={0.5}
                onChange={investigationUsdPerDay => set({ caps: { ...value.caps, investigationUsdPerDay } })}
              />
              <NumberField
                label="Max investigations per hour"
                value={value.caps.maxInvestigationsPerHour}
                error={errors.maxInvestigationsPerHour}
                {...WARDEN_FORM_LIMITS.perHour}
                step={1}
                onChange={maxInvestigationsPerHour => set({ caps: { ...value.caps, maxInvestigationsPerHour } })}
              />
            </div>
          </LayerRow>
          {(value.layers.jev || value.layers.llm) && (
            <NumberField
              label="A cleared flag stays quiet for (min)"
              value={value.blessMinutes}
              error={errors.blessMinutes}
              {...WARDEN_FORM_LIMITS.blessMinutes}
              step={1}
              onChange={blessMinutes => set({ blessMinutes })}
            />
          )}
          <p className="m-0 text-meta leading-base text-muted" data-warden-privacy="">
            {wardenPrivacyNote(value.layers, base?.agent ?? 'no login')}
          </p>
        </Card>

        {llm && (
          <Card title="Investigation (the assigned warden)">
            <p className="m-0 text-meta leading-base text-muted">
              A read-only LLM ferret that reads the transcript, pane, diffs and CI, then writes a report with a verdict:
              leave · nudge · resume · stop · needs you. Every verdict records who ran it and with which model.
            </p>
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
                Login
                <select
                  className="kt-input min-h-[44px] rounded-control border border-border bg-surface-2 px-2 text-fg"
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
                    className="kt-input min-h-[44px] rounded-control border border-border bg-surface-2 px-2 text-fg"
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
            {unknown.map(agent => (
              <p key={agent} role="alert" className="m-0 text-meta leading-base text-warn" data-warden-unknown-login="">
                Unknown login ‘{agent}’ — choose one. This machine has no login by that name, so the Warden does not use
                it.
              </p>
            ))}
            {notSet && (
              <p role="alert" className="m-0 text-meta leading-base text-warn" data-warden-login-not-set="">
                No login is set and this machine has no default runtime, so LLM investigations are unavailable. Choose a
                login above.
              </p>
            )}
            {efforts.length === 0 ? (
              <p className="m-0 text-meta leading-base text-muted" data-warden-no-effort="">
                {modelName} takes no reasoning effort, so the investigation runs at the model’s own.
              </p>
            ) : (
              <Segments
                label="Effort"
                name={`${name}-effort`}
                options={efforts}
                value={value.investigation.effort}
                format={effort => effort}
                onChange={effort => set({ investigation: { ...value.investigation, effort } })}
              />
            )}
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-cell font-medium text-fg">
                Failover order for the warden’s own login (strikes and cooldowns)
              </span>
              {value.accounts.length === 0 && (
                <p className="m-0 text-meta leading-base text-muted">
                  None chosen: investigations run on this machine’s default runtime, whatever it is when they start.
                </p>
              )}
              {value.accounts.length > 0 && (
                <ol className="m-0 flex list-none flex-col gap-xs p-0" aria-label="Failover order">
                  {value.accounts.map((account, index) => (
                    <li
                      key={account.agent}
                      className="flex min-w-0 items-center gap-sm rounded-control border border-border-strong bg-surface-2 px-cell-x py-1"
                    >
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
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
              <NumberField
                label="Investigations at a time"
                value={value.maxAssignedWardens}
                error={errors.maxAssignedWardens}
                {...WARDEN_FORM_LIMITS.atATime}
                step={1}
                onChange={maxAssignedWardens => set({ maxAssignedWardens })}
              />
            </div>
          </Card>
        )}

        <Card note="It also reacts to events, so a stuck ferret is noticed sooner. The sweep itself is free.">
          <Segments
            label="How often the sweep runs"
            name={`${name}-interval`}
            options={WARDEN_SWEEP_INTERVALS}
            value={value.intervalMinutes}
            format={minutes => `${minutes} min`}
            onChange={intervalMinutes => set({ intervalMinutes })}
          />
          <fieldset className="m-0 flex min-w-0 flex-wrap gap-x-4 border-0 p-0">
            <legend className="mb-1 text-cell font-medium text-fg">Also sweep on</legend>
            {EVENTS.map(event => (
              <Check
                key={event.id}
                label={event.label}
                checked={value.events[event.id]}
                onChange={checked => set({ events: { ...value.events, [event.id]: checked } })}
              />
            ))}
          </fieldset>
        </Card>

        {(llm || value.layers.jev) && (
          <Card title="May act alone">
            {ACT_ALONE.map(action => (
              <Check
                key={action.id}
                label={action.label}
                detail={action.detail}
                checked={value.mayActAlone[action.id]}
                onChange={checked => set({ mayActAlone: { ...value.mayActAlone, [action.id]: checked } })}
              />
            ))}
            {browserHref === undefined ? null : (
              <p className="m-0 text-meta leading-base text-muted" data-warden-browser-link="">
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
          </Card>
        )}

        <MoveToAnotherLogin value={value} errors={errors} runtimes={runtimes} onChange={onChange} />
      </fieldset>

      <p aria-live="polite" className="m-0 text-ui leading-base text-fg-soft" data-warden-summary="">
        {wardenSummary(value, jevKey.state === 'set', machineDefault)}
      </p>
    </div>
  );
}
