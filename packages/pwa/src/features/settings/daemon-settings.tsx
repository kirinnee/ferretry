/**
 * Daemon management inside Settings.
 *
 * Pairing remains owned by the existing ConnectionPicker route. This surface
 * only presents the durable registry and delegates every mutation back to the
 * composition root, where cache invalidation and daemon-qualified navigation
 * already live.
 */

import { Check, ChevronDown, LoaderCircle, Plus, RefreshCw, Server, Trash2, Wifi, WifiOff } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';

import { cn } from '../../lib/class-names.ts';
import type { DaemonConnectionRecord } from '../../lib/connections.ts';
import type { DaemonConnection, DaemonId } from '../../lib/daemon-connection.ts';
import { sameDaemonConnection } from '../../lib/daemon-connection.ts';

const DAEMON_REACHABILITY_INTERVAL_MS = 30_000;

export type DaemonReachabilityProbe = (connection: DaemonConnection) => Promise<unknown>;

export interface DaemonSettingsProps {
  readonly activeDaemonId: DaemonId;
  readonly connections: readonly DaemonConnectionRecord[];
  readonly probeDaemon: DaemonReachabilityProbe;
  readonly onSelectDaemon: (daemonId: DaemonId) => void;
  readonly onRenameDaemon: (daemonId: DaemonId, label?: string) => void;
  readonly onRemoveDaemon: (daemonId: DaemonId) => void;
  readonly onAddDaemon: () => void;
}

const daemonDisplayName = (connection: DaemonConnectionRecord): string =>
  connection.label ?? String(connection.daemonId);

type Reachability = 'checking' | 'reachable' | 'unreachable';

interface ReachabilityState {
  readonly connection: DaemonConnection;
  readonly value: Reachability;
  readonly refreshing: boolean;
}

/**
 * A new or rotated live pairing starts unknown and therefore not green. Only a
 * schema-validated health response may publish `reachable`; a rejection,
 * timeout, stale answer, or missing answer publishes no optimistic evidence.
 */
function useDaemonReachability(connection: DaemonConnection, probe: DaemonReachabilityProbe) {
  const currentConnection = useRef(connection);
  currentConnection.current = connection;
  const refresh = useRef<() => void>(() => undefined);
  const [state, setState] = useState<ReachabilityState>({ connection, value: 'checking', refreshing: true });

  useEffect(() => {
    let active = true;
    let attempt = 0;

    const check = async (): Promise<void> => {
      const ownAttempt = ++attempt;
      setState({ connection, value: 'checking', refreshing: true });
      try {
        await probe(connection);
        if (active && attempt === ownAttempt && sameDaemonConnection(currentConnection.current, connection))
          setState({ connection, value: 'reachable', refreshing: false });
      } catch {
        if (active && attempt === ownAttempt && sameDaemonConnection(currentConnection.current, connection))
          setState({ connection, value: 'unreachable', refreshing: false });
      }
    };

    void check();
    refresh.current = () => void check();
    const interval = window.setInterval(() => void check(), DAEMON_REACHABILITY_INTERVAL_MS);
    return () => {
      active = false;
      refresh.current = () => undefined;
      window.clearInterval(interval);
    };
  }, [connection, probe]);

  return sameDaemonConnection(state.connection, connection)
    ? { value: state.value, refreshing: state.refreshing, refresh: () => refresh.current() }
    : { value: 'checking' as const, refreshing: true, refresh: () => refresh.current() };
}

function ReachabilityBadge({
  connection,
  name,
  probe,
}: {
  connection: DaemonConnection;
  name: string;
  probe: DaemonReachabilityProbe;
}) {
  const reachability = useDaemonReachability(connection, probe);
  const label =
    reachability.value === 'reachable'
      ? 'Reachable'
      : reachability.value === 'unreachable'
        ? 'Unreachable'
        : 'Checking';
  const Icon =
    reachability.value === 'reachable' ? Wifi : reachability.value === 'unreachable' ? WifiOff : LoaderCircle;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span
        role="status"
        data-daemon-reachability={reachability.value}
        className={cn(
          'inline-flex min-h-[28px] items-center gap-1.5 rounded-full border px-2 text-meta font-semibold',
          reachability.value === 'reachable' && 'border-ok-border bg-ok-bg text-ok',
          reachability.value === 'unreachable' && 'border-err-border bg-err-bg text-err',
          reachability.value === 'checking' && 'border-warn-border bg-warn-bg text-warn',
        )}
      >
        <Icon
          size={13}
          aria-hidden="true"
          className={reachability.value === 'checking' ? 'animate-spin motion-reduce:animate-none' : undefined}
        />
        {label}
        {reachability.refreshing && reachability.value !== 'checking' ? (
          <span className="sr-only">, checking again</span>
        ) : null}
      </span>
      <button
        type="button"
        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-control text-muted hover:bg-surface-3 hover:text-fg focus-visible:outline-focus focus-visible:outline-offset-focus"
        aria-label={`Check ${name} reachability again`}
        onClick={reachability.refresh}
      >
        <RefreshCw
          size={14}
          aria-hidden="true"
          className={reachability.refreshing ? 'animate-spin motion-reduce:animate-none' : undefined}
        />
      </button>
    </div>
  );
}

const daemonLabelError = (value: string): string | undefined => {
  const normalized = value.trim();
  if (Array.from(normalized).length > 64) return 'Name must be 64 characters or fewer.';
  if (/[\p{Cc}\p{Cf}]/u.test(normalized)) return 'Name cannot contain control or formatting characters.';
  return undefined;
};

function DaemonManagement({
  connection,
  name,
  onRename,
  onRemove,
}: {
  readonly connection: DaemonConnectionRecord;
  readonly name: string;
  readonly onRename: (label?: string) => void;
  readonly onRemove: () => void;
}) {
  const nameId = useId();
  const [draft, setDraft] = useState(connection.label ?? '');

  useEffect(() => {
    setDraft(connection.label ?? '');
  }, [connection]);

  const error = daemonLabelError(draft);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (error !== undefined) return;
    onRename(draft.trim() || undefined);
  };

  return (
    <details className="group rounded-control border border-border-soft bg-surface px-control-x">
      <summary
        aria-label={`Manage ${name}`}
        className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 text-ui font-semibold text-muted marker:content-none hover:text-fg focus-visible:outline-focus focus-visible:outline-offset-focus"
      >
        <span>Manage daemon</span>
        <ChevronDown size={15} className="shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="space-y-3 border-t border-border-soft py-3">
        <form className="space-y-2" onSubmit={submit}>
          <label className="block text-ui font-medium text-fg" htmlFor={nameId}>
            Display name
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id={nameId}
              value={draft}
              maxLength={64}
              onChange={event => setDraft(event.target.value)}
              placeholder={String(connection.daemonId)}
              aria-describedby={`${nameId}-help ${nameId}-error`}
              className="h-control min-w-0 flex-1 rounded-control border border-border bg-surface-2 px-control-x text-ui text-fg"
            />
            <button type="submit" className="kt-btn min-h-[44px]" disabled={error !== undefined}>
              Save name
            </button>
          </div>
          <p id={`${nameId}-help`} className="m-0 text-meta leading-base text-faint">
            Leave blank to show the daemon fingerprint.
          </p>
          {error !== undefined ? (
            <p id={`${nameId}-error`} role="alert" className="m-0 text-meta text-err">
              {error}
            </p>
          ) : null}
        </form>

        <div className="border-t border-border-soft pt-3">
          <p className="mt-0 text-ui leading-base text-muted">
            Removing this pairing only forgets it in this browser. It does not stop Ferretry or uninstall anything on
            that machine at <code className="break-all font-mono text-fg">{connection.baseUrl}</code>.
          </p>
          <button
            type="button"
            className="kt-btn min-h-[44px] border-err-border text-err hover:bg-err-bg"
            aria-label={`Remove ${name} pairing`}
            onClick={onRemove}
            data-remove-daemon={String(connection.daemonId)}
          >
            <Trash2 size={15} aria-hidden="true" />
            Remove pairing
          </button>
        </div>
      </div>
    </details>
  );
}

function DaemonRow({
  connection,
  active,
  probeDaemon,
  onSelect,
  onRename,
  onRemove,
}: {
  readonly connection: DaemonConnectionRecord;
  readonly active: boolean;
  readonly probeDaemon: DaemonReachabilityProbe;
  readonly onSelect: () => void;
  readonly onRename: (label?: string) => void;
  readonly onRemove: () => void;
}) {
  const name = daemonDisplayName(connection);
  return (
    <li
      className={cn('rounded-panel border bg-surface-2 p-3 shadow-panel', active ? 'border-accent' : 'border-border')}
      aria-current={active ? 'true' : undefined}
      data-daemon-id={String(connection.daemonId)}
    >
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-2.5">
          <span
            className={cn(
              'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-control border',
              active ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface text-muted',
            )}
            aria-hidden="true"
          >
            <Server size={18} />
          </span>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2">
              <strong className="break-words text-title text-fg">{name}</strong>
              {active ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-meta font-semibold text-accent">
                  <Check size={12} aria-hidden="true" />
                  Current daemon
                </span>
              ) : null}
            </span>
            <code className="mt-1 block break-all font-mono text-meta text-faint">{connection.baseUrl}</code>
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <ReachabilityBadge connection={connection} name={name} probe={probeDaemon} />
          {!active ? (
            <button type="button" className="kt-btn min-h-[44px]" onClick={onSelect} aria-label={`Use ${name}`}>
              Use this daemon
            </button>
          ) : null}
        </div>
      </div>
      <div className="mt-3">
        <DaemonManagement connection={connection} name={name} onRename={onRename} onRemove={onRemove} />
      </div>
    </li>
  );
}

export function DaemonSettings({
  activeDaemonId,
  connections,
  probeDaemon,
  onSelectDaemon,
  onRenameDaemon,
  onRemoveDaemon,
  onAddDaemon,
}: DaemonSettingsProps) {
  return (
    <section className="kt-panel p-panel" aria-labelledby="settings-daemon-list-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="settings-daemon-list-heading" className="m-0 text-title font-semibold text-fg">
            Connected daemons
          </h3>
          <p className="mb-0 mt-1 text-ui leading-base text-muted">
            Each pairing keeps its own sessions, files, and live state. Reachability is checked directly against that
            daemon.
          </p>
        </div>
        <button type="button" className="kt-btn min-h-[44px] shrink-0" onClick={onAddDaemon} data-add-daemon="">
          <Plus size={16} aria-hidden="true" />
          Add daemon
        </button>
      </div>

      <ul className="mb-0 mt-4 flex list-none flex-col gap-3 p-0" aria-label="Connected daemons">
        {connections.map(connection => (
          <DaemonRow
            key={connection.daemonId}
            connection={connection}
            active={connection.daemonId === activeDaemonId}
            probeDaemon={probeDaemon}
            onSelect={() => onSelectDaemon(connection.daemonId)}
            onRename={nextLabel => onRenameDaemon(connection.daemonId, nextLabel)}
            onRemove={() => onRemoveDaemon(connection.daemonId)}
          />
        ))}
      </ul>
    </section>
  );
}
