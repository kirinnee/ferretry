/**
 * SETTINGS › PACK MODE, on one machine (docs/pack-mode.md): whether ferrets here may delegate to
 * sub-ferrets, who picks the model each runs on, how many may run and how deep, the "reply OK" probe
 * that runs before each start, and the one routing prompt those picks are made from.
 *
 * Every setting lives in `pack.yaml` and the routing prompt in `models-guide.yaml`, written through the
 * configuration-file routes. An edit that loosens what ferrets may do or spend — Pack on, Jev decides,
 * a limit or Jev's daily cap raised — is HELD until the owner confirms it, and this screen says so in
 * those words instead of showing the new value as if it were in effect.
 *
 * Each ferret also has its own switch (Actions › Pack mode), read at its next launch.
 */

import {
  DEFAULT_PACK_CONFIG,
  PACK_MAX_DEPTH_CEILING,
  type PackConfig,
  type PackDecisionMode,
  type PackView,
} from '@ferretry/protocol';
import { useId, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { PackConfigPatch } from '../../lib/pack/pack-files.ts';
import { type IdeaLimit, ideaLimitFor } from '../../lib/pack/routing-prompt.ts';
import { useDaemonHealth } from '../../lib/use-daemon-health.ts';
import { Button } from '../../shell/primitives.tsx';
import { RoutingPromptCard } from './routing-prompt-card.tsx';
import { type MachinePack, type PackSave, useMachinePack } from './use-machine-pack.ts';

const DECISIONS: readonly { readonly id: PackDecisionMode; readonly label: string; readonly hint: string }[] = [
  {
    id: 'agent',
    label: 'Agent decides',
    hint: 'The asking ferret reads the routing prompt and picks the model itself. Costs nothing extra.',
  },
  {
    id: 'jev',
    label: 'Jev decides',
    hint: 'Jev reads the same routing prompt and ranks the models available now for each task. Jev spends money on every pick, up to its daily cap.',
  },
];

/** One numeric setting: its place in `pack.yaml`, its words and its bounds. */
interface NumberSetting {
  readonly section: 'limits' | 'probe' | 'jev';
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
}

const LIMITS: readonly NumberSetting[] = [
  {
    section: 'limits',
    key: 'interactiveChildren',
    label: 'Sub-ferrets for an interactive ferret',
    hint: 'Running at once, while a person is at the ferret.',
    min: 0,
    max: 100,
  },
  {
    section: 'limits',
    key: 'autoChildren',
    label: 'Sub-ferrets for an unattended ferret',
    hint: 'Running at once, for a ferret nobody is watching.',
    min: 0,
    max: 100,
  },
  {
    section: 'limits',
    key: 'maxDepth',
    label: 'Deepest nesting',
    hint: '1: sub-ferrets may not start their own. 2: they may, and those may not.',
    min: 1,
    max: PACK_MAX_DEPTH_CEILING,
  },
];

const PROBE: readonly NumberSetting[] = [
  {
    section: 'probe',
    key: 'timeoutSeconds',
    label: 'Probe timeout (seconds)',
    hint: 'How long the “reply OK” check before a start may take before it counts as failed.',
    min: 5,
    max: 300,
  },
  {
    section: 'probe',
    key: 'cacheSeconds',
    label: 'Trust a passed probe for (seconds)',
    hint: 'Per runtime and model, so a burst of starts probes once.',
    min: 0,
    max: 3_600,
  },
];

const JEV_CAP: NumberSetting = {
  section: 'jev',
  key: 'usdPerDay',
  label: 'Jev’s daily cap (USD)',
  hint: 'Per UTC day, separate from the Warden’s own cap. When it is reached, the routing prompt’s order is used.',
  min: 0,
  max: 100,
  step: 0.05,
};

const settingValue = (config: PackConfig, setting: NumberSetting): number =>
  (config[setting.section] as Readonly<Record<string, number>>)[setting.key] ?? 0;

const valid = (setting: NumberSetting, value: number): boolean =>
  Number.isFinite(value) &&
  value >= setting.min &&
  value <= setting.max &&
  (setting.step !== undefined || Number.isInteger(value));

const SWITCH_CLASS =
  'flex min-h-[44px] shrink-0 items-center gap-2 rounded-control border px-3 text-ui font-semibold disabled:opacity-60';

/** The numbers, edited together and saved with one button: every save rewrites a file on the machine. */
function NumbersForm({
  config,
  settings,
  title,
  busy,
  onSave,
}: {
  readonly config: PackConfig;
  readonly settings: readonly NumberSetting[];
  readonly title: string;
  readonly busy: boolean;
  readonly onSave: (patch: PackConfigPatch) => void;
}) {
  const base = useId();
  const [draft, setDraft] = useState<Readonly<Record<string, string>>>({});
  const text = (setting: NumberSetting): string => draft[setting.key] ?? String(settingValue(config, setting));
  const edited = settings.filter(setting => draft[setting.key] !== undefined);
  const allValid = edited.every(setting => valid(setting, Number(text(setting))));
  const save = (): void => {
    const patch: Record<string, Record<string, number>> = {};
    for (const setting of edited)
      patch[setting.section] = { ...patch[setting.section], [setting.key]: Number(text(setting)) };
    setDraft({});
    onSave(patch);
  };
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
      <legend className="mb-2 p-0 text-ui font-semibold">{title}</legend>
      {settings.map(setting => {
        const id = `${base}-${setting.key}`;
        const bad = draft[setting.key] !== undefined && !valid(setting, Number(text(setting)));
        return (
          <div key={setting.key} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <div className="min-w-0 flex-1 basis-[220px]">
              <label htmlFor={id} className="block text-ui">
                {setting.label}
              </label>
              <span id={`${id}-hint`} className="block text-meta leading-base text-muted">
                {setting.hint}
                {bad ? ` Between ${setting.min} and ${setting.max}.` : ''}
              </span>
            </div>
            <input
              id={id}
              type="number"
              inputMode={setting.step === undefined ? 'numeric' : 'decimal'}
              className={cn('kt-input min-h-[44px] w-28', bad && '!border-err')}
              min={setting.min}
              max={setting.max}
              step={setting.step ?? 1}
              aria-describedby={`${id}-hint`}
              aria-invalid={bad || undefined}
              disabled={busy}
              value={text(setting)}
              data-pack-number={setting.key}
              onChange={event => setDraft({ ...draft, [setting.key]: event.currentTarget.value })}
            />
          </div>
        );
      })}
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-[44px]" disabled={busy || edited.length === 0 || !allValid} onClick={save}>
          Save {title.toLocaleLowerCase()}
        </Button>
        {edited.length > 0 ? (
          <Button variant="ghost" className="min-h-[44px]" disabled={busy} onClick={() => setDraft({})}>
            Discard
          </Button>
        ) : null}
      </div>
    </fieldset>
  );
}

function PackPanel({
  view,
  state,
  connection,
  ideaLimit,
}: {
  readonly view: PackView;
  readonly state: MachinePack;
  readonly connection: DaemonConnection;
  readonly ideaLimit?: IdeaLimit;
}) {
  const { config } = view;
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<PackSave | null>(null);
  const switchTitle = useId();
  const decisionTitle = useId();
  const commit = (patch: PackConfigPatch): void => {
    setBusy(true);
    setOutcome(null);
    void state.saveConfig(patch).then(result => {
      setOutcome(result);
      setBusy(false);
    });
  };
  const on = config.enabled;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-pack-settings="">
      <section className="kt-panel flex flex-col gap-2 p-4" aria-labelledby={switchTitle}>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 id={switchTitle} className="m-0 text-ui font-semibold">
              Pack mode on this machine
            </h3>
            <p className="m-0 mt-1 text-meta leading-base text-muted">
              Ferrets may start sub-ferrets for parts of their work and pick the model each one runs on. Off: no ferret
              is told about it, and <span className="mono">fy new</span> refuses.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-labelledby={switchTitle}
            disabled={busy}
            onClick={() => commit({ enabled: !on })}
            data-pack-switch=""
            className={cn(
              SWITCH_CLASS,
              on ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface-2 text-muted',
            )}
          >
            <span
              aria-hidden="true"
              className={cn('relative h-5 w-9 rounded-full transition-colors', on ? 'bg-accent' : 'bg-surface-3')}
            >
              <span
                className={cn(
                  'absolute top-0.5 h-4 w-4 rounded-full bg-surface shadow transition-[left]',
                  on ? 'left-[18px]' : 'left-0.5',
                )}
              />
            </span>
            {on ? 'On' : 'Off'}
          </button>
        </div>
        <p className="m-0 text-meta text-faint">
          Each ferret also has its own switch in Actions › Pack mode; a change there takes effect at its next launch.
        </p>
      </section>

      <section className="kt-panel flex flex-col gap-2 p-4" aria-labelledby={decisionTitle}>
        <h3 id={decisionTitle} className="m-0 text-ui font-semibold">
          Who picks the model
        </h3>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="sr-only">Who picks the model</legend>
          {DECISIONS.map(option => (
            <label
              key={option.id}
              className={cn(
                'flex min-h-[44px] cursor-pointer items-start gap-3 rounded-control border px-control-x py-2',
                config.decision === option.id ? 'border-accent bg-accent-soft' : 'border-border-strong bg-surface-2',
              )}
            >
              <input
                type="radio"
                name="pack-decision"
                className="mt-1"
                checked={config.decision === option.id}
                disabled={busy}
                onChange={() => commit({ decision: option.id })}
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-ui font-semibold">{option.label}</span>
                <span className="text-meta leading-base text-muted">{option.hint}</span>
                {option.id === 'jev' ? (
                  <span className="text-meta leading-base text-warn" data-pack-jev-cap="">
                    Daily cap: ${config.jev.usdPerDay.toFixed(2)} (default $
                    {DEFAULT_PACK_CONFIG.jev.usdPerDay.toFixed(2)})
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
        {config.decision === 'jev' ? (
          <NumbersForm config={config} settings={[JEV_CAP]} title="Jev cap" busy={busy} onSave={commit} />
        ) : null}
      </section>

      <section className="kt-panel flex flex-col gap-4 p-4">
        <NumbersForm config={config} settings={LIMITS} title="Limits" busy={busy} onSave={commit} />
        <NumbersForm config={config} settings={PROBE} title="Probe" busy={busy} onSave={commit} />
      </section>

      {outcome !== null && outcome.kind !== 'applied' ? (
        <p
          role="status"
          data-pack-outcome={outcome.kind}
          className={cn(
            'm-0 rounded-control border px-3 py-2 text-meta leading-base',
            outcome.kind === 'refused'
              ? 'border-err-border bg-err-bg text-err'
              : 'border-warn-border bg-warn-bg text-warn',
          )}
        >
          {outcome.message}
        </p>
      ) : null}

      <RoutingPromptCard
        connection={connection}
        view={view}
        state={state}
        {...(ideaLimit === undefined ? {} : { ideaLimit })}
      />
    </div>
  );
}

function PackSettingsView({
  state,
  connection,
  ideaLimit,
}: {
  readonly state: MachinePack;
  readonly connection: DaemonConnection;
  readonly ideaLimit?: IdeaLimit;
}) {
  const { read } = state;
  if (read.kind === 'loading') return <p className="m-0 text-meta text-muted">Reading Pack mode…</p>;
  if (read.kind === 'failed')
    return (
      <p role="alert" className="m-0 text-meta text-err">
        {read.message}
      </p>
    );
  return (
    <PackPanel
      view={read.view}
      state={state}
      connection={connection}
      {...(ideaLimit === undefined ? {} : { ideaLimit })}
    />
  );
}

function ConnectedPackSettings({ connection }: { readonly connection: DaemonConnection }) {
  // The app ships before the daemon: the raised idea limit waits for the machine to say it takes it.
  const ideaLimit = ideaLimitFor(useDaemonHealth(connection));
  return <PackSettingsView state={useMachinePack(connection)} connection={connection} ideaLimit={ideaLimit} />;
}

/** The panel: an injected state (tests, harness) or the machine's own, read through the app's client pool. */
export function PackSettingsSurface({
  connection,
  state,
}: {
  readonly connection: DaemonConnection;
  readonly state?: MachinePack;
}) {
  return state === undefined ? (
    <ConnectedPackSettings connection={connection} />
  ) : (
    <PackSettingsView state={state} connection={connection} />
  );
}

/** The Machine tab's Pack mode panel, as `DaemonSettingsFrame` takes one. */
export const PACK_SETTINGS_TAB = {
  id: 'pack',
  label: 'Pack mode',
  description: 'Whether ferrets may start sub-ferrets, who picks their models, the limits, and the routing prompt.',
  Surface: PackSettingsSurface,
} as const;
