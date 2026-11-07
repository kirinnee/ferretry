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

import type { WardenAccount, WardenConfig, WardenConfigPatch, WardenConfigView } from '../../wire.ts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useWardenClientFactory, type WardenClientFactory } from '../../lib/warden-client-context.tsx';
import type { WardenClient } from '../../lib/warden-client.ts';
import {
  type DaemonConnection,
  daemonSettingsPath,
  type PickerAccount,
  readAccountPickerCatalog,
  readSpeedups,
  type SpeedupsView,
  useConfigChangeEffect,
} from '../../shell.ts';
import { WardenSettingsForm } from './warden-settings-form.tsx';
import {
  hasWardenFormErrors,
  type JevKeyStatus,
  wardenConfigPatchFrom,
  wardenMachineDefaultLogin,
  wardenFormErrors,
} from './warden-settings-model.ts';

/** What the Speed-ups read says about the Jev key. A read that failed is `unknown`, never "missing". */
export const jevKeyStatus = (view: SpeedupsView | null): JevKeyStatus => {
  const jev = view?.providers.find((provider: { readonly provider: string }) => provider.provider === 'jev');
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
  /** The runtimes and their models, for the model field (docs/model-catalog.md). */
  readonly runtimes?: readonly PickerAccount[];
  readonly speedupsHref?: string;
  readonly browserHref?: string;
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
  runtimes = [],
  speedupsHref,
  browserHref,
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
        runtimes={runtimes}
        {...(view.login === undefined ? {} : { login: view.login })}
        {...(wardenMachineDefaultLogin(view) === undefined ? {} : { machineDefault: wardenMachineDefaultLogin(view) })}
        {...(speedupsHref === undefined ? {} : { speedupsHref })}
        {...(browserHref === undefined ? {} : { browserHref })}
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

/**
 * What the surface reads besides the Warden's own routes. Each is another plugin's fact, so the shell supplies it
 * (`../../shell.ts`); a test hands its own.
 */
export interface WardenConfigDeps {
  /** The Speed-ups description of a machine: whether its Jev key is set. */
  readonly speedups: (connection: DaemonConnection) => Promise<SpeedupsView>;
  /** The logins the machine has and the models each offers. */
  readonly catalog: (connection: DaemonConnection) => Promise<{ readonly accounts: readonly PickerAccount[] }>;
  /** Runs `onChange` whenever one of `kinds` moves on the daemon. */
  readonly useConfigChange: (
    daemonId: DaemonConnection['daemonId'],
    kinds: readonly string[],
    onChange: () => void,
  ) => void;
}

const SHELL_DEPS: WardenConfigDeps = {
  speedups: readSpeedups,
  catalog: readAccountPickerCatalog,
  useConfigChange: useConfigChangeEffect,
};

/** The card shows the Warden's settings and whether its Jev key is set in Speed-ups. */
// A runtime or the machine default moving changes which login the Warden resolves, so they refresh it too.
const WARDEN_CARD_KINDS = ['warden', 'speedups', 'machine', 'runtimes', 'credentials'] as const;

interface Loaded {
  readonly daemonId: DaemonConnection['daemonId'];
  readonly client: WardenClient;
  readonly view: WardenConfigView;
  readonly draft: WardenConfig;
  readonly jevKey: JevKeyStatus;
  readonly loginOptions: readonly WardenAccount[];
  /** The runtimes and the models each offers (docs/model-catalog.md), for the model field; empty when unread. */
  readonly runtimes: readonly PickerAccount[];
}

const loginOptionsOf = (
  view: WardenConfigView,
  status: { readonly failover?: { readonly accounts: readonly { readonly agent: string }[] } | undefined } | null,
): readonly WardenAccount[] =>
  (view.login?.available ?? status?.failover?.accounts.map(account => account.agent) ?? []).map(agent => ({ agent }));

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** Live, daemon-bound loader used by Settings. It owns no module cache: daemon A's settings never reach B. */
export function WardenConfigSurface({
  connection,
  createClient: injectedClient,
  unavailable = 'hide',
  onNavigate,
  deps = SHELL_DEPS,
}: {
  readonly connection: DaemonConnection;
  readonly createClient?: WardenClientFactory;
  /** Settings needs an explicit unavailable state, so a failed read never looks like a default policy. */
  readonly unavailable?: 'hide' | 'message';
  /** Test and harness seam; production reads through the shell. */
  readonly deps?: WardenConfigDeps;
  readonly onNavigate?: (to: string) => void;
}) {
  // The plugin client of the daemon unless a test or the harness hands one in.
  const routedClient = useWardenClientFactory();
  const createClient = injectedClient ?? routedClient;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loadFailure, setLoadFailure] = useState<DaemonConnection['daemonId'] | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` is a test seam handed in once; its functions must not restart the load
  useEffect(() => {
    let current = true;
    setLoaded(null);
    setError(null);
    setSaved(false);
    setLoadFailure(null);
    void createClient(connection)
      .then(async client => {
        const [view, status, speedups, runtimes] = await Promise.all([
          client.config(),
          client.status().catch(() => null),
          deps.speedups(connection).catch(() => null),
          // The model field lists the chosen login's catalog; without the list it is a plain text box.
          deps.catalog(connection).then(
            (catalog: { readonly accounts: readonly PickerAccount[] }) => catalog.accounts,
            () => [],
          ),
        ]);
        if (!current) return;
        setLoaded({
          daemonId: connection.daemonId,
          client,
          view,
          draft: view.config,
          jevKey: jevKeyStatus(speedups),
          // Every login this machine has, so a Warden with none chosen yet can be given one; without the list,
          // the ones in its failover order.
          loginOptions: loginOptionsOf(view, status),
          runtimes,
        });
      })
      .catch(() => {
        if (current) setLoadFailure(connection.daemonId);
      });
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  // Changed anywhere else — another device, `fy`, a hand edit of warden.yaml, a key added in
  // Speed-ups — and read again without blanking the card. An unsaved edit is kept: only a draft that
  // still matches what was on screen follows the machine's new settings.
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  deps.useConfigChange(connection.daemonId, WARDEN_CARD_KINDS, () => {
    const before = loadedRef.current;
    if (before === null || before.daemonId !== connection.daemonId) return;
    void Promise.all([
      before.client.config(),
      deps.speedups(connection).catch(() => null),
      deps.catalog(connection).then(
        (catalog: { readonly accounts: readonly PickerAccount[] }) => catalog.accounts,
        () => null,
      ),
    ])
      .then(([view, speedups, runtimes]) => {
        setLoaded(current => {
          if (current === null || current.daemonId !== before.daemonId) return current;
          const untouched = JSON.stringify(current.draft) === JSON.stringify(current.view.config);
          return {
            ...current,
            view,
            draft: untouched ? view.config : current.draft,
            jevKey: jevKeyStatus(speedups),
            loginOptions: loginOptionsOf(view, null),
            runtimes: runtimes ?? current.runtimes,
          };
        });
      })
      .catch(() => undefined);
  });

  // The daemon on screen now. A save answered after the reader switched daemon belongs to the one
  // left, so neither its "Saved" nor its error may appear on this one.
  const showing = useRef(connection.daemonId);
  showing.current = connection.daemonId;

  const save = useCallback(async (state: Loaded, patch: WardenConfigPatch) => {
    setSaving(true);
    setError(null);
    try {
      const answer = await state.client.updateConfig(patch);
      // An edit that loosens what the warden may do or spend waits for the owner; the daemon names each one.
      const view = {
        ...answer,
        warnings: [
          ...answer.warnings,
          ...(answer.held ?? []).map(sentence => `Waiting for your approval: ${sentence}`),
        ],
      };
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
      runtimes={loaded.runtimes}
      speedupsHref={`${daemonSettingsPath(connection.daemonId)}#speedups`}
      browserHref={`${daemonSettingsPath(connection.daemonId)}/browser`}
      {...(onNavigate === undefined ? {} : { onNavigate })}
      saving={saving}
      error={error}
      saved={saved}
      onSave={patch => void save(loaded, patch)}
    />
  );
}
