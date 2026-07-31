/**
 * What the fleet-checks strip says, worked out without a browser.
 *
 * Ported from kteam `ui/src/components/WardenStrip.tsx` (the projections it
 * computed inline) plus `ui/src/lib/callsign.ts`. The strip itself is quiet by
 * design, so every judgement it makes about severity lives here where it can be
 * proved, rather than being buried in a ternary inside JSX.
 */

import type { WardenAnomaly, WardenFailoverAccountView, WardenStatusView } from '@ferretry/protocol';

/** Title-cases a callsign slug for display: `ms-98` → `Ms-98`. */
export const displayCallsign = (raw: string | null | undefined): string => {
  const slug = (raw ?? '').trim();
  if (slug === '') return '';
  return slug
    .split('-')
    .map(segment => (segment === '' ? segment : `${segment[0]?.toUpperCase() ?? ''}${segment.slice(1)}`))
    .join('-');
};

const NO_CREDENTIALS = /credentials rejected|no credentials/iu;

/**
 * Names the exhaustion the fleet is in, if any.
 *
 * "No credentials" and "no usable account" fail identically but are fixed
 * completely differently — one is an auth problem, the other is a quota
 * problem — so the strip refuses to blur them into one message. Nothing is said
 * at all until failover actually reports itself exhausted.
 */
export const wardenExhaustionLabel = (failover: WardenStatusView['failover']): string | undefined => {
  if (failover === undefined || failover.exhaustedSince === undefined) return undefined;
  const noCredentials =
    failover.accounts.length > 0 &&
    failover.accounts.every(account => account.quota?.authOk === false || NO_CREDENTIALS.test(account.reason ?? ''));
  return noCredentials ? 'no warden credentials!' : 'no usable warden account!';
};

/** The short account chip label: the wrapper prefix is noise on a dense strip. */
export const wardenAccountLabel = (account: Pick<WardenFailoverAccountView, 'agent'>): string =>
  account.agent.replace(/^(?:claude|codex)-auto-/u, '');

/** `healthy`, or the daemon's own stated reason — never an invented one. */
export const wardenAccountTitle = (account: Pick<WardenFailoverAccountView, 'eligible' | 'reason'>): string =>
  account.eligible ? 'healthy' : (account.reason ?? 'ineligible');

export interface WardenAnomalyDigest {
  readonly count: number;
  readonly clean: boolean;
  /** At most three kinds, then `+n`. A strip is a glance, not a report. */
  readonly summary: string;
  /** One `kind: who` line per anomaly, for the hover title. */
  readonly detail: string;
}

const anomalySubject = (anomaly: WardenAnomaly): string =>
  displayCallsign(anomaly.teammate) === '' ? anomaly.sessionId : displayCallsign(anomaly.teammate);

export const wardenAnomalyDigest = (anomalies: readonly WardenAnomaly[]): WardenAnomalyDigest => {
  const count = anomalies.length;
  const head = anomalies.slice(0, 3).map(anomaly => anomaly.kind);
  return {
    count,
    clean: count === 0,
    summary: `${head.join(', ')}${count > 3 ? ` +${count - 3}` : ''}`,
    detail: anomalies.map(anomaly => `${anomaly.kind}: ${anomalySubject(anomaly)}`).join('\n'),
  };
};

/** `no anomalies`, or a correctly pluralised count. */
export const wardenAnomalyCountLabel = (count: number): string =>
  count === 0 ? 'no anomalies' : `${count} ${count === 1 ? 'anomaly' : 'anomalies'}`;
