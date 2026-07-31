/**
 * The fleet-health "checks" strip — quiet by default.
 *
 * Ported from kteam `ui/src/components/WardenStrip.tsx`. Two deliberate changes
 * and one refinement kept:
 *
 * CHANGED — it does not poll. kteam's component owned a 30s `setInterval`
 * against one ambient `api` singleton, which is precisely the shape that cannot
 * survive several paired daemons. Fetching moved to `useWardenStatus`, which is
 * keyed by `(daemonId)` and discards a response that arrives after the reader
 * has switched daemon. This component renders a status it is handed.
 *
 * CHANGED — `account.wrapper` is `account.agent`, the protocol's own name.
 *
 * KEPT — SELF-HIDING. A daemon too old to serve `/v1/warden/status` must not
 * put an error on the reader's dashboard: no status means no strip. Rendering
 * `null` here IS the design, not a missing loading state.
 */

import { ShieldAlert, ShieldCheck } from 'lucide-react';
import type { WardenStatusView } from '@ferretry/protocol';
import { cn } from '../../lib/class-names.ts';
import { relativeTime } from '../../lib/session-screens.ts';
import {
  wardenAccountLabel,
  wardenAccountTitle,
  wardenAnomalyCountLabel,
  wardenAnomalyDigest,
  wardenExhaustionLabel,
} from './warden-status-model.ts';

export interface WardenStripProps {
  /** `null` means "not known" — an older daemon, or a failed read. */
  readonly status: WardenStatusView | null;
  readonly now?: number;
}

/** The `·` separators are decoration and must never be announced. */
function Dot() {
  return (
    <span aria-hidden="true" className="text-border">
      ·
    </span>
  );
}

export function WardenStrip({ status, now = Date.now() }: WardenStripProps) {
  if (status === null) return null;

  const digest = wardenAnomalyDigest(status.anomalies);
  const interval = status.config.intervalMinutes;
  const exhaustion = wardenExhaustionLabel(status.failover);
  const accounts = status.failover?.accounts ?? [];

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border-soft bg-surface-2 px-3 py-2 text-[12px]">
      <span className="inline-flex items-center gap-1.5 font-medium text-fg-soft">
        {digest.clean ? (
          <ShieldCheck size={14} className="text-ok" aria-hidden="true" />
        ) : (
          <ShieldAlert size={14} className="text-warn" aria-hidden="true" />
        )}
        Fleet checks
      </span>
      <Dot />
      <span className="mono text-muted">
        last sweep {status.lastSweepAt === undefined ? '—' : relativeTime(status.lastSweepAt, now)}
      </span>
      <Dot />
      <span className={cn('mono', digest.clean ? 'text-ok' : 'font-medium text-warn')}>
        {wardenAnomalyCountLabel(digest.count)}
      </span>
      <Dot />
      <span className="mono text-faint">every {interval}m</span>
      {status.liveWarden !== undefined && (
        <>
          <Dot />
          <span className="mono text-accent">warden live</span>
        </>
      )}
      {accounts.length > 0 && (
        <>
          <Dot />
          {/* kteam labelled a bare <span> group. A generic role cannot carry an
              accessible name, so the label was dropped by assistive tech and
              the repo's a11y gate rejects it. A <ul> is the honest element for
              a set of chips and DOES support `aria-label`; Tailwind's preflight
              zeroes its list style, margin and padding, and the <li> children
              become flex items of the same inline-flex track, so the rendered
              box is unchanged. */}
          <ul className="inline-flex flex-wrap items-center gap-1" aria-label="Warden accounts">
            {accounts.map(account => (
              // The chip classes sit on the <li> itself, not on a nested span:
              // the original chips were direct flex children, and wrapping them
              // would turn the padded box inline and change its height.
              <li
                key={account.agent}
                title={wardenAccountTitle(account)}
                className={cn(
                  'mono rounded-control px-1.5 py-0.5',
                  account.eligible ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn',
                )}
              >
                {wardenAccountLabel(account)}
                {account.agent === status.failover?.lastSelection?.agent ? ' ●' : ''}
              </li>
            ))}
          </ul>
        </>
      )}
      {exhaustion !== undefined && <span className="mono font-medium text-warn">{exhaustion}</span>}
      {!digest.clean && (
        <span className="mono ml-auto min-w-0 truncate text-faint" title={digest.detail}>
          {digest.summary}
        </span>
      )}
    </div>
  );
}
