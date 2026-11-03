/**
 * SETTINGS › LEARNING, on one machine: whether NEW ferrets are instructed to learn, and each current
 * ferret's own switch.
 *
 * The machine default is `learning.yaml`'s `passiveDefault`, written by the daemon (comments kept). It
 * only decides what a new ferret's fixed instructions say; a running ferret is switched on its own,
 * which re-instructs it.
 */

import type { LearningConfig, SessionView } from '@ferretry/protocol';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { fetchLearningConfig, learningErrorMessage, patchLearningConfig } from '../../lib/learning-api.ts';
import type { DaemonFetch } from '../../lib/runtime-models.ts';
import { useConfigChangeCounter, useDaemonFetch } from '../../lib/store.tsx';
import { Badge, Button } from '../../shell/primitives.tsx';
import { SettingGroup, SettingRow } from '../settings/setting-row.tsx';
import { basename, sessionName } from './learning-model.ts';
import { usePassiveLearning } from './passive-learning.tsx';

export interface LearningSettingsSurfaceProps {
  readonly connection: DaemonConnection;
  /** This machine's ferrets, to name the rows; ids are shown when absent. */
  readonly sessions?: readonly SessionView[] | null;
  /** Test and harness seam; production reads through the carrier router. */
  readonly fetcher?: DaemonFetch;
}

export function LearningSettingsSurface({ connection, sessions = null, fetcher }: LearningSettingsSurfaceProps) {
  const ambient = useDaemonFetch();
  const daemonFetch = fetcher ?? ambient;
  const [config, setConfig] = useState<LearningConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const learning = usePassiveLearning(connection, daemonFetch);
  const byId = useMemo(() => new Map((sessions ?? []).map(view => [view.config.id, view])), [sessions]);

  // `learning.yaml` changed anywhere — another device, `fy`, a hand edit — and the default is read again.
  const moved = useConfigChangeCounter(connection.daemonId, ['learning']);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `moved` is the re-read trigger
  useEffect(() => {
    let current = true;
    fetchLearningConfig(connection, daemonFetch).then(
      next => {
        if (current) setConfig(next);
      },
      (reason: unknown) => {
        if (current) setError(learningErrorMessage(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [connection, daemonFetch, moved]);

  const toggleDefault = async (passiveDefault: boolean) => {
    setSaving(true);
    setError(null);
    try {
      setConfig(await patchLearningConfig(connection, { passiveDefault }, daemonFetch));
    } catch (reason) {
      setError(learningErrorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const toggleFerret = async (sessionId: string, passive: boolean) => {
    setSwitching(sessionId);
    setNote(null);
    try {
      setNote((await learning.set(sessionId, passive)).note);
    } catch (reason) {
      setNote(learningErrorMessage(reason));
    } finally {
      setSwitching(null);
    }
  };

  const on = config?.passiveDefault === true;
  const rows = learning.sessions ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-3" data-learning-settings="">
      <SettingGroup label="Passive learning for new ferrets">
        <SettingRow
          name="Passive learning for new ferrets"
          hint="Change a running ferret from its Actions › Passive learning, which re-instructs it."
          explanation={
            <>
              Only controls whether new ferrets are INSTRUCTED to learn: their fixed instructions include{' '}
              <span className="mono">fy lesson suggest "…" --scope global|repo</span>. The ferret picks Global or Repo;
              you can change it in the Learning hub.
            </>
          }
          control={labelId => (
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-labelledby={labelId}
              disabled={config === null || saving}
              onClick={() => void toggleDefault(!on)}
              className={cn(
                'flex min-h-[44px] shrink-0 items-center gap-2 rounded-control border px-3 text-ui font-semibold disabled:opacity-60',
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
              {config === null ? '…' : on ? 'On' : 'Off'}
            </button>
          )}
        >
          {error !== null && (
            <p role="alert" className="m-0 px-panel pb-2 text-meta text-err">
              {error}
            </p>
          )}
        </SettingRow>
      </SettingGroup>
      {note !== null && (
        <p role="status" className="m-0 rounded-control bg-surface-2 px-3 py-2 text-meta text-fg-soft">
          {note}
        </p>
      )}
      <SettingGroup label="Ferrets right now">
        {learning.sessions === null ? (
          <li className="min-h-[var(--row-min-h)] px-panel py-2 text-meta text-muted">Reading which ferrets learn…</li>
        ) : rows.length === 0 ? (
          <li className="min-h-[var(--row-min-h)] px-panel py-2 text-meta text-muted">
            No ferrets on this machine yet.
          </li>
        ) : (
          rows.map(entry => {
            const cwd = byId.get(entry.sessionId)?.config.cwd;
            return (
              <SettingRow
                key={entry.sessionId}
                name={sessionName(entry.sessionId, byId)}
                hint={cwd === undefined ? undefined : basename(cwd)}
                dataAttributes={{ 'data-learning-ferret': entry.sessionId }}
                control={() => (
                  <>
                    <Badge tone={entry.passive ? 'ok' : 'pend'}>{entry.passive ? 'On' : 'Off'}</Badge>
                    <Button
                      size="sm"
                      className="min-h-[44px]"
                      disabled={switching !== null}
                      onClick={() => void toggleFerret(entry.sessionId, !entry.passive)}
                    >
                      {entry.passive ? 'Turn off' : 'Turn on'}
                    </Button>
                  </>
                )}
              />
            );
          })
        )}
      </SettingGroup>
    </div>
  );
}

/** The Machine tab's Learning panel, as `DaemonSettingsFrame` takes one. */
export const LEARNING_SETTINGS_TAB = {
  id: 'learning',
  label: 'Learning',
  description: 'Whether new ferrets are instructed to file lessons, and each ferret’s own switch.',
} as const;
