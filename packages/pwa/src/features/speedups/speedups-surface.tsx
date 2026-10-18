/**
 * Settings › This machine › Speed-ups.
 *
 * Three optional keys, each one a card: what it speeds up, what it costs, what leaves the machine,
 * where to get a key (as text AND a link — a link alone can be blocked or unreadable aloud), a paste
 * field, a Test and the answer of the last Test.
 *
 * WRITE-ONLY, LIKE EVERY SECRET. A pasted key goes to `POST /v1/secrets` under the name the daemon
 * names, and the field clears. Nothing here can show a key again: the daemon answers "set ✓" and an
 * instant, never a value.
 *
 * A TEST IS THE OWNER'S ACT. It never runs on load or on a timer; Groq and Cerebras are tested with a
 * free model listing, Jev with one tiny decision, and each card says which before the button is
 * pressed.
 *
 * A READ THAT FAILED IS NOT "NOTHING SET". Like the secret store, a daemon that could not be read
 * renders as a stated refusal, and a damaged vault says so rather than showing every key unset.
 */

import {
  MIN_SECRET_VALUE_LENGTH,
  type SpeedupStatus,
  type SpeedupsView,
  type SpeedupTestResult,
} from '@ferretry/protocol';
import { AlertTriangle, Check, ExternalLink, FlaskConical, KeyRound, Zap } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useConfigChangeEffect, useDaemonClient } from '../../lib/store.tsx';
import { putSecret } from '../secrets/secrets-api.ts';
import { readSpeedups, type SpeedupClient, testSpeedup } from './speedups-api.ts';

export type SpeedupClientFactory = (connection: DaemonConnection) => Promise<SpeedupClient>;

export const SPEEDUPS_INTRO =
  'Optional keys that make this machine faster or cheaper. Each one is stored in this machine’s secret store: it is never shown again, never sent to this browser, and only ever sent to its own provider.';

export const SPEEDUPS_FALLBACK =
  'Without them nothing breaks: the Warden investigates every flag with its own model, and dictation uses on-device word correction.';

const formatInstant = (at: string): string => `${at.slice(0, 10)} ${at.slice(11, 16)}`;

/** One line about the last Test, or nothing when there was none. */
export function lastTestLine(status: SpeedupStatus): string | undefined {
  const last = status.lastTest;
  if (last === undefined) return undefined;
  const timing = last.latencyMs === undefined ? '' : ` · ${Math.round(last.latencyMs)} ms`;
  const verdict = last.ok ? 'Worked' : 'Failed';
  const stale = status.testStale ? ' The key has changed since — test again.' : '';
  return `${verdict} ${formatInstant(last.at)}${timing}. ${last.message}${stale}`;
}

/** Why a pasted key cannot be saved yet, or nothing. */
export function keyDraftProblem(value: string): string | undefined {
  if (value === '' || value.trim().length >= MIN_SECRET_VALUE_LENGTH) return undefined;
  return `At least ${MIN_SECRET_VALUE_LENGTH} characters. That looks too short to be a whole key.`;
}

export interface SpeedupCardProps {
  readonly status: SpeedupStatus;
  /** False when the secret store could not be read: "set" is then unknown, never "not set". */
  readonly vaultReadable: boolean;
  /** What THIS card is doing right now. */
  readonly busy: 'saving' | 'testing' | null;
  /** Another card is busy: one key at a time, so two Tests never race for the same ledger line. */
  readonly locked?: boolean;
  readonly error: string | null;
  readonly onSave: (value: string) => void | Promise<void>;
  readonly onTest: () => void | Promise<void>;
}

function StatusChip({ status, vaultReadable }: { readonly status: SpeedupStatus; readonly vaultReadable: boolean }) {
  if (!vaultReadable)
    return <span className="rounded-control bg-warn-soft px-2 py-0.5 text-meta font-medium text-warn">Can’t tell</span>;
  if (status.set)
    return (
      <span
        className="inline-flex items-center gap-1 rounded-control bg-accent-soft px-2 py-0.5 text-meta font-medium text-ok"
        data-speedup-set=""
      >
        <Check size={12} aria-hidden="true" /> Set
      </span>
    );
  return <span className="rounded-control bg-surface-2 px-2 py-0.5 text-meta font-medium text-faint">Not set</span>;
}

export function SpeedupCard({ status, vaultReadable, busy, locked = false, error, onSave, onTest }: SpeedupCardProps) {
  const fieldId = useId();
  const headingId = useId();
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState(false);
  const problem = keyDraftProblem(value);
  const idle = busy === null && !locked;
  const ready = value.trim().length >= MIN_SECRET_VALUE_LENGTH && idle;
  const showField = !status.set || replacing;
  const line = lastTestLine(status);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    void Promise.resolve(onSave(value.trim())).then(() => {
      setValue('');
      setReplacing(false);
    });
  };

  return (
    <section
      className="kt-panel flex min-w-0 flex-col gap-2 p-panel"
      aria-labelledby={headingId}
      data-speedup={status.provider}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="m-0 text-row font-semibold text-fg">
          {status.label}
        </h3>
        <StatusChip status={status} vaultReadable={vaultReadable} />
      </div>
      <p className="m-0 text-cell leading-base text-fg">{status.purpose}</p>
      <p className="m-0 text-meta leading-base text-muted">{status.costNote}</p>
      <p className="m-0 text-meta leading-base text-muted">{status.privacyNote}</p>
      <p className="m-0 flex min-w-0 flex-wrap items-center gap-1 text-meta leading-base text-muted">
        <span>Get a key:</span>
        <a
          href={status.keyUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex min-w-0 items-center gap-1 break-all text-accent underline"
        >
          {status.keyUrl}
          <ExternalLink size={12} aria-hidden="true" className="shrink-0" />
        </a>
      </p>

      {showField ? (
        <form className="flex min-w-0 flex-col gap-1" onSubmit={submit} aria-label={`Save the ${status.label} key`}>
          <label className="text-cell font-medium text-fg" htmlFor={fieldId}>
            {status.label} key <span className="mono text-meta font-normal text-faint">({status.secretName})</span>
          </label>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
            <input
              id={fieldId}
              // `password` so it is not read over a shoulder; `new-password` so no password manager
              // keeps a copy of a credential this browser only relays.
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              className="kt-input min-h-[44px] w-full min-w-0 flex-1 rounded-control border border-border bg-surface-2 px-2 text-fg"
              value={value}
              placeholder="paste it here — it is never shown again"
              onChange={event => setValue(event.target.value)}
            />
            <button
              type="submit"
              className="kt-btn min-h-[44px] justify-center"
              data-variant="primary"
              disabled={!ready}
            >
              <KeyRound size={14} aria-hidden="true" /> {busy === 'saving' ? 'Saving…' : 'Save'}
            </button>
            {status.set && (
              <button
                type="button"
                className="kt-btn min-h-[44px] justify-center"
                onClick={() => {
                  setValue('');
                  setReplacing(false);
                }}
              >
                Cancel
              </button>
            )}
          </div>
          {problem !== undefined && <p className="m-0 text-meta text-err">{problem}</p>}
        </form>
      ) : (
        <div>
          <button
            type="button"
            className="kt-btn min-h-[44px]"
            disabled={!idle}
            onClick={() => setReplacing(true)}
            aria-label={`Replace the ${status.label} key`}
          >
            <KeyRound size={14} aria-hidden="true" /> Replace key
          </button>
        </div>
      )}

      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="kt-btn min-h-[44px]"
            disabled={!status.set || !idle}
            onClick={() => void onTest()}
            aria-label={`Test the ${status.label} key`}
          >
            <FlaskConical size={14} aria-hidden="true" /> {busy === 'testing' ? 'Testing…' : 'Test'}
          </button>
          <span className="text-meta leading-base text-faint">{status.testNote}</span>
        </div>
        {line !== undefined && (
          <p
            className={cn(
              'm-0 text-meta leading-base',
              status.lastTest?.ok === true && !status.testStale ? 'text-ok' : 'text-warn',
            )}
            role="status"
            data-speedup-last-test=""
          >
            {line}
          </p>
        )}
      </div>

      {error !== null && (
        <p role="alert" className="m-0 text-ui text-err">
          {error}
        </p>
      )}
    </section>
  );
}

export interface SpeedupsPanelProps {
  readonly view: SpeedupsView;
  readonly busy: { readonly provider: string; readonly kind: 'saving' | 'testing' } | null;
  readonly errors: Readonly<Record<string, string>>;
  readonly onSave: (status: SpeedupStatus, value: string) => void | Promise<void>;
  readonly onTest: (status: SpeedupStatus) => void | Promise<void>;
}

export function SpeedupsPanel({ view, busy, errors, onSave, onTest }: SpeedupsPanelProps) {
  const vaultReadable = view.vault === 'ok';
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="speedups-panel">
      <section className="kt-panel flex flex-col gap-2 p-panel" aria-labelledby="speedups-heading">
        <h2 id="speedups-heading" className="m-0 flex items-center gap-1.5 text-row font-semibold text-fg">
          <Zap size={16} className="text-accent" aria-hidden="true" />
          Speed-ups
        </h2>
        <p className="m-0 text-cell leading-base text-muted">{SPEEDUPS_INTRO}</p>
        <p className="m-0 text-meta leading-base text-faint">{SPEEDUPS_FALLBACK}</p>
        {!vaultReadable && (
          <div role="alert" className="flex gap-2 rounded-control border border-warn bg-warn/10 p-3">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
            <p className="m-0 text-cell leading-base text-muted">
              This machine cannot read its secret store, so it cannot tell which keys are set. Fix the store in Secrets
              before pasting a key again, or you may write over one that is still there.
            </p>
          </div>
        )}
      </section>
      {view.providers.map(status => (
        <SpeedupCard
          key={status.provider}
          status={status}
          vaultReadable={vaultReadable}
          busy={busy?.provider === status.provider ? busy.kind : null}
          locked={busy !== null && busy.provider !== status.provider}
          error={errors[status.provider] ?? null}
          onSave={value => onSave(status, value)}
          onTest={() => onTest(status)}
        />
      ))}
    </div>
  );
}

interface Loaded {
  readonly daemonId: DaemonConnection['daemonId'];
  readonly view: SpeedupsView;
}

const reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** Merge one Test's answer into the view, so the card shows it without a second read. */
export function withTestResult(view: SpeedupsView, result: SpeedupTestResult): SpeedupsView {
  return {
    ...view,
    providers: view.providers.map(status =>
      status.provider === result.provider ? { ...status, lastTest: result, testStale: false } : status,
    ),
  };
}

export function SpeedupsSurface({
  connection,
  createClient: injectedClient,
}: {
  readonly connection: DaemonConnection;
  readonly createClient?: SpeedupClientFactory | undefined;
}) {
  // The carrier-routed client unless a caller hands one in, so a relay-only daemon is still reached.
  const routedClient = useDaemonClient();
  const createClient = injectedClient ?? routedClient;
  const [client, setClient] = useState<SpeedupClient | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<{ readonly daemonId: string; readonly reason: string } | null>(null);
  const [busy, setBusy] = useState<SpeedupsPanelProps['busy']>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    let current = true;
    setClient(null);
    setLoaded(null);
    setFailure(null);
    setErrors({});
    void createClient(connection)
      .then(async next => {
        const view = await readSpeedups(next);
        if (!current) return;
        setClient(next);
        setLoaded({ daemonId: connection.daemonId, view });
      })
      .catch(cause => {
        if (current) setFailure({ daemonId: connection.daemonId, reason: reason(cause) });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  // A key saved, removed or tested from anywhere else, or a tool installed, is read again in place.
  useConfigChangeEffect(connection.daemonId, ['speedups'], () => {
    if (client === null) return;
    void readSpeedups(client)
      .then(view => setLoaded(current => (current?.daemonId === connection.daemonId ? { ...current, view } : current)))
      .catch(() => undefined);
  });

  const act = useCallback(
    async (
      status: SpeedupStatus,
      kind: 'saving' | 'testing',
      work: (active: SpeedupClient) => Promise<SpeedupsView>,
    ) => {
      if (client === null) return;
      setBusy({ provider: status.provider, kind });
      setErrors(({ [status.provider]: _cleared, ...rest }) => rest);
      try {
        const view = await work(client);
        setLoaded({ daemonId: connection.daemonId, view });
      } catch (cause) {
        setErrors(previous => ({ ...previous, [status.provider]: reason(cause) }));
      } finally {
        setBusy(null);
      }
    },
    [client, connection.daemonId],
  );

  const save = useCallback(
    async (status: SpeedupStatus, value: string) =>
      await act(status, 'saving', async active => {
        await putSecret(active, status.secretName, value);
        return await readSpeedups(active);
      }),
    [act],
  );

  const test = useCallback(
    async (status: SpeedupStatus) =>
      await act(status, 'testing', async active => {
        const result = await testSpeedup(active, status.provider);
        // The loaded view is the base: a Test changes only this card's last result.
        return withTestResult(loaded?.view ?? { providers: [], vault: 'ok' }, result);
      }),
    [act, loaded],
  );

  if (failure !== null && failure.daemonId === connection.daemonId)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Speed-ups unavailable">
        <h3 className="m-0 text-row font-semibold text-fg">Speed-ups unavailable</h3>
        <p className="mb-0 mt-1 text-cell leading-base text-muted">
          This browser could not read which keys this machine holds: {failure.reason}. That is not the same as none
          being set.
        </p>
      </section>
    );

  if (loaded === null || loaded.daemonId !== connection.daemonId)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Loading speed-ups">
        <p className="m-0 text-ui text-faint">Reading this machine’s speed-up keys…</p>
      </section>
    );

  return <SpeedupsPanel view={loaded.view} busy={busy} errors={errors} onSave={save} onTest={test} />;
}

/** The Settings › This machine row, supplied through the frame's `additionalTabs` seam. */
export const speedupsSettingsTab = (createClient?: SpeedupClientFactory) =>
  ({
    id: 'speedups',
    label: 'Speed-ups',
    description: 'Optional Jev, Groq and Cerebras keys: faster Warden triage and dictation clean-up.',
    Surface: ({ connection }: { readonly connection: DaemonConnection }) => (
      <SpeedupsSurface connection={connection} createClient={createClient} />
    ),
  }) as const;
