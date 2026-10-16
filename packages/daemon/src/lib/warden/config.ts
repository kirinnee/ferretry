/**
 * The warden's operator configuration: how often it sweeps, what counts as an
 * anomaly, which accounts it may run a check on, and whether it may escalate to
 * an LLM at all.
 *
 * WHERE IT LIVES. In its own human-editable file, `config/warden.yaml`
 * (docs/config-files.md), not in `config/daemon.json`. kteam kept it in the one
 * daemon config file and paid for it: `updateWardenConfig` had to
 * read-modify-write a document holding every unrelated subsystem's settings, so
 * a torn write to a warden field could lose a host binding. The file holds only
 * what the owner changed; the rest is {@link defaultWardenConfig}. An edit to it
 * that turns spending on is held until the owner confirms it.
 *
 * WHAT `enabled` AND `triage` GATE. Detection is always on: the anomaly list,
 * the fingerprint and the failover status are deterministic and cost nothing but
 * a fleet read. `enabled` is the owner's On/Off for everything after that, and
 * `triage` decides whether a flag may cost anything at all: `rules` — the
 * default — never spends, so a fresh daemon is on and watching without spending
 * a token. Jev and LLM triage are each an explicit opt-in with a daily cap
 * (`triage.ts`).
 *
 * TOLERANT ON READ, STRICT ON WRITE. A stored document that no longer validates
 * falls back to the defaults and SAYS SO in a warning, because the defaults are
 * the safe direction: `triage: rules` means a configuration the daemon cannot
 * understand can never authorise a spawn. A PATCH is parsed strictly instead —
 * an operator naming a field that does not exist has made a mistake worth
 * refusing, not worth silently dropping.
 *
 * Pure: no IO, no clock, no globals.
 */

import {
  DEFAULT_WARDEN_CONFIG,
  mergeWardenConfig,
  type WardenConfig,
  type WardenConfigPatch,
  WardenConfigPatchSchema,
  WardenConfigSchema,
} from '@ferretry/protocol';
import type { WardenDetectOptions } from './detect.ts';
import { normalizeWardenAccounts, type WardenAccount } from './failover.ts';

export type { WardenConfig, WardenConfigPatch };

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

/** The configuration a state home with no `warden.yaml` behaves as: escalation OFF, so a fresh
 *  daemon never starts spending on its own. Detection still runs and the evidence is still served. */
export const defaultWardenConfig: WardenConfig = DEFAULT_WARDEN_CONFIG;

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
 * Every nested section — the guard, the caps, what the Warden may do alone, the
 * events, the investigation, `failover` and `providerOutage` — merges one level
 * deeper, because each is `.partial()` on the wire: an owner ticking one box must
 * not thereby reset its siblings to whatever a fresh object would carry.
 *
 * The result is re-parsed through the full schema, so a merge cannot produce a
 * document the loader would later refuse — the bounds hold on the way out, not
 * only on the way in.
 */
export function applyWardenConfigPatch(config: WardenConfig, patch: WardenConfigPatch): WardenConfig {
  return mergeWardenConfig(config, patch);
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
    warnings.push('the Warden is off (enabled=false); detection still runs, but nothing is triaged or acted on');
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
