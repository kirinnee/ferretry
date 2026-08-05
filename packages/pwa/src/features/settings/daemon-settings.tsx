/**
 * Daemon management inside Settings.
 *
 * Pairing remains owned by the existing ConnectionPicker route. This surface
 * only presents the durable registry and delegates every mutation back to the
 * composition root, where cache invalidation and daemon-qualified navigation
 * already live.
 */

import type { ConnectionChoice } from '@ferretry/relay';
import { Check, ChevronDown, LoaderCircle, Plus, RefreshCw, Trash2, Wifi, WifiOff } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';

import { cn } from '../../lib/class-names.ts';
import type { DaemonConnectionRecord } from '../../lib/connections.ts';
import type { DaemonConnection, DaemonId } from '../../lib/daemon-connection.ts';
import { sameDaemonConnection } from '../../lib/daemon-connection.ts';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';

const DAEMON_REACHABILITY_INTERVAL_MS = 30_000;

export type DaemonReachabilityProbe = (connection: DaemonConnection) => Promise<unknown>;

export interface DaemonSettingsProps {
  readonly activeDaemonId: DaemonId;
  readonly connections: readonly DaemonConnectionRecord[];
  readonly probeDaemon: DaemonReachabilityProbe;
  /** A live carrier refusal can only make a prior health result worse, never better. */
  readonly activeCarrier?: ConnectionChoice | undefined;
  readonly onSelectDaemon: (daemonId: DaemonId) => void;
  readonly onRenameDaemon: (daemonId: DaemonId, label?: string) => void;
  readonly onRemoveDaemon: (daemonId: DaemonId) => void;
  readonly onAddDaemon: () => void;
}

/** A fingerprint proves identity, but it is not a useful label for choosing a machine. */
export const daemonDisplayName = (connection: DaemonConnectionRecord): string =>
  connection.label?.trim() || connection.baseUrl;

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
  carrier,
}: {
  connection: DaemonConnection;
  name: string;
  probe: DaemonReachabilityProbe;
  carrier?: ConnectionChoice | undefined;
}) {
  const reachability = useDaemonReachability(connection, probe);
  // A carrier refusal comes from an actual request through the same router the
  // typed client uses. It may demote an older successful poll, but missing or
  // successful carrier evidence never turns an uncertain probe green.
  const value: Reachability = carrier?.ok === false ? 'unreachable' : reachability.value;
  const label =
    value === 'reachable'
      ? 'Reachable'
      : value === 'unreachable'
        ? 'Unreachable'
        : 'Checking';
  const Icon =
    value === 'reachable' ? Wifi : value === 'unreachable' ? WifiOff : LoaderCircle;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span
        role="status"
        data-daemon-reachability={reachability.value}
        className={cn(
          'inline-flex min-h-[28px] items-center gap-1.5 rounded-full border px-2 text-meta font-semibold',
          value === 'reachable' && 'border-ok-border bg-ok-bg text-ok',
          value === 'unreachable' && 'border-err-border bg-err-bg text-err',
          value === 'checking' && 'border-warn-border bg-warn-bg text-warn',
        )}
      >
        <Icon
          size={13}
          aria-hidden="true"
          className={value === 'checking' ? 'animate-spin motion-reduce:animate-none' : undefined}
        />
        {label}
        {reachability.refreshing && value !== 'checking' ? (
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

const DAEMON_PICKER_HEIGHT = 'min(72dvh, calc(var(--app-h, 100dvh) - var(--gap-sm)))';

function DaemonSubtabChoices({
  connections,
  activeDaemonId,
  onSelect,
}: {
  readonly connections: readonly DaemonConnectionRecord[];
  readonly activeDaemonId: DaemonId;
  readonly onSelect: (daemonId: DaemonId) => void;
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {connections.map(connection => {
        const name = daemonDisplayName(connection);
        const selected = connection.daemonId === activeDaemonId;
        return (
          <li key={connection.daemonId} data-daemon-id={String(connection.daemonId)}>
            <button
              type="button"
              data-daemon-subtab={String(connection.daemonId)}
              aria-current={selected ? 'page' : undefined}
              onClick={() => onSelect(connection.daemonId)}
              className={cn(
                'flex min-h-[52px] w-full items-center gap-2 rounded-control border px-control-x py-2 text-left transition-colors focus-visible:outline-focus focus-visible:outline-offset-focus',
                selected
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-transparent text-muted hover:border-border hover:bg-surface-2 hover:text-fg',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui font-semibold">{name}</span>
                <span className="mt-0.5 block truncate text-meta leading-tight text-faint">{connection.baseUrl}</span>
              </span>
              {selected ? <Check size={15} className="shrink-0" aria-hidden="true" /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The named daemon selector. On a phone it deliberately becomes a picker, never a cramped tab strip. */
export function DaemonSettings({
  activeDaemonId,
  connections,
  onSelectDaemon,
  onAddDaemon,
}: Omit<DaemonSettingsProps, 'probeDaemon' | 'activeCarrier' | 'onRenameDaemon' | 'onRemoveDaemon'>) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const titleId = useId();
  const active = connections.find(connection => connection.daemonId === activeDaemonId);
  const activeName = active ? daemonDisplayName(active) : 'Selected daemon unavailable';

  return (
    <section className="min-w-0" aria-label="Daemon settings">
      <div className="hidden min-w-0 items-center gap-2 md:flex" data-daemon-subtabs="desktop">
        <div
          role="tablist"
          aria-label="Connected daemons"
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto overflow-y-hidden rounded-panel border border-border bg-surface p-1 shadow-panel"
        >
          {connections.map(connection => {
            const name = daemonDisplayName(connection);
            const selected = connection.daemonId === activeDaemonId;
            return (
              <button
                key={connection.daemonId}
                type="button"
                role="tab"
                data-daemon-subtab={String(connection.daemonId)}
                aria-selected={selected}
                aria-controls={`daemon-subtab-panel-${String(connection.daemonId)}`}
                title={connection.baseUrl}
                onClick={() => onSelectDaemon(connection.daemonId)}
                className={cn(
                  'flex min-h-[44px] min-w-[132px] max-w-[220px] flex-1 items-center rounded-control px-control-x py-2 text-left focus-visible:outline-focus focus-visible:outline-offset-focus',
                  selected ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg',
                )}
              >
                <span className="truncate text-ui font-semibold">{name}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="kt-btn min-h-[44px] shrink-0"
          onClick={onAddDaemon}
          data-add-daemon=""
          aria-label="Add daemon"
        >
          <Plus size={16} aria-hidden="true" />
          Add
        </button>
      </div>

      <div className="md:hidden" data-daemon-subtabs="mobile">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          aria-controls="daemon-subtab-picker"
          data-daemon-subtab-trigger=""
          onClick={() => setPickerOpen(true)}
          className="flex min-h-[52px] w-full items-center gap-2 rounded-control border border-border bg-surface-2 px-control-x py-2 text-left shadow-panel focus-visible:outline-focus focus-visible:outline-offset-focus"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-meta font-semibold uppercase tracking-label text-faint">
              Configuring daemon
            </span>
            <span className="block truncate text-ui font-semibold text-fg">{activeName}</span>
          </span>
          <ChevronDown size={17} className="shrink-0 text-muted" aria-hidden="true" />
        </button>
        <BottomSheet
          id="daemon-subtab-picker"
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          labelledBy={titleId}
          closeLabel="Close daemon picker"
          panelClassName="bg-surface"
          maxHeight={DAEMON_PICKER_HEIGHT}
          zIndexClass="z-50"
        >
          <div className="min-h-0 overflow-y-auto px-panel pb-4">
            <h2 id={titleId} className="m-0 font-display text-title font-semibold tracking-display text-fg">
              Choose a daemon
            </h2>
            <p className="mb-3 mt-1 text-ui leading-base text-muted">
              Every panel below belongs to the daemon you choose here.
            </p>
            <nav aria-label="Connected daemons">
              <DaemonSubtabChoices
                connections={connections}
                activeDaemonId={activeDaemonId}
                onSelect={daemonId => {
                  onSelectDaemon(daemonId);
                  setPickerOpen(false);
                }}
              />
            </nav>
            <button type="button" className="kt-btn mt-3 min-h-[44px] w-full" onClick={onAddDaemon} data-add-daemon="">
              <Plus size={16} aria-hidden="true" />
              Add daemon
            </button>
          </div>
        </BottomSheet>
      </div>
    </section>
  );
}

/** Machine-specific reachability and pairing controls; mounted only inside that machine's sub-tab. */
export function DaemonHostChecks({
  connection,
  probeDaemon,
  carrier,
  onRenameDaemon,
  onRemoveDaemon,
}: {
  readonly connection: DaemonConnectionRecord;
  readonly probeDaemon: DaemonReachabilityProbe;
  readonly carrier?: ConnectionChoice | undefined;
  readonly onRenameDaemon: (daemonId: DaemonId, label?: string) => void;
  readonly onRemoveDaemon: (daemonId: DaemonId) => void;
}) {
  const name = daemonDisplayName(connection);
  return (
    <section
      className="kt-panel p-panel"
      aria-labelledby="settings-host-checks-heading"
      data-daemon-host-checks={String(connection.daemonId)}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="settings-host-checks-heading" className="m-0 text-title font-semibold text-fg">
            Host checks
          </h3>
          <p className="mb-0 mt-1 text-ui leading-base text-muted">
            Reachability and this browser’s pairing record for {name}.
          </p>
        </div>
        <ReachabilityBadge connection={connection} name={name} probe={probeDaemon} carrier={carrier} />
      </div>
      <details className="mt-3 rounded-control border border-border-soft bg-surface-2 px-control-x">
        <summary className="flex min-h-[44px] cursor-pointer items-center text-ui font-semibold text-muted hover:text-fg focus-visible:outline-focus focus-visible:outline-offset-focus">
          Technical identity
        </summary>
        <div className="border-t border-border-soft py-3 text-meta leading-base text-muted">
          <p className="m-0">Address</p>
          <code className="mt-1 block break-all font-mono text-fg">{connection.baseUrl}</code>
          <p className="mb-0 mt-3">Daemon fingerprint</p>
          <code className="mt-1 block break-all font-mono text-fg">{String(connection.daemonId)}</code>
        </div>
      </details>
      <div className="mt-3">
        <DaemonManagement
          connection={connection}
          name={name}
          onRename={label => onRenameDaemon(connection.daemonId, label)}
          onRemove={() => onRemoveDaemon(connection.daemonId)}
        />
      </div>
    </section>
  );
}
