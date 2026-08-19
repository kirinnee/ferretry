/**
 * Daemon-scoped Linux resource-limit settings.
 *
 * The daemon is deliberately not part of the capped fleet slice.  This view
 * therefore edits only the aggregate agent slice and each agent scope; it
 * never offers a control that could cap the process needed to undo a mistake.
 */

import type { CgroupConfigPatch, CgroupConfigView, IFyApiClient } from '@ferretry/protocol';
import { CircleAlert, Cpu, LoaderCircle, MemoryStick, RotateCcw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';

import { daemonApiClient } from '../../lib/api-client.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';

export interface CgroupConfigDraft {
  readonly enabled: boolean;
  readonly fleetCpuPercent: number;
  readonly fleetMemoryPercent: number;
  readonly agentCpuPercent: number;
  readonly agentMemoryPercent: number;
}

export const editableCgroupConfig = (view: CgroupConfigView): CgroupConfigDraft => ({
  enabled: view.config.enabled,
  fleetCpuPercent: view.config.fleet.cpuPercent,
  fleetMemoryPercent: view.config.fleet.memoryPercent,
  agentCpuPercent: view.config.perAgent.cpuPercent,
  agentMemoryPercent: view.config.perAgent.memoryPercent,
});

const percent = (value: number): number => Math.min(100, Math.max(1, Math.trunc(value) || 1));

/** The protocol rejects an agent limit above the fleet aggregate; keep that
 * invariant true before sending so the UI can state the precedence plainly. */
export const cgroupConfigPatch = (draft: CgroupConfigDraft): CgroupConfigPatch => {
  const fleetCpuPercent = percent(draft.fleetCpuPercent);
  const fleetMemoryPercent = percent(draft.fleetMemoryPercent);
  return {
    enabled: draft.enabled,
    fleet: { cpuPercent: fleetCpuPercent, memoryPercent: fleetMemoryPercent },
    perAgent: {
      cpuPercent: Math.min(percent(draft.agentCpuPercent), fleetCpuPercent),
      memoryPercent: Math.min(percent(draft.agentMemoryPercent), fleetMemoryPercent),
    },
  };
};

function LimitInput({
  label,
  value,
  onChange,
  disabled,
  icon,
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly disabled: boolean;
  readonly icon: 'cpu' | 'memory';
}) {
  const id = useId();
  const Icon = icon === 'cpu' ? Cpu : MemoryStick;
  return (
    <label className="grid min-w-0 gap-1 text-cell font-medium text-fg" htmlFor={id}>
      <span className="flex items-center gap-1.5">
        <Icon size={14} aria-hidden="true" />
        {label}
      </span>
      {/* A FIELD AS WIDE AS ITS VALUE. This stretched to fill its grid column, so a two-digit
          percentage sat in a 400px box with 380px of empty space and its `%` suffix stranded at the
          far end — the field stopped reading as a number and read as a broken text input. It is
          capped at the width three digits need, and the `%` sits against it where a unit belongs. */}
      <span className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          min={1}
          max={100}
          step={1}
          value={value}
          disabled={disabled}
          onChange={event => onChange(Number(event.target.value))}
          className="h-control w-[5.5rem] min-w-0 rounded-control border border-border bg-surface-2 px-control-x text-ui text-fg disabled:cursor-not-allowed disabled:opacity-60"
        />
        <span className="text-cell text-muted" aria-hidden="true">
          %
        </span>
      </span>
    </label>
  );
}

export interface CgroupConfigCardProps {
  readonly connection: DaemonConnection;
  readonly view: CgroupConfigView;
  readonly saving?: boolean;
  readonly error?: string | null;
  readonly saved?: boolean;
  readonly onSave: (patch: CgroupConfigPatch) => void | Promise<void>;
}

export function CgroupConfigCard({
  connection,
  view,
  saving = false,
  error = null,
  saved = false,
  onSave,
}: CgroupConfigCardProps) {
  const [draftState, setDraftState] = useState(() => ({
    daemonId: connection.daemonId,
    draft: editableCgroupConfig(view),
  }));
  const [dirty, setDirty] = useState(false);
  const draft = draftState.daemonId === connection.daemonId ? draftState.draft : editableCgroupConfig(view);
  const editable = view.supported;

  useEffect(() => {
    setDraftState({ daemonId: connection.daemonId, draft: editableCgroupConfig(view) });
    setDirty(false);
  }, [connection.daemonId, view]);

  const update = (next: CgroupConfigDraft): void => {
    setDraftState({ daemonId: connection.daemonId, draft: next });
    setDirty(true);
  };
  const patch = cgroupConfigPatch(draft);

  return (
    <section
      className="kt-panel flex min-w-0 flex-col gap-3 p-panel"
      data-testid="cgroup-config-card"
      aria-labelledby="cgroup-config-heading"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="cgroup-config-heading" className="m-0 flex items-center gap-1.5 text-row font-semibold text-fg">
          <ShieldCheck size={16} className="text-accent" aria-hidden="true" /> Fleet resource limits
        </h3>
        <span
          className={
            editable
              ? 'rounded-control bg-ok-bg px-2 py-0.5 text-meta font-medium text-ok'
              : 'rounded-control bg-warn-bg px-2 py-0.5 text-meta font-medium text-warn'
          }
        >
          {editable ? (view.config.enabled ? 'enforced' : 'disabled') : 'unavailable on this platform'}
        </span>
      </div>
      <p className="m-0 text-cell leading-base text-muted">
        Linux cgroup v2 places managed agents below <code className="font-mono text-fg">{view.fleetSlice}</code>. The
        daemon and Warden stay outside that slice, so these controls cannot starve supervision.
      </p>

      {!editable ? (
        <div className="grid gap-2">
          <p
            role="status"
            className="m-0 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui leading-base text-warn"
          >
            Resource enforcement is unavailable on this platform. Ferretry is showing the daemon’s declared limits only;
            it does not render limit controls that would silently do nothing.
          </p>
          {view.config.enabled ? (
            <button
              type="button"
              className="kt-btn min-h-[44px] self-start"
              disabled={saving}
              onClick={() => void onSave({ enabled: false })}
            >
              {saving ? (
                <LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              ) : (
                <ShieldCheck size={15} aria-hidden="true" />
              )}
              Disable saved enforcement
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <label className="flex min-h-[44px] items-center justify-between gap-3 rounded-control border border-border bg-surface-2 px-control-x py-2 text-ui text-fg">
            <span>
              <span className="block font-semibold">Enforce limits</span>
              <span className="block text-meta leading-tight text-muted">
                New and relaunched agents enter managed cgroup scopes.
              </span>
            </span>
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={saving}
              onChange={event => update({ ...draft, enabled: event.target.checked })}
              className="h-4 w-4 accent-accent"
            />
          </label>
          <fieldset disabled={saving} className="grid min-w-0 gap-3 border-0 p-0">
            <legend className="text-ui font-semibold text-fg">Fleet-wide aggregate cap</legend>
            <div className="grid grid-cols-2 gap-2">
              <LimitInput
                label="CPU"
                value={draft.fleetCpuPercent}
                onChange={fleetCpuPercent => update({ ...draft, fleetCpuPercent })}
                disabled={saving}
                icon="cpu"
              />
              <LimitInput
                label="RAM"
                value={draft.fleetMemoryPercent}
                onChange={fleetMemoryPercent => update({ ...draft, fleetMemoryPercent })}
                disabled={saving}
                icon="memory"
              />
            </div>
          </fieldset>
          <fieldset disabled={saving} className="grid min-w-0 gap-3 border-0 p-0">
            <legend className="text-ui font-semibold text-fg">Per-agent cap</legend>
            <div className="grid grid-cols-2 gap-2">
              <LimitInput
                label="CPU"
                value={draft.agentCpuPercent}
                onChange={agentCpuPercent => update({ ...draft, agentCpuPercent })}
                disabled={saving}
                icon="cpu"
              />
              <LimitInput
                label="RAM"
                value={draft.agentMemoryPercent}
                onChange={agentMemoryPercent => update({ ...draft, agentMemoryPercent })}
                disabled={saving}
                icon="memory"
              />
            </div>
          </fieldset>
          <p className="m-0 rounded-control border border-border-strong bg-surface-2 px-3 py-2 text-meta leading-base text-muted">
            <strong className="text-fg">Effective limits:</strong> the fleet slice permits{' '}
            {view.effective.fleet.cpuQuota} CPU and {view.effective.fleet.memoryMax} bytes RAM in total. Each agent
            permits {view.effective.perAgent.cpuQuota} CPU and {view.effective.perAgent.memoryMax} bytes RAM. Per-agent
            values cannot exceed the fleet aggregate; the active agent cap is the per-agent value, within the fleet’s
            shared ceiling.
          </p>
          <button
            type="button"
            className="kt-btn min-h-[44px] self-start"
            disabled={saving || !dirty}
            onClick={() => void onSave(patch)}
          >
            {saving ? (
              <LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <ShieldCheck size={15} aria-hidden="true" />
            )}
            Apply resource limits
          </button>
        </>
      )}

      {view.restartRequiredSessions.length > 0 ? (
        <p className="m-0 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-meta leading-base text-warn">
          <RotateCcw size={14} className="mr-1 inline" aria-hidden="true" /> Restart required before the change applies
          to: {view.restartRequiredSessions.join(', ')}. New agents use the saved configuration.
        </p>
      ) : null}
      {view.warnings.map(warning => (
        <p
          key={warning}
          role="alert"
          className="m-0 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-meta leading-base text-warn"
        >
          <CircleAlert size={14} className="mr-1 inline" aria-hidden="true" />
          Resource-limit warning: {warning}
        </p>
      ))}
      {error ? (
        <p
          role="alert"
          className="m-0 rounded-control border border-err-border bg-err-bg px-3 py-2 text-meta leading-base text-err"
        >
          Apply failed: {error}. Existing scopes may retain their prior limits; verify the host before relying on a new
          cap.
        </p>
      ) : null}
      {saved && !dirty && !error ? (
        <p role="status" className="m-0 text-meta text-ok">
          Saved. Restart requirements and any host apply warning are shown above.
        </p>
      ) : null}
    </section>
  );
}

type CgroupClient = Pick<IFyApiClient, 'cgroupConfig' | 'updateCgroupConfig'>;
export type CgroupClientFactory = (connection: DaemonConnection) => Promise<CgroupClient>;

export function CgroupConfigSurface({
  connection,
  createClient = daemonApiClient,
}: {
  readonly connection: DaemonConnection;
  readonly createClient?: CgroupClientFactory;
}) {
  const [client, setClient] = useState<CgroupClient | null>(null);
  const [view, setView] = useState<{
    readonly daemonId: DaemonConnection['daemonId'];
    readonly value: CgroupConfigView;
  } | null>(null);
  const [failure, setFailure] = useState<{
    readonly daemonId: DaemonConnection['daemonId'];
    readonly reason: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let current = true;
    setClient(null);
    setView(null);
    setFailure(null);
    setError(null);
    setSaved(false);
    void createClient(connection)
      .then(async next => {
        const value = await next.cgroupConfig();
        if (!current) return;
        setClient(next);
        setView({ daemonId: connection.daemonId, value });
      })
      .catch(cause => {
        if (current)
          setFailure({ daemonId: connection.daemonId, reason: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  const save = useCallback(
    async (patch: CgroupConfigPatch) => {
      if (!client || view?.daemonId !== connection.daemonId) return;
      setSaving(true);
      setError(null);
      try {
        const value = await client.updateCgroupConfig(patch);
        setView({ daemonId: connection.daemonId, value });
        setSaved(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSaving(false);
      }
    },
    [client, connection.daemonId, view?.daemonId],
  );

  if (view?.daemonId === connection.daemonId)
    return (
      <CgroupConfigCard
        connection={connection}
        view={view.value}
        saving={saving}
        error={error}
        saved={saved}
        onSave={save}
      />
    );
  if (failure?.daemonId === connection.daemonId)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Resource limits unavailable">
        <h3 className="m-0 text-row font-semibold text-fg">Resource limits unavailable</h3>
        <p className="mb-0 mt-1 text-cell leading-base text-muted">
          This daemon did not provide cgroup enforcement state. Ferretry will not assume that limits are disabled or
          applied. {failure.reason}
        </p>
      </section>
    );
  return null;
}
