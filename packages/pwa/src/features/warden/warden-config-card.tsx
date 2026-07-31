/**
 * Warden account failover editor, ported from kteam's WardenConfigCard.
 *
 * The old UI read an ambient API singleton.  This version accepts a paired
 * connection and creates a client only for that connection.  Its local draft
 * is stamped with `daemonId`, so changing paired daemons can never briefly
 * render or save the previous daemon's account order.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, ShieldCheck, X } from 'lucide-react';
import type {
  IFyApiClient,
  WardenAccount,
  WardenConfigPatch,
  WardenConfigView,
  WardenFailoverPolicy,
  WardenFailoverStatus,
} from '@ferretry/protocol';

import { daemonApiClient } from '../../lib/api-client.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';

const POLICY_OPTIONS: ReadonlyArray<{
  readonly id: WardenFailoverPolicy;
  readonly label: string;
  readonly description: string;
}> = [
  { id: 'fallback', label: 'Fallback', description: 'Always prefer the first healthy account, in order.' },
  { id: 'round_robin', label: 'Round-robin', description: 'Rotate spawns across healthy accounts.' },
];

export interface WardenConfigDraft {
  readonly enabled: boolean;
  readonly accounts: readonly WardenAccount[];
  readonly policy: WardenFailoverPolicy;
  readonly failureThreshold: number;
  readonly cooldownMinutes: number;
}

export const editableWardenConfig = (view: WardenConfigView): WardenConfigDraft => ({
  enabled: view.config.enabled,
  accounts: view.accounts.map(account => ({ ...account })),
  policy: view.config.failover.policy,
  failureThreshold: view.config.failover.failureThreshold,
  cooldownMinutes: view.config.failover.cooldownMinutes,
});

export const wardenConfigPatch = (draft: WardenConfigDraft): WardenConfigPatch => ({
  enabled: draft.enabled,
  accounts: draft.accounts.map(account => ({ ...account })),
  failover: {
    policy: draft.policy,
    failureThreshold: Math.max(1, Math.trunc(draft.failureThreshold) || 1),
    cooldownMinutes: Math.max(1, Math.trunc(draft.cooldownMinutes) || 1),
  },
});

export const wardenAccountHealth = (
  account: WardenAccount,
  failover: WardenFailoverStatus | undefined,
): { readonly label: string; readonly tone: 'ok' | 'warn' | 'muted' } => {
  const live = failover?.accounts.find(candidate => candidate.agent === account.agent);
  if (!live) return { label: 'health unknown', tone: 'muted' };
  if (live.eligible) {
    const quota = live.quota;
    const detail =
      quota?.fiveHourPercent !== undefined || quota?.weeklyPercent !== undefined
        ? ` · 5h ${quota.fiveHourPercent ?? '—'}% wk ${quota.weeklyPercent ?? '—'}%`
        : '';
    return { label: `healthy${detail}`, tone: 'ok' };
  }
  return { label: live.reason ?? 'ineligible', tone: 'warn' };
};

export interface WardenConfigCardProps {
  readonly connection: DaemonConnection;
  readonly view: WardenConfigView;
  readonly failover?: WardenFailoverStatus;
  /** The host's daemon-scoped account catalogue. The protocol does not expose
   * wrapper discovery yet, so an empty catalogue simply disables adding. */
  readonly availableAccounts?: readonly WardenAccount[];
  readonly saving?: boolean;
  readonly error?: string | null;
  readonly saved?: boolean;
  readonly onSave: (patch: WardenConfigPatch) => void | Promise<void>;
}

export function WardenConfigCard({
  connection,
  view,
  failover,
  availableAccounts = [],
  saving = false,
  error = null,
  saved = false,
  onSave,
}: WardenConfigCardProps) {
  const [draftState, setDraftState] = useState(() => ({
    daemonId: connection.daemonId,
    draft: editableWardenConfig(view),
  }));
  const [picker, setPicker] = useState('');
  const [dirty, setDirty] = useState(false);
  const draft = draftState.daemonId === connection.daemonId ? draftState.draft : editableWardenConfig(view);

  useEffect(() => {
    setDraftState({ daemonId: connection.daemonId, draft: editableWardenConfig(view) });
    setPicker('');
    setDirty(false);
  }, [connection.daemonId, view]);

  const pickable = useMemo(
    () => availableAccounts.filter(candidate => !draft.accounts.some(account => account.agent === candidate.agent)),
    [availableAccounts, draft.accounts],
  );
  const update = (next: WardenConfigDraft) => {
    setDraftState({ daemonId: connection.daemonId, draft: next });
    setDirty(true);
  };
  const move = (index: number, delta: -1 | 1) => {
    const accounts = [...draft.accounts];
    const target = index + delta;
    if (target < 0 || target >= accounts.length) return;
    const [account] = accounts.splice(index, 1);
    if (!account) return;
    accounts.splice(target, 0, account);
    update({ ...draft, accounts });
  };

  return (
    <section
      aria-labelledby="warden-config-heading"
      className="kt-panel flex flex-col gap-3 p-panel"
      data-testid="warden-config-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="warden-config-heading" className="m-0 flex items-center gap-1.5 text-title font-semibold text-fg">
          <ShieldCheck size={16} className="text-accent" aria-hidden="true" />
          Warden accounts &amp; failover
        </h2>
        {failover?.exhaustedSince && (
          <span className="rounded-control bg-warn/15 px-2 py-0.5 text-meta font-medium text-warn">
            all accounts unhealthy
          </span>
        )}
      </div>
      <p className="m-0 text-ui leading-base text-muted">
        Ordered warden account list. Changes apply live — no daemon restart. Under Fallback the first healthy account
        wins.
      </p>

      <fieldset aria-label="Failover policy" className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        {POLICY_OPTIONS.map(option => {
          const checked = draft.policy === option.id;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={checked}
              onClick={() => update({ ...draft, policy: option.id })}
              className={cn(
                'flex min-h-[44px] min-w-0 flex-col items-start justify-center rounded-control border px-control-x py-2 text-left transition-colors',
                checked
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-border bg-surface-2 text-fg hover:border-accent',
              )}
            >
              <span className="text-ui font-semibold">{option.label}</span>
              <span className="text-meta leading-tight text-muted">{option.description}</span>
            </button>
          );
        })}
      </fieldset>

      <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Warden accounts">
        {draft.accounts.map((account, index) => {
          const health = wardenAccountHealth(account, failover);
          return (
            <li
              key={account.agent}
              className="flex flex-wrap items-center gap-2 rounded-control border border-border-soft bg-surface-2 px-3 py-2"
            >
              <span className="mono text-ui font-medium text-fg">
                {index + 1}. {account.agent}
              </span>
              {account.model && <span className="mono text-meta text-muted">model={account.model}</span>}
              {account.agent === failover?.lastSelection?.agent && (
                <span className="rounded-control bg-accent-soft px-1.5 py-0.5 text-meta font-medium text-accent">
                  active
                </span>
              )}
              <span
                className={cn(
                  'text-meta',
                  health.tone === 'ok' ? 'text-ok' : health.tone === 'warn' ? 'text-warn' : 'text-faint',
                )}
              >
                {health.label}
              </span>
              <span className="ml-auto inline-flex items-center gap-1">
                <button
                  type="button"
                  className="kt-btn kt-btn--sm"
                  aria-label={`Move ${account.agent} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="kt-btn kt-btn--sm"
                  aria-label={`Move ${account.agent} down`}
                  disabled={index === draft.accounts.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="kt-btn kt-btn--sm"
                  aria-label={`Remove ${account.agent}`}
                  disabled={draft.accounts.length <= 1}
                  onClick={() =>
                    update({ ...draft, accounts: draft.accounts.filter((_, itemIndex) => itemIndex !== index) })
                  }
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </span>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-ui text-fg">
          <span className="text-muted">Add account</span>
          <select
            aria-label="Add warden account"
            className="kt-input min-h-[36px] rounded-control border border-border bg-surface-2 px-2 text-ui"
            value={picker}
            onChange={event => setPicker(event.target.value)}
          >
            <option value="">choose an account…</option>
            {pickable.map(account => (
              <option key={account.agent} value={account.agent}>
                {account.agent}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          aria-label="Add selected warden account"
          className="kt-btn inline-flex items-center gap-1"
          disabled={!picker}
          onClick={() => {
            const account = pickable.find(candidate => candidate.agent === picker);
            if (!account) return;
            update({ ...draft, accounts: [...draft.accounts, { ...account }] });
            setPicker('');
          }}
        >
          <Plus size={14} aria-hidden="true" /> Add
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-ui text-muted">
          Failure threshold
          <input
            type="number"
            min={1}
            aria-label="Failure threshold"
            className="kt-input w-24 min-h-[36px] rounded-control border border-border bg-surface-2 px-2 text-fg"
            value={draft.failureThreshold}
            onChange={event => update({ ...draft, failureThreshold: Number(event.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1 text-ui text-muted">
          Cooldown (minutes)
          <input
            type="number"
            min={1}
            aria-label="Cooldown minutes"
            className="kt-input w-24 min-h-[36px] rounded-control border border-border bg-surface-2 px-2 text-fg"
            value={draft.cooldownMinutes}
            onChange={event => update({ ...draft, cooldownMinutes: Number(event.target.value) })}
          />
        </label>
        <label className="flex min-h-[44px] items-center gap-2 text-ui text-fg">
          <input
            type="checkbox"
            aria-label="Enable LLM escalation"
            checked={draft.enabled}
            onChange={event => update({ ...draft, enabled: event.target.checked })}
          />
          LLM escalation enabled
        </label>
        <button
          type="button"
          className="kt-btn ml-auto min-h-[44px]"
          data-variant="primary"
          disabled={!dirty || saving || draft.accounts.length === 0}
          onClick={() => void onSave(wardenConfigPatch(draft))}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {error && (
        <p role="alert" className="m-0 text-ui text-err">
          {error}
        </p>
      )}
      {view.warnings.map(warning => (
        <p key={warning} className="m-0 text-ui text-warn">
          {warning}
        </p>
      ))}
      {saved && !dirty && !error && (
        <p role="status" className="m-0 text-meta text-ok">
          Saved — the next sweep uses this configuration.
        </p>
      )}
    </section>
  );
}

type WardenClient = Pick<IFyApiClient, 'wardenConfig' | 'wardenStatus' | 'updateWardenConfig'>;
export type WardenClientFactory = (connection: DaemonConnection) => Promise<WardenClient>;

/** Live, daemon-bound loader used by the Warden route.  It intentionally owns
 * no module cache: config from daemon A must not be reusable for daemon B. */
export function WardenConfigSurface({
  connection,
  createClient = daemonApiClient,
}: {
  readonly connection: DaemonConnection;
  readonly createClient?: WardenClientFactory;
}) {
  const [client, setClient] = useState<WardenClient | null>(null);
  const [loaded, setLoaded] = useState<{
    readonly daemonId: DaemonConnection['daemonId'];
    readonly view: WardenConfigView;
    readonly failover?: WardenFailoverStatus;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let current = true;
    setClient(null);
    setLoaded(null);
    setError(null);
    setSaved(false);
    void createClient(connection)
      .then(async nextClient => {
        const [view, status] = await Promise.all([
          nextClient.wardenConfig(),
          nextClient.wardenStatus().catch(() => null),
        ]);
        if (!current) return;
        setClient(nextClient);
        setLoaded({ daemonId: connection.daemonId, view, ...(status?.failover ? { failover: status.failover } : {}) });
      })
      .catch(() => {
        // The legacy component hid on old daemons rather than rendering a dead editor.
        if (current) setLoaded(null);
      });
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  const save = useCallback(
    async (patch: WardenConfigPatch) => {
      if (!client || loaded?.daemonId !== connection.daemonId) return;
      setSaving(true);
      setError(null);
      try {
        const view = await client.updateWardenConfig(patch);
        const status = await client.wardenStatus().catch(() => null);
        setLoaded({ daemonId: connection.daemonId, view, ...(status?.failover ? { failover: status.failover } : {}) });
        setSaved(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSaving(false);
      }
    },
    [client, connection.daemonId, loaded?.daemonId],
  );

  if (loaded === null || loaded.daemonId !== connection.daemonId) return null;
  return (
    <WardenConfigCard
      connection={connection}
      view={loaded.view}
      failover={loaded.failover}
      saving={saving}
      error={error}
      saved={saved}
      onSave={save}
    />
  );
}
