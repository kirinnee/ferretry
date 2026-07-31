/**
 * Recent Warden outcomes, ported from kteam's WardenVerdicts row surface.
 *
 * The PWA deliberately receives verdicts from a daemon-bound host rather than
 * polling an ambient client.  That makes the source of every report explicit:
 * identical session ids or report paths on two paired daemons cannot cross.
 */

import { ChevronRight, Gavel, Skull, HeartPulse, Bell, Check, UserRound } from 'lucide-react';
import { useState } from 'react';

import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { relativeTime } from '../../lib/session-screens.ts';
import { displayCallsign } from '../../lib/callsign.ts';

export type WardenVerdictKind = 'killed' | 'revived' | 'nudged' | 'cleared' | 'needs_human' | 'unknown';

/** Provenance is optional for reports written by an older daemon. */
export interface WardenVerdictSpawnInfo {
  readonly agent?: string;
  readonly model?: string;
  readonly modelSource?: 'harness' | 'agent' | 'configured' | 'unknown';
  readonly modelHint?: string;
  readonly harness?: string;
  readonly failedOver?: boolean;
  readonly configuredFirst?: string;
  readonly skipped?: Readonly<Record<string, string>>;
  readonly failoverReason?: string;
}

export interface WardenVerdictView {
  readonly at: string;
  readonly targetSession?: string;
  readonly teammate?: string;
  readonly verdict: WardenVerdictKind;
  readonly reason?: string;
  readonly reportPath: string;
  readonly spawn?: WardenVerdictSpawnInfo;
}

export interface WardenReportRequest {
  readonly connection: DaemonConnection;
  readonly verdict: WardenVerdictView;
}

const VERDICT: Record<
  WardenVerdictKind,
  { readonly label: string; readonly cls: string; readonly Icon: typeof Skull }
> = {
  killed: { label: 'killed', cls: 'text-err border-err-border bg-err-bg', Icon: Skull },
  revived: { label: 'revived', cls: 'text-accent border-accent bg-accent-soft', Icon: HeartPulse },
  nudged: { label: 'nudged', cls: 'text-accent border-accent bg-accent-soft', Icon: Bell },
  cleared: { label: 'cleared', cls: 'text-muted border-border bg-surface-2', Icon: Check },
  needs_human: { label: 'needs human', cls: 'text-warn border-warn-border bg-warn-bg', Icon: UserRound },
  unknown: { label: 'reviewed', cls: 'text-faint border-border bg-surface-2', Icon: Gavel },
};

const verdictModelCopy = (spawn: WardenVerdictSpawnInfo): string => {
  if (spawn.modelSource === 'unknown') return 'model unknown';
  if (spawn.model) return spawn.modelSource === 'agent' ? `${spawn.model} (agent default)` : spawn.model;
  return spawn.modelHint ? `${spawn.modelHint} (agent default)` : 'model unknown';
};

/** Keep missing provenance visible: an absent line looks like a healthy source. */
export const verdictProvenanceLine = (spawn?: WardenVerdictSpawnInfo): string => {
  if (!spawn?.agent) return 'Ran by: unknown (older report)';
  return `${spawn.agent} · ${verdictModelCopy(spawn)} · ${spawn.harness ?? 'harness unknown'}`;
};

export const switchedAccountCopy = (spawn?: WardenVerdictSpawnInfo): string | null =>
  spawn?.failedOver ? 'switched account' : null;

/** State why the Warden used a different account, without inventing a reason. */
export const failoverReasonCopy = (spawn?: WardenVerdictSpawnInfo): string => {
  if (!spawn) return 'failover moved this check off the configured first choice';
  const skipped = spawn.skipped ?? {};
  const first = spawn.configuredFirst === undefined ? undefined : skipped[spawn.configuredFirst];
  const any = Object.values(skipped).find(reason => reason.trim() !== '');
  const reason = first ?? spawn.failoverReason ?? any;
  const off = spawn.configuredFirst ? `moved off ${spawn.configuredFirst}` : 'moved off the configured first choice';
  return reason ? `${off}: ${reason}` : off;
};

export interface WardenVerdictsProps {
  /** The connection is required even though it is never displayed. */
  readonly connection: DaemonConnection;
  readonly verdicts: readonly WardenVerdictView[];
  readonly now?: number;
  readonly onOpenReport: (request: WardenReportRequest) => void;
}

/**
 * Expanded on the dedicated Warden page. The switch remains for long report
 * histories, but arriving at a closed accordion would make the reader tap to
 * see the content they explicitly navigated to.
 */
export function WardenVerdicts({ connection, verdicts, now = Date.now(), onOpenReport }: WardenVerdictsProps) {
  const [open, setOpen] = useState(true);

  // Old daemons and a clean history stay quiet, matching the source surface.
  if (verdicts.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-lg border border-border-soft bg-surface" aria-label="Warden verdicts">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        className="flex min-h-[44px] w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-surface-2"
      >
        <Gavel size={14} className="shrink-0 text-faint" aria-hidden="true" />
        <span className="font-medium text-fg-soft">Warden verdicts</span>
        <span className="mono text-[11.5px] text-faint">{verdicts.length} recent</span>
        <ChevronRight
          size={14}
          className={cn('ml-auto shrink-0 text-faint transition-transform', open && 'rotate-90')}
        />
      </button>
      {open && <VerdictRows connection={connection} verdicts={verdicts} now={now} onOpenReport={onOpenReport} />}
    </section>
  );
}

/** Pure rows; the daemon-bound host owns fetching and rendering a full report. */
export function VerdictRows({
  connection,
  verdicts,
  now = Date.now(),
  onOpenReport,
}: WardenVerdictsProps): React.JSX.Element {
  return (
    <ul className="m-0 list-none divide-y divide-border-soft border-t border-border-soft p-0">
      {verdicts.map(verdict => {
        const meta = VERDICT[verdict.verdict] ?? VERDICT.unknown;
        const switched = switchedAccountCopy(verdict.spawn);
        return (
          <li key={`${verdict.reportPath}-${verdict.targetSession ?? 'unknown'}-${verdict.at}-${verdict.verdict}`}>
            <button
              type="button"
              onClick={() => onOpenReport({ connection, verdict })}
              className="flex min-h-[44px] w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-surface-2"
              aria-label={`Open Warden report for ${displayCallsign(verdict.teammate) || verdict.targetSession || 'unknown session'}`}
            >
              <span className="flex w-full min-w-0 items-center gap-2.5">
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider',
                    meta.cls,
                  )}
                >
                  <meta.Icon size={11} aria-hidden="true" />
                  {meta.label}
                </span>
                <span className="shrink-0 text-[12.5px] font-medium text-fg">
                  {displayCallsign(verdict.teammate) || verdict.targetSession || '—'}
                </span>
                {verdict.reason && (
                  <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{verdict.reason}</span>
                )}
                <span className="mono ml-auto shrink-0 text-[11px] text-faint">{relativeTime(verdict.at, now)}</span>
              </span>
              <span className="flex w-full min-w-0 items-center gap-1.5">
                <span className="mono min-w-0 truncate text-[11px] text-faint">
                  {verdictProvenanceLine(verdict.spawn)}
                </span>
                {switched && (
                  <span
                    title={failoverReasonCopy(verdict.spawn)}
                    className="shrink-0 rounded border border-warn-border bg-warn-bg px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-warn"
                  >
                    {switched}
                  </span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
