/**
 * SETTINGS › HOST CHECKS: is this daemon reachable right now, and which one is it (today's `DaemonHostChecks`).
 *
 * Reachability is a real read of the daemon's own `GET /v1/health` through the client this tab was handed: only a
 * well-formed answer publishes "Reachable"; a refusal, a timeout or no answer is never optimistic, and a new daemon
 * starts as "Checking", not green. It is read again every 30 seconds and on demand.
 *
 * GAP (declared in docs/rebuild/after-merge.json, `host-checks-pairing`): today's tab also offered to rename this
 * machine and to remove this browser's pairing with it, and showed the address. Those are the SHELL's record of a
 * pairing (the daemon list), which an app half is not handed, so this tab shows the fingerprint the client is bound to
 * and says where the pairing is managed.
 */
import { daemonOfClient } from '@ferretry/app';
import { PanelPath } from '@ferretry/app/ui';
import { LoaderCircle, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { KernelClient } from '../lib/client.ts';

/** How often the daemon is asked again. */
const REACHABILITY_INTERVAL_MS = 30_000;

const HealthSchema = z.looseObject({ protocol: z.number().int(), version: z.string().min(1) });
type Health = z.infer<typeof HealthSchema>;

type Reachability = 'checking' | 'reachable' | 'unreachable';

interface Reading {
  readonly value: Reachability;
  readonly refreshing: boolean;
  readonly health?: Health;
}

/** Only a schema-validated health answer publishes `reachable`; everything else publishes no optimistic evidence. */
function useReachability(client: KernelClient): Reading & { readonly refresh: () => void } {
  const [reading, setReading] = useState<Reading>({ value: 'checking', refreshing: true });
  const refresh = useRef<() => void>(() => undefined);
  useEffect(() => {
    let active = true;
    let attempt = 0;
    const check = (): void => {
      attempt += 1;
      const own = attempt;
      setReading(previous => ({ ...previous, value: 'checking', refreshing: true }));
      client.call('GET /v1/health').then(
        body => {
          if (!active || own !== attempt) return;
          const parsed = HealthSchema.safeParse(body);
          setReading(
            parsed.success
              ? { value: 'reachable', refreshing: false, health: parsed.data }
              : { value: 'unreachable', refreshing: false },
          );
        },
        () => {
          if (active && own === attempt) setReading({ value: 'unreachable', refreshing: false });
        },
      );
    };
    check();
    refresh.current = check;
    const interval = setInterval(check, REACHABILITY_INTERVAL_MS);
    return () => {
      active = false;
      refresh.current = () => undefined;
      clearInterval(interval);
    };
  }, [client]);
  const again = useCallback(() => refresh.current(), []);
  return { ...reading, refresh: again };
}

const LABELS: Readonly<Record<Reachability, string>> = {
  reachable: 'Reachable',
  unreachable: 'Unreachable',
  checking: 'Checking',
};

const TONES: Readonly<Record<Reachability, string>> = {
  reachable: 'border-ok-border bg-ok-bg text-ok',
  unreachable: 'border-err-border bg-err-bg text-err',
  checking: 'border-warn-border bg-warn-bg text-warn',
};

/** The tab, drawn from plain values so every state can be rendered without a daemon. */
export function HostChecksView({
  value,
  refreshing,
  refresh,
  version,
  protocol,
  fingerprint,
}: {
  readonly value: Reachability;
  readonly refreshing: boolean;
  readonly refresh: () => void;
  readonly version?: string;
  readonly protocol?: number;
  readonly fingerprint?: string;
}) {
  const Icon = value === 'reachable' ? Wifi : value === 'unreachable' ? WifiOff : LoaderCircle;
  return (
    <section className="kt-panel p-panel" aria-labelledby="settings-host-checks-heading" data-daemon-host-checks="">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="settings-host-checks-heading" className="m-0 text-row font-semibold text-fg">
            Host checks
          </h3>
          <p className="mb-0 mt-1 text-cell leading-base text-muted">Reachability of this daemon, right now.</p>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            role="status"
            data-daemon-reachability={value}
            className={`inline-flex min-h-[28px] items-center gap-1.5 rounded-full border px-2 text-meta font-semibold ${TONES[value]}`}
          >
            <Icon
              size={13}
              aria-hidden="true"
              className={value === 'checking' ? 'animate-spin motion-reduce:animate-none' : undefined}
            />
            {LABELS[value]}
            {refreshing && value !== 'checking' ? <span className="sr-only">, checking again</span> : null}
          </span>
          <button
            type="button"
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-control text-muted hover:bg-surface-3 hover:text-fg focus-visible:outline-focus focus-visible:outline-offset-focus"
            aria-label="Check reachability again"
            onClick={refresh}
          >
            <RefreshCw
              size={14}
              aria-hidden="true"
              className={refreshing ? 'animate-spin motion-reduce:animate-none' : undefined}
            />
          </button>
        </div>
      </div>
      {/* `border-strong`, not `border-soft`: this box sits on `surface-2`, where the soft hairline is invisible. */}
      <details className="mt-3 rounded-control border border-border-strong bg-surface-2 px-control-x">
        <summary className="flex min-h-control cursor-pointer items-center text-cell font-semibold text-muted hover:text-fg focus-visible:outline-focus focus-visible:outline-offset-focus">
          Technical identity
        </summary>
        {/* An id and a version are single tokens: each scrolls in its own box rather than tearing at a column. */}
        <div className="border-t border-border-strong py-3 text-meta leading-base text-muted">
          <p className="m-0">Daemon version</p>
          <p className="mb-0 mt-1 text-fg" data-daemon-version="">
            {version === undefined ? 'unknown' : version}
            {protocol === undefined ? '' : ` · session protocol ${String(protocol)}`}
          </p>
          <p className="mb-0 mt-3">Daemon fingerprint</p>
          <PanelPath value={fingerprint ?? 'unknown'} className="mt-1 block text-fg" label="Daemon fingerprint" />
        </div>
      </details>
      <p className="mb-0 mt-3 text-meta leading-base text-faint">
        This browser’s pairing with this daemon — its name and removing it — is managed from the daemon list.
      </p>
    </section>
  );
}

export function HostChecks({ client }: { readonly client: KernelClient }) {
  const reading = useReachability(client);
  const fingerprint = daemonOfClient(client);
  return (
    <HostChecksView
      value={reading.value}
      refreshing={reading.refreshing}
      refresh={reading.refresh}
      {...(reading.health === undefined ? {} : { version: reading.health.version, protocol: reading.health.protocol })}
      {...(fingerprint === undefined ? {} : { fingerprint })}
    />
  );
}
