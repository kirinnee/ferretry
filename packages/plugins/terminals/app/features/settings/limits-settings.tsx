/**
 * SETTINGS › FERRET LIMITS: what the machine keeps back for itself, and whether that is working.
 *
 * READ-ONLY, ON PURPOSE. The limits are the machine's `limits.yaml` like every other setting, and the daemon holds a change
 * that RAISES a limit for the owner to confirm — so this panel carries no second editor that could be a way round that. It
 * shows the daemon's own plain-words lines (the same ones `fy daemon status` prints, which already say which ferrets are
 * slowed or were stopped for memory), a badge, and where to change it.
 *
 * Plain words: no kernel vocabulary reaches this panel. The daemon writes the sentences; this draws them.
 */

import { SettingGroup } from '@ferretry/app';
import { CircleAlert, Gauge, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type LimitsPanelView, LimitsPanelViewSchema } from '../../lib/protocol/limits-view.ts';
import type { DaemonConnection } from '../../shell.ts';
import type { TerminalSlotsClient } from './terminal-slots-api.ts';

/** The badge: whether limits are doing their job on this machine. */
export const limitsBadge = (view: LimitsPanelView): { readonly text: string; readonly good: boolean } => {
  if (!view.switchedOn) return { text: 'switched off', good: false };
  if (view.enforcement === 'cgroups') return { text: 'enforced', good: true };
  if (view.enforcement === 'priority') return { text: 'priority only', good: true };
  return { text: 'not enforced', good: false };
};

function LimitsCard({ view }: { readonly view: LimitsPanelView }) {
  const badge = limitsBadge(view);
  return (
    <section aria-label="Ferret limits" className="min-w-0" data-testid="limits-card">
      <div className="flex flex-wrap items-center gap-2 px-1">
        <ShieldCheck aria-hidden="true" className="text-accent" size={16} />
        <span
          className={
            badge.good
              ? 'rounded-control bg-ok-bg px-2 py-0.5 text-meta font-medium text-ok'
              : 'rounded-control bg-warn-bg px-2 py-0.5 text-meta font-medium text-warn'
          }
          data-limits-badge=""
        >
          {badge.text}
        </span>
      </div>
      <p className="mb-8 mt-1 px-1 text-cell leading-base text-muted">
        Ferrets are kept below what you can really spend, so this machine’s daemon stays quick to answer even when the
        ferrets are busy.
      </p>
      <SettingGroup label="What is in force">
        {/* Two to a line when the PANEL (not the window) has room: the `li` is the container, its list the grid. */}
        <li className="min-w-0 [container-type:inline-size]">
          <ul
            className={
              'm-0 grid min-w-0 list-none grid-cols-1 p-0 [&>li+li]:border-t [&>li+li]:border-border ' +
              '[@container(min-width:640px)]:grid-cols-2 [@container(min-width:640px)]:gap-x-8 ' +
              '[@container(min-width:640px)]:[&>li:nth-child(2)]:border-t-0'
            }
          >
            {view.lines.map(line => (
              <li
                className="flex min-h-[44px] min-w-0 items-start gap-1.5 py-2 pl-panel pr-1 text-ui leading-base text-fg"
                key={line}
              >
                <Gauge aria-hidden="true" className="mt-0.5 shrink-0 text-muted" size={14} />
                <span className="min-w-0 break-words">{line}</span>
              </li>
            ))}
          </ul>
        </li>
      </SettingGroup>
      {view.warnings.length === 0 ? null : (
        <div className="mb-8 flex flex-col gap-2">
          {view.warnings.map(warning => (
            <p
              className="m-0 rounded-panel border border-warn-border bg-warn-bg px-panel py-2 text-meta leading-base text-warn"
              key={warning}
              role="alert"
            >
              <CircleAlert aria-hidden="true" className="mr-1 inline" size={14} />
              {warning}
            </p>
          ))}
        </div>
      )}
      <p className="m-0 px-1 text-meta leading-base text-muted">
        To change a limit, edit <code className="font-mono text-fg">{view.file}</code> in Settings › Files. A change
        that tightens a limit applies at once; one that raises a limit, or switches limits off, waits for you to confirm
        it. Ferrets already running keep the limits they started with.
      </p>
    </section>
  );
}

type LimitsClientFactory = (connection: DaemonConnection) => Promise<TerminalSlotsClient>;

type Load =
  | { readonly daemonId: string; readonly kind: 'ready'; readonly view: LimitsPanelView }
  | { readonly daemonId: string; readonly kind: 'failed'; readonly reason: string };

export function LimitsSurface({
  connection,
  createClient,
}: {
  readonly connection: DaemonConnection;
  readonly createClient: LimitsClientFactory;
}) {
  const [load, setLoad] = useState<Load | null>(null);

  useEffect(() => {
    let current = true;
    setLoad(null);
    void createClient(connection)
      .then(async client => await client.request('/v1/cgroups/config', LimitsPanelViewSchema))
      .then(view => {
        if (current) setLoad({ daemonId: connection.daemonId, kind: 'ready', view });
      })
      .catch((cause: unknown) => {
        if (current)
          setLoad({
            daemonId: connection.daemonId,
            kind: 'failed',
            reason: cause instanceof Error ? cause.message : String(cause),
          });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  if (load === null || load.daemonId !== connection.daemonId) return null;
  if (load.kind === 'ready') return <LimitsCard view={load.view} />;
  return (
    <section aria-label="Ferret limits unavailable" className="kt-panel p-panel" role="status">
      <h3 className="m-0 text-row font-semibold text-fg">Ferret limits unavailable</h3>
      <p className="mb-0 mt-1 text-cell leading-base text-muted">
        This daemon did not say what limits are in force. Ferretry will not assume they are on or off. {load.reason}
      </p>
    </section>
  );
}
