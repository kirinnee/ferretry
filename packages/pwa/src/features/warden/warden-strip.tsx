/**
 * The fleet-health "checks" strip on the sessions dashboard — quiet by default.
 *
 * Ported from kteam `ui/src/components/WardenStrip.tsx`, and since restyled to the Warden page's
 * vocabulary: the triage actually in effect, how many sessions need the owner, and plain chips instead
 * of raw anomaly codes. Its old byte-identical pin to kteam's markup was retired by the owner with the
 * Warden redesign.
 *
 * IT DOES NOT POLL. Fetching lives in `useWardenStatus`, keyed by daemon, which discards a response
 * that arrives after the reader switched daemon. This component renders the status it is handed.
 *
 * SELF-HIDING. A daemon too old to serve `/v1/warden/status` must not put an error on the reader's
 * dashboard: no status means no strip. Rendering `null` IS the design, not a missing loading state.
 *
 * NO ALL-CLEAR WITHOUT A SWEEP. A daemon that has not swept yet has no evidence, and says so.
 */

import type { WardenStatusView } from '@ferretry/protocol';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { cn } from '../../lib/class-names.ts';
import { relativeTime } from '../../lib/session-screens.ts';
import {
  wardenAccountLabel,
  wardenAccountTitle,
  wardenAnomalyDigest,
  wardenExhaustionLabel,
  wardenNeedsYouCount,
  wardenTriageLabel,
} from './warden-status-model.ts';

export interface WardenStripProps {
  /** `null` means "not known" — an older daemon, or a failed read. */
  readonly status: WardenStatusView | null;
  readonly now?: number;
}

/** The `·` separators are decoration and must never be announced. */
function Dot() {
  return (
    <span aria-hidden="true" className="text-faint">
      ·
    </span>
  );
}

export function WardenStrip({ status, now = Date.now() }: WardenStripProps) {
  if (status === null) return null;

  const digest = wardenAnomalyDigest(status.anomalies);
  const reporting = status.lastSweepAt !== undefined;
  const needs = wardenNeedsYouCount(status);
  const healthy = reporting && needs === 0;
  const exhaustion = wardenExhaustionLabel(status.failover);
  const accounts = status.failover?.accounts ?? [];

  return (
    <div className="mb-4 flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-meta">
      <span className="inline-flex items-center gap-1.5 font-medium text-fg-soft">
        {healthy ? (
          <ShieldCheck size={14} className="text-ok" aria-hidden="true" />
        ) : (
          <ShieldAlert size={14} className="text-warn" aria-hidden="true" />
        )}
        Fleet checks
      </span>
      <Dot />
      <span className="text-muted">{wardenTriageLabel(status)}</span>
      <Dot />
      <span className="text-muted">
        {reporting ? `swept ${relativeTime(status.lastSweepAt, now)}` : 'not swept yet'}
      </span>
      <Dot />
      <span className={cn(healthy ? 'text-ok' : 'font-medium text-warn')}>
        {needs > 0 ? `${needs} need you` : reporting ? 'nobody needs you' : 'no evidence yet'}
      </span>
      {!digest.clean && (
        <>
          <Dot />
          <span className="min-w-0 max-w-full break-words text-muted" title={digest.detail}>
            {digest.summary}
          </span>
        </>
      )}
      {status.liveWarden !== undefined && (
        <>
          <Dot />
          <span className="text-muted">investigating</span>
        </>
      )}
      {accounts.length > 0 && (
        <>
          <Dot />
          <ul className="inline-flex flex-wrap items-center gap-1" aria-label="Warden accounts">
            {accounts.map(account => (
              <li
                key={account.agent}
                title={wardenAccountTitle(account)}
                className={cn(
                  'rounded-control px-1.5 py-0.5',
                  account.eligible ? 'bg-ok-bg text-ok' : 'bg-warn-bg text-warn',
                )}
              >
                {wardenAccountLabel(account)}
                {account.agent === status.failover?.lastSelection?.agent ? ' · in use' : ''}
              </li>
            ))}
          </ul>
        </>
      )}
      {exhaustion !== undefined && <span className="font-medium text-warn">{exhaustion}</span>}
    </div>
  );
}
