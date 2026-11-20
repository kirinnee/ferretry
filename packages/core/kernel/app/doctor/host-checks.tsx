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
import { daemonOfClient, SettingGroup, SettingRow } from '@ferretry/app';
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
    <section className="flex min-w-0 flex-col" aria-label="Host checks" data-daemon-host-checks="">
      <div className="mb-6 min-w-0">
        <p className="m-0 text-cell leading-base text-muted">Reachability of this daemon, right now.</p>
      </div>
      <SettingGroup label="Reachability">
        <SettingRow
          name="This daemon"
          hint="Asked again every 30 seconds."
          control={() => (
            <span className="flex min-w-0 items-center gap-1.5">
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
            </span>
          )}
        />
      </SettingGroup>
      <SettingGroup label="Technical identity">
        <SettingRow
          name="Daemon version"
          control={() => (
            <span className="min-w-0 break-words text-ui text-fg" data-daemon-version="">
              {version === undefined ? 'unknown' : version}
              {protocol === undefined ? '' : ` · session protocol ${String(protocol)}`}
            </span>
          )}
        />
        <SettingRow
          name="Daemon fingerprint"
          // An id is one unbreakable token: it scrolls in its own box rather than tearing at a column.
          control={() => (
            <PanelPath
              value={fingerprint ?? 'unknown'}
              className="min-w-0 text-ui text-fg"
              label="Daemon fingerprint"
            />
          )}
        />
      </SettingGroup>
      <p className="m-0 text-meta leading-base text-faint">
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
