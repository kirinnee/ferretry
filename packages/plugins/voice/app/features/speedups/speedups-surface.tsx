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

import { SettingGroup, SettingRow } from '../../shell-voice.ts';
import type { SpeedupStatus, SpeedupsView } from '../../../contract/index.ts';
import { AlertTriangle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { DaemonConnection } from '../../shell-voice.ts';
import { useConfigChangeEffect, useDaemonClient } from '../../lib/voice-store.tsx';
import { putSecret } from '../../shell-voice.ts';
import { ConfirmToSee, isStepUpRefusal, Loading } from '@ferretry/app/ui';
import {
  keyDraftProblem,
  lastTestLine,
  type SpeedupCardProps,
  type SpeedupClientFactory,
  SpeedupKeyForm,
  StatusChip,
  withTestResult,
} from './key-row.tsx';
import { readSpeedups, type SpeedupClient, testSpeedup } from './speedups-api.ts';
import '../settings/voice-settings.css';

// The key row's pieces live in `key-row.tsx` (a page that is not Settings draws the same row); re-exported for callers.
export { keyDraftProblem, lastTestLine, withTestResult };
export type { SpeedupCardProps, SpeedupClientFactory };

export const SPEEDUPS_INTRO =
  'Optional keys that make this machine faster or cheaper. Each one is stored in this machine’s secret store: it is never shown again, never sent to this browser, and only ever sent to its own provider.';

export const SPEEDUPS_FALLBACK =
  'Without them nothing breaks: the Warden investigates every flag with its own model, and dictation uses on-device word correction.';

export function SpeedupCard(props: SpeedupCardProps) {
  const { status, vaultReadable } = props;
  return (
    <SettingRow
      name={status.label}
      hint={<StatusChip status={status} vaultReadable={vaultReadable} />}
      wide
      dataAttributes={{ 'data-speedup': status.provider }}
      explanation={
        <div className="flex min-w-0 flex-col gap-1">
          <p className="m-0">{status.costNote}</p>
          <p className="m-0">{status.privacyNote}</p>
        </div>
      }
    >
      <SpeedupKeyForm {...props} />
    </SettingRow>
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
    <div className="fy-vs" data-testid="speedups-panel">
      <SettingGroup label="Speed-ups">
        <SettingRow
          name="What speed-up keys do"
          hint="Optional: faster or cheaper, never required"
          explanation={
            <div className="flex flex-col gap-2">
              <p className="m-0">{SPEEDUPS_INTRO}</p>
              <p className="m-0">{SPEEDUPS_FALLBACK}</p>
            </div>
          }
        />
        {!vaultReadable && (
          <li className="fy-vs-body">
            <div role="alert" className="flex gap-2 rounded-control border border-warn bg-warn/10 p-3">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
              <p className="m-0 text-cell leading-base text-muted">
                This machine cannot read its secret store, so it cannot tell which keys are set. Fix the store in
                Secrets before pasting a key again, or you may write over one that is still there.
              </p>
            </div>
          </li>
        )}
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
      </SettingGroup>
    </div>
  );
}

interface Loaded {
  readonly daemonId: DaemonConnection['daemonId'];
  readonly view: SpeedupsView;
}

const reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

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
  const [failure, setFailure] = useState<{
    readonly daemonId: string;
    readonly reason: string;
    /** Refused only for want of the passkey step-up (a cancelled prompt): offer to ask again. */
    readonly stepUp: boolean;
  } | null>(null);
  /** How many times the owner pressed "Confirm it's you to see this"; the read after a press is theirs. */
  const [reads, setReads] = useState(0);
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
        // Quiet unless the person pressed "Confirm it's you": a mount read must not open a prompt nobody asked for.
        const view = await readSpeedups(next, reads > 0 ? 'pressed' : 'quiet');
        if (!current) return;
        setClient(next);
        setLoaded({ daemonId: connection.daemonId, view });
      })
      .catch(cause => {
        if (current)
          setFailure({
            daemonId: connection.daemonId,
            reason: reason(cause),
            stepUp: isStepUpRefusal(cause),
          });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient, reads]);

  // A key saved, removed or tested from anywhere else, or a tool installed, is read again in place.
  useConfigChangeEffect(connection.daemonId, ['speedups'], () => {
    if (client === null) return;
    void readSpeedups(client, 'quiet')
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

  if (failure !== null && failure.daemonId === connection.daemonId && failure.stepUp)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Speed-ups need your passkey">
        <div className="mt-2">
          <ConfirmToSee
            line="This machine wants your passkey before it shows which keys it holds."
            onConfirm={() => setReads(n => n + 1)}
          />
        </div>
      </section>
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
    return <Loading kind="page" label="Reading this machine’s speed-up keys…" />;

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
