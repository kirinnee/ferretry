/**
 * Daemon-scoped ferret limits: what the machine keeps back for itself, and whether that is working.
 *
 * READ-ONLY, ON PURPOSE. The limits are the machine's `limits.yaml` now, like every other setting, and the
 * daemon holds a change that RAISES a limit for the owner to confirm — so this panel does not carry a
 * second editor that could be a way round that. It shows the daemon's own plain-words lines (the same ones
 * `fy daemon status` prints), the ferrets slowed or stopped for memory, and where to change it.
 *
 * Plain words: no kernel vocabulary reaches this panel. The daemon writes the sentences; this draws them.
 */

import type { IFyApiClient, LimitsView } from '@ferretry/protocol';
import { CircleAlert, Gauge, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useDaemonClient } from '../../lib/store.tsx';

/** The badge: whether limits are doing their job on this machine. */
export const limitsBadge = (view: LimitsView): { readonly text: string; readonly good: boolean } => {
  if (!view.switchedOn) return { text: 'switched off', good: false };
  if (view.enforcement === 'cgroups') return { text: 'enforced', good: true };
  if (view.enforcement === 'priority') return { text: 'priority only', good: true };
  return { text: 'not enforced', good: false };
};

export interface LimitsCardProps {
  readonly view: LimitsView;
}

export function LimitsCard({ view }: LimitsCardProps) {
  const badge = limitsBadge(view);
  return (
    <section
      className="kt-panel flex min-w-0 flex-col gap-3 p-panel"
      data-testid="limits-card"
      aria-labelledby="limits-heading"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="limits-heading" className="m-0 flex items-center gap-1.5 text-row font-semibold text-fg">
          <ShieldCheck size={16} className="text-accent" aria-hidden="true" /> Ferret limits
        </h3>
        <span
          className={
            badge.good
              ? 'rounded-control bg-ok-bg px-2 py-0.5 text-meta font-medium text-ok'
              : 'rounded-control bg-warn-bg px-2 py-0.5 text-meta font-medium text-warn'
          }
        >
          {badge.text}
        </span>
      </div>
      <p className="m-0 text-cell leading-base text-muted">
        Ferrets are kept below what you can really spend, so this machine’s daemon stays quick to answer even when the
        ferrets are busy.
      </p>
      <ul className="m-0 grid list-none gap-1.5 p-0" aria-label="What is in force">
        {view.lines.map(line => (
          <li
            key={line}
            className="flex items-start gap-1.5 rounded-control border border-border bg-surface-2 px-3 py-2 text-ui leading-base text-fg"
          >
            <Gauge size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
            <span className="min-w-0 break-words">{line}</span>
          </li>
        ))}
      </ul>
      {view.warnings.map(warning => (
        <p
          key={warning}
          role="alert"
          className="m-0 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-meta leading-base text-warn"
        >
          <CircleAlert size={14} className="mr-1 inline" aria-hidden="true" />
          {warning}
        </p>
      ))}
      <p className="m-0 text-meta leading-base text-muted">
        To change a limit, edit <code className="font-mono text-fg">{view.file}</code> in Settings › Files. A change
        that tightens a limit applies at once; one that raises a limit, or switches limits off, waits for you to confirm
        it. Ferrets already running keep the limits they started with.
      </p>
    </section>
  );
}

type LimitsClient = Pick<IFyApiClient, 'cgroupConfig'>;
export type LimitsClientFactory = (connection: DaemonConnection) => Promise<LimitsClient>;

export function LimitsSurface({
  connection,
  createClient: injectedClient,
}: {
  readonly connection: DaemonConnection;
  readonly createClient?: LimitsClientFactory;
}) {
  // The carrier-routed client unless a test or the harness hands one in: a plain-network client
  // reaches no daemon at all, because a paired browser is answered only inside its own session.
  const routedClient = useDaemonClient();
  const createClient = injectedClient ?? routedClient;
  const [view, setView] = useState<{
    readonly daemonId: DaemonConnection['daemonId'];
    readonly value: LimitsView;
  } | null>(null);
  const [failure, setFailure] = useState<{
    readonly daemonId: DaemonConnection['daemonId'];
    readonly reason: string;
  } | null>(null);

  useEffect(() => {
    let current = true;
    setView(null);
    setFailure(null);
    void createClient(connection)
      .then(async next => {
        const value = await next.cgroupConfig();
        if (current) setView({ daemonId: connection.daemonId, value });
      })
      .catch(cause => {
        if (current)
          setFailure({ daemonId: connection.daemonId, reason: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  if (view?.daemonId === connection.daemonId) return <LimitsCard view={view.value} />;
  if (failure?.daemonId === connection.daemonId)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Ferret limits unavailable">
        <h3 className="m-0 text-row font-semibold text-fg">Ferret limits unavailable</h3>
        <p className="mb-0 mt-1 text-cell leading-base text-muted">
          This daemon did not say what limits are in force. Ferretry will not assume they are on or off.{' '}
          {failure.reason}
        </p>
      </section>
    );
  return null;
}
