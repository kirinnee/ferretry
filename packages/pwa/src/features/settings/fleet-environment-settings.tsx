/**
 * Read-only fleet profile environment inspection.
 *
 * This panel never writes: it shows what each daemon publishes and how two
 * daemons differ, and points the operator at the Fleet tab — where a change is
 * reviewed before it is applied — to make one.
 *
 * IT CLAIMS NOTHING ABOUT WHO MAY WRITE. It used to say device authority was
 * "intentionally not enough to mutate Fleet configuration", which was a
 * description of the fleet's own private approval flow and is now false: writing
 * is `fleet.configure` as the operator's grants decided it, and on a machine with
 * no operator password a paired device may apply a change. `docs/grants.md` owns
 * that answer and the Fleet panel renders it; a second statement of it here could
 * only ever drift.
 */
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';

interface EnvironmentView {
  readonly profiles: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

type DifferenceKind = 'target-only' | 'source-only' | 'differs';

interface EnvironmentDifference {
  readonly key: string;
  readonly kind: DifferenceKind;
  readonly target?: string;
  readonly source?: string;
}

const DIFFERENCE_LABEL: Readonly<Record<DifferenceKind, string>> = {
  'target-only': 'target only',
  'source-only': 'source only',
  differs: 'differs',
};

async function environmentAt(connection: DaemonConnection): Promise<EnvironmentView> {
  const response = await fetch(new URL('/v1/fleet/environment', connection.baseUrl), {
    headers: { Authorization: `Bearer ${connection.deviceToken}`, 'x-ferretry-client': 'ui' },
    credentials: 'include',
  });
  if (!response.ok)
    throw new Error((await response.json().catch(() => ({}))).error ?? `Read failed (${response.status})`);
  return (await response.json()) as EnvironmentView;
}

function differences(
  target: Readonly<Record<string, string>>,
  source: Readonly<Record<string, string>>,
): EnvironmentDifference[] {
  const result: EnvironmentDifference[] = [];
  for (const key of [...new Set([...Object.keys(target), ...Object.keys(source)])].sort()) {
    const inTarget = key in target;
    const inSource = key in source;
    if (inTarget && !inSource) result.push({ key, kind: 'target-only', target: target[key] });
    else if (inSource && !inTarget) result.push({ key, kind: 'source-only', source: source[key] });
    else if (target[key] !== source[key])
      result.push({ key, kind: 'differs', target: target[key], source: source[key] });
  }
  return result;
}

export interface FleetEnvironmentSettingsProps {
  readonly connection: DaemonConnection;
  readonly connections: readonly DaemonConnection[];
}

export function FleetEnvironmentSettings({ connection, connections }: FleetEnvironmentSettingsProps) {
  const [target, setTarget] = useState<EnvironmentView>();
  const [source, setSource] = useState<EnvironmentView>();
  const [sourceId, setSourceId] = useState(String(connection.daemonId));
  const [profile, setProfile] = useState('');
  const [issue, setIssue] = useState<string>();
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setIssue(undefined);
    try {
      const sourceConnection = connections.find(candidate => String(candidate.daemonId) === sourceId) ?? connection;
      const [nextTarget, nextSource] = await Promise.all([environmentAt(connection), environmentAt(sourceConnection)]);
      setTarget(nextTarget);
      setSource(nextSource);
      setProfile(profile || Object.keys(nextTarget.profiles)[0] || '');
    } catch (error) {
      setIssue(error instanceof Error ? error.message : 'Fleet environment could not be read.');
      setTarget(undefined);
      setSource(undefined);
    } finally {
      setLoading(false);
    }
  }, [connection, connections, profile, sourceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const targetEnvironment = target?.profiles[profile] ?? {};
  const sourceEnvironment = source?.profiles[profile] ?? {};
  const targetEntries = useMemo(
    () => Object.entries(targetEnvironment).sort(([left], [right]) => left.localeCompare(right)),
    [targetEnvironment],
  );
  const diff = useMemo(() => differences(targetEnvironment, sourceEnvironment), [targetEnvironment, sourceEnvironment]);

  return (
    <section className="kt-panel flex min-w-0 flex-col gap-3 p-panel" aria-labelledby="fleet-environment-heading">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="fleet-environment-heading" className="m-0 text-row font-semibold text-fg">
          Environment inspection
        </h2>
        <button type="button" className="kt-btn kt-btn--sm ml-auto" onClick={() => void reload()} disabled={loading}>
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </button>
      </div>
      <p className="m-0 text-cell leading-base text-muted">
        Inspect this daemon’s fleet profile environment and compare it with another daemon’s. Entries are shown exactly
        as each daemon publishes them; nothing here changes the target.
      </p>
      <p className="m-0 rounded-control border border-border-strong bg-surface-2 p-3 text-cell text-muted">
        This view is read-only. A paired device may inspect fleet environment but cannot change it — device authority
        never covers Fleet mutation. To change environment, open the Fleet tab, review the daemon’s proposal, and
        approve it on the host.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-cell font-medium text-fg">
          Compare with daemon
          <select
            className="kt-input mt-1 min-h-[44px] w-full"
            value={sourceId}
            onChange={event => setSourceId(event.target.value)}
          >
            {connections.map(candidate => (
              <option key={String(candidate.daemonId)} value={String(candidate.daemonId)}>
                {String(candidate.daemonId)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-cell font-medium text-fg">
          Profile
          <select
            className="kt-input mt-1 min-h-[44px] w-full"
            value={profile}
            onChange={event => setProfile(event.target.value)}
          >
            {Object.keys(target?.profiles ?? {}).map(name => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
      </div>
      {issue ? (
        <p role="alert" className="m-0 rounded-control bg-warn/15 p-2 text-ui text-warn">
          {issue}
        </p>
      ) : null}
      {target ? (
        <section
          className="rounded-control border border-border-strong bg-surface-2 p-3"
          aria-label="Target environment entries"
        >
          {profile === '' ? (
            <p className="m-0 text-cell text-muted">This daemon publishes no fleet profiles.</p>
          ) : (
            <>
              <p className="m-0 text-ui font-semibold text-fg">
                {profile} on this daemon ({targetEntries.length})
              </p>
              {targetEntries.length === 0 ? (
                <p className="mb-0 mt-1 text-cell text-muted">This profile publishes no environment entries.</p>
              ) : (
                <ul className="mb-0 mt-2 list-none space-y-1 p-0 mono text-meta text-muted">
                  {targetEntries.map(([key, value]) => (
                    <li key={key}>
                      <span className="text-accent">{key}</span> {value}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      ) : null}
      {target ? (
        <section
          className="rounded-control border border-border-strong bg-surface-2 p-3"
          aria-label="Environment comparison"
        >
          <p className="m-0 text-ui font-semibold text-fg">
            Differences vs {sourceId} ({diff.length})
          </p>
          {diff.length === 0 ? (
            <p className="mb-0 mt-1 text-cell text-muted">No differences — the two daemons publish the same entries.</p>
          ) : (
            <ul className="mb-0 mt-2 list-none space-y-1 p-0 mono text-meta text-muted">
              {diff.map(difference => {
                const detail =
                  difference.kind === 'differs'
                    ? `${difference.target ?? '—'} → ${difference.source ?? '—'}`
                    : difference.kind === 'target-only'
                      ? `${difference.target ?? '—'}`
                      : `${difference.source ?? '—'}`;
                return (
                  <li key={difference.key}>
                    <span className="text-accent">{DIFFERENCE_LABEL[difference.kind]}</span> {difference.key}: {detail}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}
    </section>
  );
}
