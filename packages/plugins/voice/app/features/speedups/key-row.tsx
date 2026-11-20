/**
 * THE KEY ROW: one Speed-ups provider's key field, Save and Test, drawn on its own so a page that is not Settings can
 * hold it (the Warden's first-run page mounts the Jev one through the `speedup-key` panel).
 *
 * WRITE-ONLY, LIKE EVERY SECRET. A pasted key goes to `POST /v1/secrets` under the name the daemon names, and the field
 * clears. Nothing here can show a key again: the daemon answers "set ✓" and an instant, never a value. The page that
 * mounts the row never holds the value: the key lives only in the field's own value (`useSecretField`) until Save.
 *
 * `SpeedupKeyForm` is the form itself (Settings wraps it in a `SettingRow`; `compact` is the short version a page draws
 * inline). `SpeedupKeyRow` is the connected one-provider row behind the panel.
 */

import {
  daemonConnection,
  type DaemonConnection,
  MIN_SECRET_VALUE_LENGTH,
  putSecret,
  SecretInput,
  useSecretField,
  VoiceClientProvider,
} from '../../shell-voice.ts';
import type { SpeedupStatus, SpeedupsView, SpeedupTestResult } from '../../../contract/index.ts';
import { Check, ExternalLink, FlaskConical, KeyRound } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { useDaemonClient } from '../../lib/voice-store.tsx';
import { viewerTime } from '@ferretry/app';
import { ConfirmToSee, isStepUpRefusal } from '@ferretry/app/ui';
import { readSpeedups, type SpeedupClient, testSpeedup } from './speedups-api.ts';
import '../settings/voice-settings.css';

export type SpeedupClientFactory = (connection: DaemonConnection) => Promise<SpeedupClient>;

/** One line about the last Test, or nothing when there was none. */
export function lastTestLine(status: SpeedupStatus): string | undefined {
  const last = status.lastTest;
  if (last === undefined) return undefined;
  const timing = last.latencyMs === undefined ? '' : ` · ${Math.round(last.latencyMs)} ms`;
  const verdict = last.ok ? 'Worked' : 'Failed';
  const stale = status.testStale ? ' The key has changed since — test again.' : '';
  return `${verdict} ${viewerTime(last.at)}${timing}. ${last.message}${stale}`;
}

/** Why a pasted key cannot be saved yet, or nothing. */
export function keyDraftProblem(value: string): string | undefined {
  return value === '' ? undefined : keyLengthProblem(value.trim().length);
}

/** The same from how many characters (spaces around it not counted) are typed: the field's value is never held in state. */
function keyLengthProblem(length: number): string | undefined {
  if (length === 0 || length >= MIN_SECRET_VALUE_LENGTH) return undefined;
  return `At least ${MIN_SECRET_VALUE_LENGTH} characters. That looks too short to be a whole key.`;
}

/** Merge one Test's answer into the view, so the card shows it without a second read. */
export function withTestResult(view: SpeedupsView, result: SpeedupTestResult): SpeedupsView {
  return {
    ...view,
    providers: view.providers.map(status =>
      status.provider === result.provider ? { ...status, lastTest: result, testStale: false } : status,
    ),
  };
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

export function StatusChip({
  status,
  vaultReadable,
}: {
  readonly status: SpeedupStatus;
  readonly vaultReadable: boolean;
}) {
  if (!vaultReadable)
    return <span className="rounded-control bg-warn-bg px-2 py-0.5 text-meta font-medium text-warn">Can’t tell</span>;
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

export function SpeedupKeyForm({
  status,
  busy,
  locked = false,
  error,
  onSave,
  onTest,
  compact = false,
}: SpeedupCardProps & {
  /** The short version a page draws inline: no purpose line, and "Get a key" is a link beside the field. */
  readonly compact?: boolean;
}) {
  const fieldId = useId();
  // The key lives only in the field's own value (read on Save); state knows how long it is, never what it says.
  const key = useSecretField(typed => typed.trim().length);
  const [replacing, setReplacing] = useState(false);
  const problem = keyLengthProblem(key.length);
  const idle = busy === null && !locked;
  const ready = key.length >= MIN_SECRET_VALUE_LENGTH && idle;
  const showField = !status.set || replacing;
  const line = lastTestLine(status);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    void Promise.resolve(onSave(key.read().trim())).then(() => {
      key.clear();
      setReplacing(false);
    });
  };

  return (
    <form
      className="fy-vs-body"
      onSubmit={submit}
      aria-label={`Save the ${status.label} key`}
      {...(compact ? { 'data-speedup-key-form': status.provider } : {})}
    >
      {compact ? null : <p className="fy-vs-note text-fg">{status.purpose}</p>}
      {/* ONE row (shot 09): the key (36rem at most), Save and Test, all one height, on one line; it wraps under the key
          when the panel is narrower than the whole row. */}
      <div className="fy-vs-field">
        {showField ? (
          <>
            <SecretInput
              id={fieldId}
              field={key}
              aria-label={`${status.label} key (${status.secretName})`}
              className="kt-input fy-vs-input min-h-[44px] rounded-control border border-border bg-surface-2 px-2 text-fg"
              placeholder="paste it here — it is never shown again"
            />
            <button type="submit" className="kt-btn" data-variant="primary" disabled={!ready}>
              <KeyRound size={14} aria-hidden="true" /> {busy === 'saving' ? 'Saving…' : 'Save'}
            </button>
            {status.set && (
              <button
                type="button"
                className="kt-btn"
                onClick={() => {
                  key.clear();
                  setReplacing(false);
                }}
              >
                Cancel
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            className="kt-btn"
            disabled={!idle}
            onClick={() => setReplacing(true)}
            aria-label={`Replace the ${status.label} key`}
          >
            <KeyRound size={14} aria-hidden="true" /> Replace key
          </button>
        )}
        <button
          type="button"
          className="kt-btn"
          disabled={!status.set || !idle}
          onClick={() => void onTest()}
          aria-label={`Test the ${status.label} key`}
        >
          <FlaskConical size={14} aria-hidden="true" /> {busy === 'testing' ? 'Testing…' : 'Test'}
        </button>
      </div>
      {problem !== undefined && (
        <p className="fy-vs-note" data-tone="warn">
          {problem}
        </p>
      )}
      {compact ? (
        <p className="fy-vs-note">
          <a href={status.keyUrl} target="_blank" rel="noreferrer noopener" className="text-accent underline">
            Get a key
            <ExternalLink size={12} aria-hidden="true" className="ml-1 inline align-baseline" />
          </a>
        </p>
      ) : (
        <p className="fy-vs-note">
          Get a key:{' '}
          <a href={status.keyUrl} target="_blank" rel="noreferrer noopener" className="break-all text-accent underline">
            {status.keyUrl}
            <ExternalLink size={12} aria-hidden="true" className="ml-1 inline align-baseline" />
          </a>
          . {status.testNote} Saved as <code>{status.secretName}</code>.
        </p>
      )}
      {line !== undefined && (
        <p
          className="fy-vs-note"
          data-tone={status.lastTest?.ok === true && !status.testStale ? 'ok' : 'warn'}
          role="status"
          data-speedup-last-test=""
        >
          {line}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="fy-vs-note" data-tone="warn">
          {error}
        </p>
      )}
    </form>
  );
}

const reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

interface Loaded {
  readonly client: SpeedupClient;
  readonly view: SpeedupsView;
}

/**
 * One provider's key row, connected: reads the machine's Speed-ups view quietly, saves through the secret route and
 * Tests (one provider call, an act of the person's own). A read that failed says so; it never reads as "not set".
 */
export function SpeedupKeyRow({
  connection,
  provider,
  createClient: injected,
}: {
  readonly connection: DaemonConnection;
  readonly provider: string;
  readonly createClient?: SpeedupClientFactory | undefined;
}) {
  const routed = useDaemonClient();
  const createClient = injected ?? routed;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<{ readonly reason: string; readonly stepUp: boolean } | null>(null);
  const [reads, setReads] = useState(0);
  const [busy, setBusy] = useState<'saving' | 'testing' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoaded(null);
    setFailure(null);
    void createClient(connection)
      .then(async client => {
        const view = await readSpeedups(client, reads > 0 ? 'pressed' : 'quiet');
        if (current) setLoaded({ client, view });
      })
      .catch(cause => {
        if (current) setFailure({ reason: reason(cause), stepUp: isStepUpRefusal(cause) });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient, reads]);

  const act = useCallback(
    async (kind: 'saving' | 'testing', work: (active: Loaded) => Promise<SpeedupsView>) => {
      if (loaded === null) return;
      setBusy(kind);
      setError(null);
      try {
        const view = await work(loaded);
        setLoaded({ client: loaded.client, view });
      } catch (cause) {
        setError(reason(cause));
      } finally {
        setBusy(null);
      }
    },
    [loaded],
  );

  const status = loaded?.view.providers.find(candidate => candidate.provider === provider);
  if (failure?.stepUp === true)
    return (
      <div className="fy-vs" data-speedup-key-row={provider}>
        <ConfirmToSee
          line="This machine wants your passkey before it shows which keys it holds."
          onConfirm={() => setReads(n => n + 1)}
        />
      </div>
    );
  if (failure !== null)
    return (
      <p role="status" className="fy-vs-note" data-tone="warn" data-speedup-key-row={provider}>
        Could not read this machine’s keys: {failure.reason}. That is not the same as none being set.
      </p>
    );
  // Room is held while the read is out, so the page does not jump when the row arrives.
  if (loaded === null) return <div className="fy-vs" data-speedup-key-row={provider} style={{ minHeight: 120 }} />;
  if (status === undefined) return null;
  return (
    <div className="fy-vs" data-speedup-key-row={provider}>
      <div className="fy-vs-body">
        <p className="fy-vs-note text-fg">
          {status.label} key <StatusChip status={status} vaultReadable={loaded.view.vault === 'ok'} />
        </p>
      </div>
      <SpeedupKeyForm
        compact
        status={status}
        vaultReadable={loaded.view.vault === 'ok'}
        busy={busy}
        error={error}
        onSave={value =>
          act('saving', async active => {
            await putSecret(active.client, status.secretName, value);
            return await readSpeedups(active.client);
          })
        }
        onTest={() =>
          act('testing', async active => withTestResult(active.view, await testSpeedup(active.client, status.provider)))
        }
      />
    </div>
  );
}

/** What a page that is not Settings addresses this machine by: the shell's per-daemon client already is one daemon. */
const THIS_DAEMON = daemonConnection({
  daemonId: 'this-daemon',
  baseUrl: 'https://this-daemon.invalid',
  deviceId: 'this-device',
});

/** The `speedup-key` panel (subject: the provider, e.g. `jev`): Voice's own key row, mounted by a page that needs one key. */
export const speedupKeyPanel =
  (client: PluginClient) =>
  ({ subject }: PanelProps) =>
    subject === undefined ? null : (
      <VoiceClientProvider client={client}>
        <SpeedupKeyRow connection={THIS_DAEMON} provider={subject} />
      </VoiceClientProvider>
    );
