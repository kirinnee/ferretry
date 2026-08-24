/**
 * THE PERSISTED HEAD: one record per account, and the two rules that decide what may overwrite it.
 *
 * The head is the newest thing worth remembering about an account, and nothing else. There is no
 * attempt history: the surfaces need "what is it and when was it last checked", and a per-attempt
 * table would be a second store to keep consistent for a detail no reader has asked for.
 *
 * Two rules live here, and both exist because a verdict is a claim about a person's account:
 *
 * ## 1. A credential replaced mid-check cannot be condemned by that check
 *
 * The dangerous sequence is ordinary: a provider read is in flight, the person signs in again, the
 * read comes back `401` about the credential that no longer exists. Committing it marks a freshly
 * working account as needing re-login, and the person is sent to do again the thing they just did.
 *
 * So a REMOTE negative is committed only when the local credential digest is unchanged since the
 * previous observation. If it moved, the head records `credential_changed_during_check` and keeps no
 * conclusion — the next pass, at most one usage interval later, settles it against the credential
 * that is actually installed. It errs toward `unknown`, never toward condemned.
 *
 * The guard is deliberately NOT applied to a LOCAL negative. A local verdict is decided from the very
 * material that was just digested, so it cannot be about a credential that has since been replaced —
 * and applying the guard there would discard the correct verdict for a sign-OUT, which changes the
 * digest exactly as a sign-in does.
 *
 * ## 2. An inconclusive result never erases a conclusion; it ages it
 *
 * A failed provider call moves `lastCheckedAt` and nothing else. The stored conclusion stands and is
 * published with `lastCheckInconclusive`, so a reader sees both facts: what is believed, and that the
 * last attempt to re-prove it failed. Hiding the failure is how a fleet reads healthy while every
 * provider call is failing.
 *
 * Staleness then bounds how long that can go on — see {@link projectAccountHealth}. It applies to
 * NEGATIVE conclusions too, so somebody who signs in again outside Ferretry is not condemned forever
 * by a rejection this daemon happened to observe first.
 */
import {
  type AccountHealthObservation,
  type FleetAccountHealth,
  FleetAccountHealthSchema,
  FLEET_HEALTH_FRESH_MS,
  FleetHealthEvidenceSchema,
  FleetHealthReasonSchema,
  FleetHealthVerdictSchema,
} from '@ferretry/fleet';
import { z } from 'zod';

const epochMilliseconds = z.number().int().nonnegative().refine(Number.isFinite, 'expected a finite number');

/**
 * What survives a restart, per account.
 *
 * `fingerprint` is the opaque credential digest from the observation that produced `verdictAt`, or
 * from the newest observation when there is no conclusion. It is compared for equality and used for
 * nothing else; it is not credential material and cannot be turned back into any.
 */
export const AccountHealthHeadSchema = z.strictObject({
  accountId: z.string().min(1),
  kind: z.string().min(1),
  /** The stored conclusion. `unknown` here means no conclusion has ever been reached. */
  verdict: FleetHealthVerdictSchema,
  reason: FleetHealthReasonSchema,
  evidence: FleetHealthEvidenceSchema,
  lastCheckedAt: epochMilliseconds.nullable(),
  verdictAt: epochMilliseconds.nullable(),
  lastCheckInconclusive: z.boolean(),
  fingerprint: z.string().min(1).nullable(),
});
export type AccountHealthHead = z.infer<typeof AccountHealthHeadSchema>;

/**
 * The whole persisted document.
 *
 * NO SCHEMA VERSION FIELD, and that is a decision rather than an omission. This document is derived
 * evidence with a fifteen-minute horizon: every row can be re-established for free by the pass that
 * already runs every minute. A shape this build cannot parse is therefore discarded and re-collected,
 * which is strictly better than a migration for a file whose entire contents are disposable — and a
 * version number would invite one.
 */
export const AccountHealthDocumentSchema = z.strictObject({
  accounts: z.array(AccountHealthHeadSchema),
});
export type AccountHealthDocument = z.infer<typeof AccountHealthDocumentSchema>;

/** A head for an account nothing has ever observed. `null` timestamps, and no invented verdict. */
export function neverCheckedHead(accountId: string, kind: string): AccountHealthHead {
  return {
    accountId,
    kind,
    verdict: 'unknown',
    reason: 'never_checked',
    evidence: 'none',
    lastCheckedAt: null,
    verdictAt: null,
    lastCheckInconclusive: false,
    fingerprint: null,
  };
}

/** Whether this conclusion condemns the account, and therefore whether the change guard applies. */
const negative = (verdict: AccountHealthObservation['verdict']): boolean =>
  verdict === 'needs_relogin' || verdict === 'needs_credentials';

/**
 * Fold one observation into a stored head.
 *
 * Pure and total. Ordered so the two rules in the module note are visible as branches rather than
 * implied by arithmetic.
 */
export function mergeAccountHealthHead(
  head: AccountHealthHead | undefined,
  observation: AccountHealthObservation,
): AccountHealthHead {
  const previous = head ?? neverCheckedHead(observation.accountId, observation.kind);
  const fingerprint = observation.fingerprint ?? null;
  const checked = { ...previous, kind: observation.kind, lastCheckedAt: observation.at };

  if (!observation.conclusive) {
    // Nothing conclusive was learned — but WHETHER there is a conclusion to protect decides what the
    // head says, and getting this wrong is how an account that has been checked keeps reading "never
    // checked" forever.
    //
    // With a standing conclusion, it is preserved with its own older `verdictAt`, and
    // `lastCheckInconclusive` publishes the failed attempt beside it.
    //
    // With NO standing conclusion there is nothing to protect, so the newest inconclusive reason IS
    // the head's reason: `unknown/check_timeout` rather than `unknown/never_checked`. And
    // `lastCheckInconclusive` stays FALSE for it, because the verdict already says it could not be
    // told — adding "the last check was inconclusive" beside it would say the same thing twice.
    const standing = previous.verdictAt !== null;
    return {
      ...checked,
      ...(standing ? {} : { verdict: observation.verdict, reason: observation.reason, evidence: observation.evidence }),
      lastCheckInconclusive: standing,
      fingerprint,
    };
  }

  // RULE 1. A remote rejection about a credential that has since been replaced is not attributable to
  // the credential now installed. `previous.fingerprint === null` is a first observation, which has
  // nothing to have changed from.
  const replaced = previous.fingerprint !== null && fingerprint !== null && previous.fingerprint !== fingerprint;
  if (negative(observation.verdict) && observation.evidence === 'anthropic_usage' && replaced) {
    return {
      ...checked,
      verdict: 'unknown',
      reason: 'credential_changed_during_check',
      evidence: 'none',
      verdictAt: null,
      lastCheckInconclusive: true,
      fingerprint,
    };
  }

  return {
    ...checked,
    verdict: observation.verdict,
    reason: observation.reason,
    evidence: observation.evidence,
    verdictAt: observation.at,
    lastCheckInconclusive: false,
    fingerprint,
  };
}

/**
 * The head as a published row, with staleness applied.
 *
 * READING NEVER CHANGES ANYTHING. A browser opening a panel, a daemon restarting and a scraper
 * pulling metrics all reach this function, and none of them is a check: `lastCheckedAt` is whatever
 * the last real observation wrote, and this only decides whether the conclusion beside it is still
 * worth publishing.
 */
export function projectAccountHealth(head: AccountHealthHead, now: number): FleetAccountHealth {
  const at = Math.trunc(now);
  const stale = head.verdictAt !== null && at - head.verdictAt > FLEET_HEALTH_FRESH_MS;
  if (stale) {
    return FleetAccountHealthSchema.parse({
      accountId: head.accountId,
      kind: head.kind,
      verdict: 'unknown',
      reason: 'stale',
      evidence: head.evidence,
      lastCheckedAt: head.lastCheckedAt,
      verdictAt: head.verdictAt,
      lastCheckInconclusive: head.lastCheckInconclusive,
      // What it WAS, so a reader is told "this was healthy and is now too old to trust" rather than
      // being handed a bare unknown that looks like the account was never checked.
      staleVerdict: head.verdict,
    });
  }
  return FleetAccountHealthSchema.parse({
    accountId: head.accountId,
    kind: head.kind,
    verdict: head.verdict,
    reason: head.reason,
    evidence: head.evidence,
    lastCheckedAt: head.lastCheckedAt,
    verdictAt: head.verdictAt,
    lastCheckInconclusive: head.lastCheckInconclusive,
  });
}
