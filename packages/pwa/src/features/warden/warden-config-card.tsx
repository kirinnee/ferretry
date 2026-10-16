/**
 * Settings › Warden: the form, its Save, and the daemon's answer.
 *
 * The loader takes ONE paired connection and makes a client only for it. Its draft is stamped with the
 * daemon id, so switching paired daemons can never briefly render — or save — the previous daemon's
 * settings, and a late answer from the daemon just left is dropped.
 *
 * A SAVE IS THE OWNER'S OWN ACT. The PATCH carries only what changed, and it is in effect at once. The
 * daemon may still answer with `warnings` — that a loosening change was noted, that an account is
 * unknown — and those are shown verbatim, because the daemon is the one that knows.
 */

import type {
  IFyApiClient,
  SpeedupsView,
  WardenAccount,
  WardenConfig,
  WardenConfigPatch,
  WardenConfigView,
} from '@ferretry/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { daemonSettingsPath } from '../../lib/pages/routes.ts';
import { useDaemonClient } from '../../lib/store.tsx';
import { readSpeedups } from '../speedups/speedups-api.ts';
import { WardenSettingsForm } from './warden-settings-form.tsx';
import {
  hasWardenFormErrors,
  type JevKeyStatus,
  wardenConfigPatchFrom,
  wardenFormErrors,
} from './warden-settings-model.ts';

/** What the Speed-ups read says about the Jev key. A read that failed is `unknown`, never "missing". */
export const jevKeyStatus = (view: SpeedupsView | null): JevKeyStatus => {
  const jev = view?.providers.find(provider => provider.provider === 'jev');
  if (view === null || jev === undefined) return { state: 'unknown' };
  const keyUrl = { keyUrl: jev.keyUrl };
  if (view.vault === 'damaged') return { state: 'unknown', ...keyUrl };
  return { state: jev.set ? 'set' : 'missing', ...keyUrl };
};

export interface WardenConfigCardProps {
  readonly view: WardenConfigView;
  readonly draft: WardenConfig;
  readonly onChange: (next: WardenConfig) => void;
  readonly jevKey: JevKeyStatus;
  readonly loginOptions?: readonly WardenAccount[];
  readonly speedupsHref?: string;
  readonly onNavigate?: (to: string) => void;
  readonly saving?: boolean;
  readonly error?: string | null;
  readonly saved?: boolean;
  readonly onSave: (patch: WardenConfigPatch) => void;
}

export function WardenConfigCard({
  view,
  draft,
  onChange,
  jevKey,
  loginOptions = [],
  speedupsHref,
  onNavigate,
  saving = false,
  error = null,
  saved = false,
  onSave,
}: WardenConfigCardProps) {
  const errors = wardenFormErrors(draft);
  const patch = wardenConfigPatchFrom(view.config, draft);
  const dirty = Object.keys(patch).length > 0;
  return (
    <section aria-label="Warden settings" className="flex min-w-0 flex-col gap-3" data-testid="warden-config-card">
      <WardenSettingsForm
        value={draft}
        onChange={onChange}
        jevKey={jevKey}
        errors={errors}
        loginOptions={loginOptions}
        {...(speedupsHref === undefined ? {} : { speedupsHref })}
        {...(onNavigate === undefined ? {} : { onNavigate })}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="kt-btn min-h-[44px]"
          data-variant="primary"
          disabled={!dirty || saving || hasWardenFormErrors(errors)}
          onClick={() => onSave(patch)}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {dirty && !saving && (
          <button
            type="button"
            className="kt-btn min-h-[44px]"
            data-variant="ghost"
            onClick={() => onChange(view.config)}
          >
            Discard changes
          </button>
        )}
        {saved && !dirty && error === null && (
          <span role="status" className="text-meta text-ok">
            Saved — in effect now.
          </span>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="m-0 text-ui text-err">
          {error}
        </p>
      )}
      {view.warnings.map(warning => (
        <p key={warning} className="m-0 text-ui text-warn">
          {warning}
        </p>
      ))}
    </section>
  );
}

type WardenClient = Pick<IFyApiClient, 'wardenConfig' | 'wardenStatus' | 'updateWardenConfig' | 'request'>;
export type WardenClientFactory = (connection: DaemonConnection) => Promise<WardenClient>;

interface Loaded {
  readonly daemonId: DaemonConnection['daemonId'];
  readonly client: WardenClient;
  readonly view: WardenConfigView;
  readonly draft: WardenConfig;
  readonly jevKey: JevKeyStatus;
  readonly loginOptions: readonly WardenAccount[];
}

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** Live, daemon-bound loader used by Settings. It owns no module cache: daemon A's settings never reach B. */
export function WardenConfigSurface({
  connection,
  createClient: injectedClient,
  unavailable = 'hide',
  onNavigate,
}: {
  readonly connection: DaemonConnection;
  readonly createClient?: WardenClientFactory;
  /** Settings needs an explicit unavailable state, so a failed read never looks like a default policy. */
  readonly unavailable?: 'hide' | 'message';
  readonly onNavigate?: (to: string) => void;
}) {
  // The carrier-routed client unless a test or the harness hands one in: a plain-network client
  // reaches no daemon at all, because a paired browser is answered only inside its own session.
  const routedClient = useDaemonClient();
  const createClient = injectedClient ?? routedClient;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loadFailure, setLoadFailure] = useState<DaemonConnection['daemonId'] | null>(null);

  useEffect(() => {
    let current = true;
    setLoaded(null);
    setError(null);
    setSaved(false);
    setLoadFailure(null);
    void createClient(connection)
      .then(async client => {
        const [view, status, speedups] = await Promise.all([
          client.wardenConfig(),
          client.wardenStatus().catch(() => null),
          readSpeedups(client).catch(() => null),
        ]);
        if (!current) return;
        setLoaded({
          daemonId: connection.daemonId,
          client,
          view,
          draft: view.config,
          jevKey: jevKeyStatus(speedups),
          loginOptions: (status?.failover?.accounts ?? []).map(account => ({ agent: account.agent })),
        });
      })
      .catch(() => {
        if (current) setLoadFailure(connection.daemonId);
      });
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  // The daemon on screen now. A save answered after the reader switched daemon belongs to the one
  // left, so neither its "Saved" nor its error may appear on this one.
  const showing = useRef(connection.daemonId);
  showing.current = connection.daemonId;

  const save = useCallback(async (state: Loaded, patch: WardenConfigPatch) => {
    setSaving(true);
    setError(null);
    try {
      const view = await state.client.updateWardenConfig(patch);
      if (showing.current !== state.daemonId) return;
      setLoaded({ ...state, view, draft: view.config });
      setSaved(true);
    } catch (cause) {
      if (showing.current === state.daemonId) setError(reasonOf(cause));
    } finally {
      setSaving(false);
    }
  }, []);

  if (loaded === null || loaded.daemonId !== connection.daemonId) {
    if (unavailable === 'message' && loadFailure === connection.daemonId)
      return (
        <section className="kt-panel p-panel" role="status" aria-label="Warden settings unavailable">
          <h3 className="m-0 text-row font-semibold text-fg">Warden settings unavailable</h3>
          <p className="mb-0 mt-1 text-cell leading-base text-muted">
            This daemon did not provide its Warden settings. No controls are shown because a change cannot be confirmed
            here.
          </p>
        </section>
      );
    return null;
  }
  return (
    <WardenConfigCard
      view={loaded.view}
      draft={loaded.draft}
      onChange={draft => {
        setLoaded({ ...loaded, draft });
        setSaved(false);
      }}
      jevKey={loaded.jevKey}
      loginOptions={loaded.loginOptions}
      speedupsHref={`${daemonSettingsPath(connection.daemonId)}#speedups`}
      {...(onNavigate === undefined ? {} : { onNavigate })}
      saving={saving}
      error={error}
      saved={saved}
      onSave={patch => void save(loaded, patch)}
    />
  );
}
