/**
 * Daemon management inside Settings.
 *
 * Pairing remains owned by the existing ConnectionPicker route. This surface
 * only presents the durable registry and delegates every mutation back to the
 * composition root, where cache invalidation and daemon-qualified navigation
 * already live.
 */

import type { ConnectionChoice } from '@ferretry/relay';
import { ChevronDown, LoaderCircle, RefreshCw, Trash2, Wifi, WifiOff } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';

import { cn } from '../../lib/class-names.ts';
import type { DaemonConnectionRecord } from '../../lib/connections.ts';
import type { DaemonConnection, DaemonId } from '../../lib/daemon-connection.ts';
import { sameDaemonConnection } from '../../lib/daemon-connection.ts';
import { PanelPath } from '../../shell/panel-typography.tsx';

const DAEMON_REACHABILITY_INTERVAL_MS = 30_000;

export type DaemonReachabilityProbe = (connection: DaemonConnection) => Promise<unknown>;

/**
 * What every screen calls a paired machine: the owner's label, else the name the machine gave itself.
 *
 * A fingerprint proves identity, but it is not a useful label for choosing a machine, and neither is an
 * address. This used to fall straight back to `baseUrl`, so with no label typed the app said "Set up
 * http://127.0.0.1:40245" while the daemon had already reported its host name at pairing. The address
 * is now the last resort only for a pairing made before that name was kept, until the machine answers
 * and the name is learned (`DaemonConnectionStore.learnDaemonName`).
 */
export const daemonDisplayName = (connection: DaemonConnection & { readonly label?: string }): string =>
  connection.label?.trim() || connection.daemonName || connection.baseUrl;

/** A pairing as the naming rules below read it: its name, its address, and when this browser made it. */
type NamedPairing = DaemonConnection & { readonly label?: string; readonly pairedAt?: number };

/**
 * Whether a NEWER pairing with the same name at the same address has replaced this one.
 *
 * One address answers for one machine at a time, so two pairings that agree on both are one machine
 * paired twice — almost always because it was reset (`fy daemon reset` gives it a new identity, and the
 * browser keeps the old pairing). The newer is the one that answers; the older has nothing left to talk
 * to. It is only ever labelled and offered for removal — never removed behind the owner's back.
 */
export const replacedPairing = (connection: NamedPairing, paired: readonly NamedPairing[]): boolean =>
  paired.some(
    other =>
      other.daemonId !== connection.daemonId &&
      other.baseUrl === connection.baseUrl &&
      daemonDisplayName(other) === daemonDisplayName(connection) &&
      (other.pairedAt ?? 0) > (connection.pairedAt ?? 0),
  );

/** "3 Oct": the day a pairing was made, which is how a person remembers it. */
const pairedDay = (pairedAt: number): string =>
  new Date(pairedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/**
 * {@link daemonDisplayName}, told apart from every other paired machine that would read the same — in
 * words a person can use, never the machine's fingerprint.
 *
 * Two machines on one host both call themselves by its name, so a prompt naming "kirin-box" could not
 * say WHICH machine wants the passkey. A twin is followed by its address. A pairing a newer one replaced
 * ({@link replacedPairing}) is called the old pairing, and the live one then needs no suffix at all.
 * Two that still share an address are told apart by the day each was paired.
 */
export const distinctDaemonName = (connection: NamedPairing, paired: readonly NamedPairing[]): string => {
  const name = daemonDisplayName(connection);
  if (replacedPairing(connection, paired)) return `${name} (old pairing)`;
  const twins = paired.filter(
    other =>
      other.daemonId !== connection.daemonId && daemonDisplayName(other) === name && !replacedPairing(other, paired),
  );
  if (twins.length === 0) return name;
  const sharedAddress = name === connection.baseUrl || twins.some(other => other.baseUrl === connection.baseUrl);
  if (!sharedAddress) return `${name} (${connection.baseUrl.replace(/^[a-z]+:\/\//u, '')})`;
  return connection.pairedAt === undefined
    ? `${name} (another pairing)`
    : `${name} (paired ${pairedDay(connection.pairedAt)})`;
};

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
  const label = value === 'reachable' ? 'Reachable' : value === 'unreachable' ? 'Unreachable' : 'Checking';
  const Icon = value === 'reachable' ? Wifi : value === 'unreachable' ? WifiOff : LoaderCircle;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span
        role="status"
        data-daemon-reachability={value}
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
        {reachability.refreshing && value !== 'checking' ? <span className="sr-only">, checking again</span> : null}
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
    <details className="group rounded-control border border-border-strong bg-surface px-control-x">
      <summary
        aria-label={`Manage ${name}`}
        className="flex min-h-control cursor-pointer list-none items-center justify-between gap-2 text-cell font-semibold text-muted marker:content-none hover:text-fg focus-visible:outline-focus focus-visible:outline-offset-focus"
      >
        <span>Manage daemon</span>
        <ChevronDown size={15} className="shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="space-y-3 border-t border-border-strong py-3">
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

        <div className="border-t border-border-strong pt-3">
          <p className="mt-0 text-cell leading-base text-muted">
            Removing this pairing only forgets it in this browser. It does not stop Ferretry or uninstall anything on
            that machine at <PanelPath value={connection.baseUrl} className="text-fg" />.
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
          <h3 id="settings-host-checks-heading" className="m-0 text-row font-semibold text-fg">
            Host checks
          </h3>
          <p className="mb-0 mt-1 text-cell leading-base text-muted">
            Reachability and this browser’s pairing record for {name}.
          </p>
        </div>
        <ReachabilityBadge connection={connection} name={name} probe={probeDaemon} carrier={carrier} />
      </div>
      {/* `border-strong`, not `border-soft`: this box sits on `surface-2`, where the soft hairline is
          invisible — a disclosure whose edge cannot be seen reads as loose text, not as a control. */}
      <details className="mt-3 rounded-control border border-border-strong bg-surface-2 px-control-x">
        <summary className="flex min-h-control cursor-pointer items-center text-cell font-semibold text-muted hover:text-fg focus-visible:outline-focus focus-visible:outline-offset-focus">
          Technical identity
        </summary>
        {/* THE TWO VALUES THE OWNER SAW TORN IN HALF. An address and a fingerprint are single tokens, and
            `fy_daemon_LhGT7RTh8w-RuBminOE2wLDWDga0Nj57q…` broken at whatever column the box happened to
            end at cannot be told apart from a corrupted one. Each scrolls in its own box instead. */}
        <div className="border-t border-border-strong py-3 text-meta leading-base text-muted">
          <p className="m-0">Address</p>
          <PanelPath value={connection.baseUrl} className="mt-1 block text-fg" label="Address" />
          <p className="mb-0 mt-3">Daemon fingerprint</p>
          <PanelPath value={String(connection.daemonId)} className="mt-1 block text-fg" label="Daemon fingerprint" />
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
