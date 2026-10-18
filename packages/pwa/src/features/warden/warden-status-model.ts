/**
 * What the fleet-checks strip says, worked out without a browser.
 *
 * Ported from kteam `ui/src/components/WardenStrip.tsx` (the projections it
 * computed inline). The strip itself is quiet by design, so every judgement it
 * makes about severity lives here where it can be proved, rather than being
 * buried in a ternary inside JSX.
 *
 * It speaks the Warden page's vocabulary (`warden-vocabulary.ts`): plain chips,
 * never raw anomaly codes, and the triage actually in effect.
 *
 * `displayCallsign` used to live here as the strip's only caller. It moved to
 * `lib/callsign.ts` when the command palette needed it too: a shared helper
 * inside one feature is a dependency the shell should never have to take.
 */

import type {
  WardenAccount,
  WardenAnomaly,
  WardenFailoverAccountView,
  WardenLogin,
  WardenStatusView,
} from '@ferretry/protocol';
import { displayCallsign } from '../../lib/callsign.ts';
import { ANOMALY_CHIPS, TRIAGE_LABEL } from './warden-vocabulary.ts';

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

/**
 * The account chip label: the login's name as the owner wrote it. A login is named by its owner, so no
 * prefix is noise — trimming one only ever fit somebody's own wrapper naming.
 */
export const wardenAccountLabel = (account: Pick<WardenFailoverAccountView, 'agent'>): string => account.agent;

/**
 * The investigation login in effect: the head of the daemon's failover status, which already resolved
 * the machine default when the owner chose none. A daemon without that status falls back to the stored
 * order.
 */
export const wardenInvestigationHead = (
  status: Pick<WardenStatusView, 'config' | 'failover'>,
): Pick<WardenAccount, 'agent' | 'model'> | undefined => status.failover?.accounts[0] ?? status.config.accounts[0];

/**
 * Why no investigation can run on this machine, in the owner's words — or null when one can. A login
 * the machine does not have is named, never swapped for another: the owner chooses.
 */
export const wardenLoginProblem = (
  login: WardenLogin | undefined,
  accounts: readonly Pick<WardenAccount, 'agent'>[],
): string | null => {
  if (login === undefined) return null;
  if (login.source === 'not_set') return 'No investigation login is set';
  const known = accounts.filter(account => !login.unknown.includes(account.agent));
  if (accounts.length === 0 || known.length > 0) return null;
  return `Unknown login '${accounts[0]?.agent}'`;
};

/** `healthy`, or the daemon's own stated reason — never an invented one. */
export const wardenAccountTitle = (account: Pick<WardenFailoverAccountView, 'eligible' | 'reason'>): string =>
  account.eligible ? 'healthy' : (account.reason ?? 'ineligible');

export interface WardenAnomalyDigest {
  readonly count: number;
  readonly clean: boolean;
  /** At most three plain chips, then `+n`. A strip is a glance, not a report. */
  readonly summary: string;
  /** One `chip: who` line per anomaly, for the hover title. */
  readonly detail: string;
}

const anomalySubject = (anomaly: WardenAnomaly): string =>
  displayCallsign(anomaly.teammate) === '' ? anomaly.sessionId : displayCallsign(anomaly.teammate);

export const wardenAnomalyDigest = (anomalies: readonly WardenAnomaly[]): WardenAnomalyDigest => {
  const count = anomalies.length;
  const head = [...new Set(anomalies.map(anomaly => ANOMALY_CHIPS[anomaly.kind].label))];
  return {
    count,
    clean: count === 0,
    summary: `${head.slice(0, 3).join(', ')}${head.length > 3 ? ` +${head.length - 3}` : ''}`,
    detail: anomalies.map(anomaly => `${ANOMALY_CHIPS[anomaly.kind].label}: ${anomalySubject(anomaly)}`).join('\n'),
  };
};

/**
 * How many sessions wait on the owner, from the status alone: an action a verdict asked for that the
 * owner has not let the Warden take, and a flag nothing is investigating or has cleared. The Warden page
 * reads the full "who needs you" feed; the strip only has the status, so this is its honest subset.
 */
export const wardenNeedsYouCount = (status: WardenStatusView): number => {
  const watched = new Set(
    status.investigations.filter(entry => entry.state !== 'done').map(entry => entry.targetSession),
  );
  const blessed = new Set(status.blessings.map(blessing => blessing.sessionId));
  const sessions = new Set(status.actions.filter(entry => entry.outcome === 'held').map(entry => entry.sessionId));
  for (const anomaly of status.anomalies)
    if (!watched.has(anomaly.sessionId) && !blessed.has(anomaly.sessionId)) sessions.add(anomaly.sessionId);
  return sessions.size;
};

/** `Jev guard`, or the fallback in effect and why: `Rules only (cap hit)`, `Off`. */
export const wardenTriageLabel = (status: WardenStatusView): string => {
  const { triage } = status;
  if (!status.config.enabled || triage.reason === 'disabled') return 'Off';
  if (triage.reason === 'jev_cap' || triage.reason === 'investigation_cap')
    return `${TRIAGE_LABEL[triage.effective]} (cap hit)`;
  if (triage.reason === 'no_login') return `${TRIAGE_LABEL[triage.effective]} (no login)`;
  return TRIAGE_LABEL[triage.effective];
};
