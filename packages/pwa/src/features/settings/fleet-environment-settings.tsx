/**
 * Portable profile environment settings.
 *
 * This deliberately edits only the fleet profile `env` blocks. They are the
 * existing configuration that generated daemon wrappers actually consume.
 * Credentials and machine-bound values are refused by the daemon; the UI
 * repeats that boundary before an operator attempts a transfer.
 */
import { ArrowRightLeft, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';

interface EnvironmentView {
  readonly profiles: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

type CopyMode = 'merge' | 'replace';

interface EnvironmentChange {
  readonly key: string;
  readonly kind: 'added' | 'changed' | 'removed';
  readonly before?: string;
  readonly after?: string;
}

async function environmentAt(connection: DaemonConnection): Promise<EnvironmentView> {
  const response = await fetch(new URL('/v1/fleet/environment', connection.baseUrl), {
    headers: { Authorization: `Bearer ${connection.deviceToken}`, 'x-ferretry-client': 'ui' },
    credentials: 'include',
  });
  if (!response.ok)
    throw new Error((await response.json().catch(() => ({}))).error ?? `Read failed (${response.status})`);
  return (await response.json()) as EnvironmentView;
}

function changes(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): EnvironmentChange[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key => {
    if (!(key in before)) return [{ key, kind: 'added' as const, after: after[key] }];
    if (!(key in after)) return [{ key, kind: 'removed' as const, before: before[key] }];
    return before[key] === after[key]
      ? []
      : [{ key, kind: 'changed' as const, before: before[key], after: after[key] }];
  });
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
  const [mode, setMode] = useState<CopyMode>('merge');
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
      const firstProfile = profile || Object.keys(nextTarget.profiles)[0] || '';
      setProfile(firstProfile);
    } catch (error) {
      setIssue(error instanceof Error ? error.message : 'Configuration could not be read. No copy can be prepared.');
      setTarget(undefined);
      setSource(undefined);
    } finally {
      setLoading(false);
    }
  }, [connection, connections, profile, sourceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const sourceEnvironment = source?.profiles[profile] ?? {};
  const targetEnvironment = target?.profiles[profile] ?? {};
  const proposed = mode === 'merge' ? { ...targetEnvironment, ...sourceEnvironment } : sourceEnvironment;
  const diff = useMemo(() => changes(targetEnvironment, proposed), [targetEnvironment, proposed]);

  const apply = async () => {
    setLoading(true);
    setIssue(undefined);
    try {
      const response = await fetch(new URL('/v1/fleet/environment', connection.baseUrl), {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${connection.deviceToken}`,
          'Content-Type': 'application/json',
          'x-ferretry-client': 'ui',
        },
        credentials: 'include',
        body: JSON.stringify({ profile, mode, environment: sourceEnvironment }),
      });
      if (!response.ok)
        throw new Error((await response.json().catch(() => ({}))).error ?? `Copy refused (${response.status})`);
      await reload();
    } catch (error) {
      setIssue(error instanceof Error ? error.message : 'Copy was refused; target configuration was left unchanged.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="kt-panel flex min-w-0 flex-col gap-3 p-panel" aria-labelledby="fleet-environment-heading">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="fleet-environment-heading" className="m-0 text-title font-semibold text-fg">
          Portable environment
        </h2>
        <button type="button" className="kt-btn kt-btn--sm ml-auto" onClick={() => void reload()} disabled={loading}>
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </button>
      </div>
      <p className="m-0 text-ui leading-base text-muted">
        Copy one profile’s safe environment entries. Merge overwrites matching target keys and keeps target-only keys;
        replace removes target-only keys. Credentials, paths, ports, and addresses are never copied.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-ui text-muted">
          Source daemon
          <select
            className="kt-input mt-1 min-h-[44px] w-full"
            value={sourceId}
            onChange={event => setSourceId(event.target.value)}
          >
            {connections.map(candidate => (
              <option key={String(candidate.daemonId)} value={String(candidate.daemonId)}>
                {candidate.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-ui text-muted">
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
      <div className="flex flex-wrap gap-2" aria-label="Copy semantics">
        {(['merge', 'replace'] as const).map(candidate => (
          <button
            key={candidate}
            type="button"
            aria-pressed={mode === candidate}
            onClick={() => setMode(candidate)}
            className="kt-btn kt-btn--sm"
          >
            {candidate === 'merge' ? 'Merge safely' : 'Replace target'}
          </button>
        ))}
      </div>
      {issue ? (
        <p role="alert" className="m-0 rounded-control bg-warn/15 p-2 text-ui text-warn">
          {issue}
        </p>
      ) : null}
      {target && source ? (
        <div className="rounded-control border border-border-soft bg-surface-2 p-3" aria-label="Configuration diff">
          <p className="m-0 text-ui font-semibold text-fg">Target diff ({diff.length} changes)</p>
          {diff.length === 0 ? (
            <p className="mb-0 mt-1 text-ui text-muted">No configuration change to apply.</p>
          ) : (
            <ul className="mb-0 mt-2 list-none space-y-1 p-0 mono text-meta text-muted">
              {diff.map(change => (
                <li key={change.key}>
                  <span className="text-accent">{change.kind}</span> {change.key}: {change.before ?? '—'} →{' '}
                  {change.after ?? '—'}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      <button
        type="button"
        className="kt-btn kt-btn--primary self-start"
        disabled={loading || !profile || diff.length === 0}
        onClick={() => void apply()}
      >
        <ArrowRightLeft size={16} aria-hidden="true" /> Apply {mode} after review
      </button>
    </section>
  );
}
