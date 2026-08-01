/**
 * The warden's operator configuration: how often it sweeps, what counts as an
 * anomaly, which accounts it may run a check on, and whether it may escalate to
 * an LLM at all.
 *
 * WHERE IT LIVES. In its own document inside the state home (`warden/config.json`),
 * not in `config/daemon.json`. kteam kept it in the one daemon config file and
 * paid for it: `updateWardenConfig` had to read-modify-write a document holding
 * every unrelated subsystem's settings, so a torn write to a warden field could
 * lose a host binding. Ferretry already keeps a document per subject — the
 * self-restart stamp, the health event log, the pin store — and this is one more.
 *
 * WHAT `enabled` GATES. Only the LLM escalation. Detection is always on: the
 * anomaly list, the fingerprint and the failover status are deterministic and
 * cost nothing but a fleet read, so an operator who has not opted into spending
 * agent sessions still gets the evidence. That split is kteam's and it is the
 * reason the default is `false` — a fresh daemon must not start spending tokens
 * on its own.
 *
 * TOLERANT ON READ, STRICT ON WRITE. A stored document that no longer validates
 * falls back to the defaults and SAYS SO in a warning, because the defaults are
 * the safe direction: `enabled: false` means a configuration the daemon cannot
 * understand can never authorise a spawn. A PATCH is parsed strictly instead —
 * an operator naming a field that does not exist has made a mistake worth
 * refusing, not worth silently dropping.
 *
 * Pure: no IO, no clock, no globals.
 */

import {
  WardenConfigPatchSchema,
  WardenConfigSchema,
  type WardenConfig,
  type WardenConfigPatch,
} from '@ferretry/protocol';
import type { WardenDetectOptions } from './detect.ts';
import { normalizeWardenAccounts, type WardenAccount } from './failover.ts';

export type { WardenConfig, WardenConfigPatch };

/**
 * The account a warden runs on when nothing is configured.
 *
 * A warden JUDGES: it reads a suspect session's transcript and returns one
 * verdict. That is triage-tier work, so the default is the cheap mechanical
 * account rather than an expensive one — one Opus-class session per sweep is how
 * supervision becomes more expensive than the fleet it supervises.
 *
 * `model` is deliberately left UNSET on the default account. That wrapper
 * resolves the model aliases through its own environment, and pinning a raw
 * model id here would send an id its provider rejects.
 */
export const DEFAULT_WARDEN_ACCOUNT = 'claude-auto-glm52a';

/**
 * Floors applied when deriving milliseconds from configured minutes.
 *
 * They are not redundant with the schema's `positive()`: a one-minute sweep
 * interval parses, and a warden that swept every minute would spend a session
 * per minute. The floor is what makes a mis-set small number cheap rather than
 * ruinous.
 */
export const MINIMUM_SWEEP_INTERVAL_MS = 60_000;
export const MINIMUM_UNATTENDED_MS = 60_000;
export const MINIMUM_SUS_SECONDS = 60;

/** The configuration a state home with no warden document behaves as. */
export const defaultWardenConfig: WardenConfig = {
  // OFF: detection still runs and the evidence is still served. Only the spend
  // is opt-in.
  enabled: false,
  accounts: [{ agent: DEFAULT_WARDEN_ACCOUNT }],
  failover: {
    policy: 'fallback',
    // Two, not the failover module's three: the usage feed corroborates quota
    // and auth at the source, so the threshold only governs raw launch errors,
    // and kteam settled on two for those.
    failureThreshold: 2,
    cooldownMinutes: 30,
  },
  providerOutage: { minDistinctSessions: 2, persistenceSweeps: 2, tailLines: 24 },
  intervalMinutes: 5,
  unattendedMinutes: 30,
  minSpawnGapMinutes: 15,
  susThinkingSeconds: 900,
  susSubprocessSeconds: 900,
  // ONE warden fleet-wide by default, counting the sweep warden. See
  // `concurrency.ts`: both spawn sites draw down this single budget.
  maxAssignedWardens: 1,
  assignedCooldownMinutes: 30,
  blessMinutes: 15,
};

export interface StoredWardenConfig {
  readonly config: WardenConfig;
  /** Non-empty exactly when the stored document could not be used as written. */
  readonly warnings: readonly string[];
}

/**
 * The configuration a persisted document means.
 *
 * `undefined` — no document yet — is the normal first-boot situation and yields
 * the defaults with no warning. Anything present but invalid yields the defaults
 * WITH a warning: the surface that reports the fleet is unhealthy must not
 * itself go dark because one document was hand-edited, and the warning is what
 * stops the fallback being silent.
 */
export function parseStoredWardenConfig(value: unknown): StoredWardenConfig {
  if (value === undefined || value === null) return { config: defaultWardenConfig, warnings: [] };
  const parsed = WardenConfigSchema.safeParse(value);
  if (parsed.success) return { config: parsed.data, warnings: [] };
  return {
    config: defaultWardenConfig,
    warnings: [
      `the stored warden configuration did not validate (${issueSummary(parsed.error.issues)}); defaults are in effect and escalation is disabled`,
    ],
  };
}

/**
 * The first validation failure, in the operator's vocabulary.
 *
 * Only the first: the point of the message is to name something the operator can
 * go and fix, and a document that fails one field usually fails several for the
 * same reason. A failure with no field path is about the document as a whole —
 * it was not an object at all.
 */
function issueSummary(issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[]): string {
  return issues
    .slice(0, 1)
    .map(issue => `${issue.path.length === 0 ? 'document' : issue.path.map(String).join('.')}: ${issue.message}`)
    .join('');
}

/**
 * Apply an operator patch, nested sections merged rather than replaced.
 *
 * `failover` and `providerOutage` merge one level deeper because both are
 * declared `.partial()` on the wire: an operator switching the policy must not
 * thereby reset the strike threshold to whatever a fresh object would carry.
 *
 * The result is re-parsed through the full schema, so a merge cannot produce a
 * document the loader would later refuse — the bounds hold on the way out, not
 * only on the way in.
 */
export function applyWardenConfigPatch(config: WardenConfig, patch: WardenConfigPatch): WardenConfig {
  return WardenConfigSchema.parse({
    ...config,
    ...patch,
    failover: { ...config.failover, ...(patch.failover ?? {}) },
    providerOutage: { ...config.providerOutage, ...(patch.providerOutage ?? {}) },
  });
}

/** Parses a patch as an operator stated it, refusing unknown fields. */
export function parseWardenConfigPatch(value: unknown): WardenConfigPatch {
  return WardenConfigPatchSchema.parse(value);
}

/**
 * What an operator should know about the configuration they have.
 *
 * An account missing from the host WARNS and is never rejected: the fleet
 * installer may be about to create it, and refusing the configuration would
 * order-couple two tools that have no reason to know about each other. An EMPTY
 * inventory warns about nobody — it means the inventory is unreadable, which is
 * evidence about the host rather than about any account.
 */
export function wardenConfigWarnings(config: WardenConfig, installedAgents: readonly string[]): readonly string[] {
  const accounts = normalizeWardenAccounts(config.accounts);
  const warnings: string[] = [];
  if (accounts.length === 0) warnings.push('no warden accounts are configured, so no check can ever run');
  if (installedAgents.length > 0) {
    for (const account of accounts) {
      if (!installedAgents.includes(account.agent))
        warnings.push(`account ${account.agent} is not installed on this host (it will be skipped until it appears)`);
    }
    if (accounts.length > 0 && accounts.every(account => !installedAgents.includes(account.agent)))
      warnings.push('every configured warden account is missing from this host, so no check can run');
  }
  if (!config.enabled)
    warnings.push('escalation is disabled (enabled=false); detection still runs and reports evidence');
  return warnings;
}

/** The effective ordered account list this configuration selects from. */
export function wardenAccountsOf(config: WardenConfig): readonly WardenAccount[] {
  return normalizeWardenAccounts(config.accounts);
}

/**
 * The detector's thresholds, in the units it reasons in.
 *
 * `terminalWindowMs` is deliberately the SAME number as `unattendedMs` rather
 * than a knob of its own. One threshold answers both "nobody answered this
 * question" and "nobody handled this wreckage", so wreckage older than the
 * window ages out instead of being re-reported forever.
 */
export function wardenDetectOptions(config: WardenConfig): WardenDetectOptions {
  const unattendedMs = unattendedWindowMs(config);
  return {
    unattendedMs,
    terminalWindowMs: unattendedMs,
    susThinkingSeconds: Math.max(MINIMUM_SUS_SECONDS, config.susThinkingSeconds),
    susSubprocessSeconds: Math.max(MINIMUM_SUS_SECONDS, config.susSubprocessSeconds),
  };
}

export function unattendedWindowMs(config: WardenConfig): number {
  return Math.max(MINIMUM_UNATTENDED_MS, config.unattendedMinutes * 60_000);
}

/** The sweep cadence the timer fires on. */
export function sweepIntervalMs(config: WardenConfig): number {
  return Math.max(MINIMUM_SWEEP_INTERVAL_MS, config.intervalMinutes * 60_000);
}

/** The rate limit between two fleet-triage escalations. Zero is a legal
 *  configuration and means "no gap", so this floors at zero rather than at a
 *  minute. */
export function spawnGapMs(config: WardenConfig): number {
  return Math.max(0, config.minSpawnGapMinutes * 60_000);
}

/** How long a target is left alone after its assigned warden finished. */
export function assignedCooldownMs(config: WardenConfig): number {
  return Math.max(0, config.assignedCooldownMinutes * 60_000);
}
