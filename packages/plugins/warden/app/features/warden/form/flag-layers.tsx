/**
 * "What happens to a flag" (r10 S6): three cards in a row, one per layer (Rules, Jev, LLM investigation), each with its
 * own switch, and under them the settings of the layers that are on. The cards are the only boxes; the settings are
 * plain rows split by hairlines, so no box sits inside another and what can spend is visible where it is turned on.
 *
 * WHAT LEAVES THE MACHINE is said under the layers, every time, in words a person can check (`wardenPrivacyNote`). The Jev
 * key itself is not entered here: it lives in Settings › Speed-ups, the one place a key is pasted, tested and replaced.
 */

import {
  WARDEN_GUARD_THRESHOLD_RANGE,
  WARDEN_JEV_ACT_THRESHOLD_RANGE,
  type WardenConfig,
  type WardenFailoverPolicy,
  type WardenLayers,
} from '../../../wire.ts';
import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, cn, RouteLink } from '../../../ui.ts';
import { type JevKeyStatus, WARDEN_FORM_LIMITS, type WardenFormErrors } from '../warden-settings-model.ts';
import { Fields, NumberField, Rows, Section, Segmented, Switch } from './fields.tsx';

/** The cooldown, in one line under the layers. */
const WARDEN_COOLDOWN_NOTE =
  'A cleared flag stays quiet for a while; each time the same flag is cleared again the wait doubles, up to 4 h.';

const FAILOVER_POLICIES: readonly WardenFailoverPolicy[] = ['fallback', 'round_robin'];

const FAILOVER_POLICY_LABELS: Readonly<Record<WardenFailoverPolicy, string>> = {
  fallback: 'First, then the next if it fails',
  round_robin: 'Take turns',
};

/** The acts Jev may do alone, in the order the rows run: gentlest first. Each is also one of the may-act-alone switches. */
const JEV_ACTS: readonly { readonly id: keyof WardenConfig['jevActs']; readonly label: string }[] = [
  { id: 'nudge', label: 'Nudge' },
  { id: 'resume', label: 'Resume or revive' },
  { id: 'restart', label: 'Restart' },
  { id: 'stop', label: 'Stop a ferret' },
];

/** Both Jev bars move in 5% steps across their ranges. */
const THRESHOLD_STEP = 0.05;

/** What the slider says for a bar: the percent, or “Never” at the top, where Jev never does the act alone. */
const jevActBarLabel = (bar: number): string => (bar >= 1 ? 'Never' : `${Math.round(bar * 100)}%`);

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
  Record<Exclude<JevKeyStatus['state'], 'off'>, { readonly label: string; readonly tone: 'ok' | 'warn' | 'pend' }>
> = {
  set: { label: 'key set', tone: 'ok' },
  missing: { label: 'needs Jev key', tone: 'warn' },
  not_named: { label: 'key not named', tone: 'warn' },
  unknown: { label: 'key status unknown', tone: 'pend' },
};

/** One layer as a card: its name, one line, its switch (none for the rules) and a quiet state line. */
function LayerCard({
  title,
  line,
  state,
  on,
  onToggle,
}: {
  readonly title: string;
  readonly line: string;
  readonly state?: ReactNode;
  readonly on?: boolean;
  readonly onToggle?: (next: boolean) => void;
}) {
  return (
    <div className="fy-wf-layer" data-warden-layer={title} data-on={on ?? true}>
      <div className="fy-wf-layer__top">
        <span className="fy-wf-layer__title">{title}</span>
        {on !== undefined && onToggle !== undefined && <Switch on={on} label={`${title} on`} onToggle={onToggle} />}
      </div>
      <span className="fy-wf-layer__line">{line}</span>
      {state !== undefined && <span className="fy-wf-layer__state">{state}</span>}
    </div>
  );
}

export interface FlagLayersProps {
  readonly value: WardenConfig;
  readonly onChange: (next: WardenConfig) => void;
  readonly jevKey: JevKeyStatus;
  readonly errors: WardenFormErrors;
  readonly speedupsHref?: string | undefined;
  readonly onNavigate?: ((to: string) => void) | undefined;
  readonly onUseStoredKey?: (() => void) | undefined;
  readonly namingKey: boolean;
  /** The login the privacy note names. */
  readonly privacyLogin: string;
}

function JevDetail({
  value,
  onChange,
  jevKey,
  errors,
  speedupsHref,
  onNavigate,
  onUseStoredKey,
  namingKey,
}: FlagLayersProps) {
  const set = (patch: Partial<WardenConfig>) => onChange({ ...value, ...patch });
  const where = value.layers.llm ? 'goes to an investigation' : 'is shown to you';
  return (
    <Section title="Jev">
      <Rows>
        {jevKey.state === 'not_named' && (
          <div className="fy-wf-callout" data-warden-jev-not-named="">
            <p className="m-0 font-semibold">A Jev key is stored, but the Warden is not told to use it.</p>
            <p className="m-0 mt-xs text-fg-soft">
              Until warden.yaml names it (<code>jev.key</code>), nothing is sent to Jev and every flag {where}.
            </p>
            {onUseStoredKey !== undefined && (
              <button
                type="button"
                className="kt-btn mt-2 min-h-[44px]"
                data-variant="primary"
                disabled={namingKey}
                onClick={onUseStoredKey}
              >
                {namingKey ? 'Using stored key…' : 'Use stored key'}
              </button>
            )}
          </div>
        )}
        {jevKey.state !== 'set' && jevKey.state !== 'not_named' && jevKey.state !== 'off' && (
          <div className="fy-wf-callout">
            <p className="m-0 font-semibold">
              {jevKey.state === 'missing' ? 'No Jev key yet.' : 'Could not check the Jev key.'}
            </p>
            <p className="m-0 mt-xs text-fg-soft">
              Without a key, every flag {where}. Add it in{' '}
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
        <label className="fy-wf-slider">
          Leaves a flag alone only when at least this sure it is healthy
          <span className="fy-wf-slider__control">
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
          <span className="fy-wf-note">Lower: more cleared and cheaper. Higher: more passed on and safer.</span>
        </label>
        <fieldset className="fy-wf-group flex min-w-0 flex-col gap-3" data-warden-jev-acts="">
          <legend className="fy-wf-legend">What Jev may do alone</legend>
          <p className="fy-wf-note">
            Jev acts only when it is at least this sure and the matching “may act alone” switch is on. Otherwise the
            flag goes to an investigation, or to you.
          </p>
          {JEV_ACTS.map(act => {
            const allowed = value.mayActAlone[act.id];
            const bar = value.jevActs[act.id];
            return (
              <label key={act.id} className={cn('fy-wf-slider', !allowed && 'opacity-60')} data-warden-jev-act={act.id}>
                {act.label}
                <span className="fy-wf-slider__control">
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
                  <span className="fy-wf-note">Off — the Warden may not {act.label.toLowerCase()} alone</span>
                )}
              </label>
            );
          })}
        </fieldset>
        <Fields>
          <NumberField
            label="Jev cap ($/day)"
            value={value.caps.jevUsdPerDay}
            error={errors.jevUsdPerDay}
            {...WARDEN_FORM_LIMITS.capUsd}
            step={0.1}
            onChange={jevUsdPerDay => set({ caps: { ...value.caps, jevUsdPerDay } })}
          />
        </Fields>
      </Rows>
    </Section>
  );
}

function LlmDetail({ value, onChange, errors }: FlagLayersProps) {
  const set = (patch: Partial<WardenConfig>) => onChange({ ...value, ...patch });
  return (
    <Section title="LLM investigation">
      <Rows>
        <Segmented
          label="AI logins"
          options={FAILOVER_POLICIES}
          value={value.failover.policy}
          format={policy => FAILOVER_POLICY_LABELS[policy]}
          onChange={policy => set({ failover: { ...value.failover, policy } })}
        />
        <Fields>
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
        </Fields>
      </Rows>
    </Section>
  );
}

export function FlagLayers(props: FlagLayersProps) {
  const { value, onChange, jevKey, errors, privacyLogin } = props;
  const keyPill = jevKey.state === 'off' ? undefined : KEY_PILL[jevKey.state];
  const set = (layers: Partial<WardenLayers>) => onChange({ ...value, layers: { ...value.layers, ...layers } });
  return (
    <>
      <Section title="What happens to a flag" note={WARDEN_COOLDOWN_NOTE}>
        <div className="fy-wf-layers">
          <LayerCard
            title="Rules"
            line="Checks that cost nothing flag a stuck, idle or broken ferret for you. They run whenever the Warden is on."
          />
          <LayerCard
            title="Jev"
            line="A fast typed decision model looks at each flag first. It clears the ones it is sure are healthy and, when it is very sure, does the simple fix itself."
            state={
              value.layers.jev && keyPill !== undefined ? <Badge tone={keyPill.tone}>{keyPill.label}</Badge> : undefined
            }
            on={value.layers.jev}
            onToggle={jev => set({ jev })}
          />
          <LayerCard
            title="LLM investigation"
            line={
              value.layers.jev
                ? 'A read-only investigation looks at each flag Jev did not clear. Off: those flags are shown to you instead.'
                : 'A read-only investigation looks at every flag. Off: flags are shown to you instead.'
            }
            on={value.layers.llm}
            onToggle={llm => set({ llm })}
          />
        </div>
        {(value.layers.jev || value.layers.llm) && (
          <Fields>
            <NumberField
              label="A cleared flag stays quiet for (min)"
              value={value.blessMinutes}
              error={errors.blessMinutes}
              {...WARDEN_FORM_LIMITS.blessMinutes}
              step={1}
              onChange={blessMinutes => onChange({ ...value, blessMinutes })}
            />
          </Fields>
        )}
        <p className="fy-wf-note" data-warden-privacy="">
          {wardenPrivacyNote(value.layers, privacyLogin)}
        </p>
      </Section>
      {value.layers.jev && <JevDetail {...props} />}
      {value.layers.llm && <LlmDetail {...props} />}
    </>
  );
}
