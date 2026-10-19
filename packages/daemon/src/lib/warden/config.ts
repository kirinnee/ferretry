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
 * WHAT `enabled` AND `layers` GATE. Detection is always on: the anomaly list,
 * the fingerprint and the failover status are deterministic and cost nothing but
 * a fleet read. `enabled` is the owner's On/Off for everything after that — the
 * rules flag whenever it is on — and `layers` decides whether a flag may cost
 * anything at all: both off — the default — never spends, so a fresh daemon is on
 * and watching without spending a token. Jev and LLM investigation are each an
 * explicit opt-in with its own daily cap (`triage.ts`). An older document's
 * `triage` is read as the layers it meant and never written back.
 *
 * TOLERANT ON READ, STRICT ON WRITE. A stored document that no longer validates
 * falls back to the defaults and SAYS SO in a warning, because the defaults are
 * the safe direction: both layers off means a configuration the daemon cannot
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
  type WardenLogin,
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

/** The investigation login in effect, and the failover order it heads. */
export interface ResolvedWardenLogin {
  /** What the Warden selects from: the stored order, the machine's default runtime, or nothing. */
  readonly accounts: readonly WardenAccount[];
  readonly login: WardenLogin;
  /** At least one of {@link accounts} is a login this machine has — or the inventory is unreadable. */
  readonly usable: boolean;
}

/**
 * Which login an investigation runs on, decided at READ time.
 *
 * NOTHING IS COMPILED IN. The owner's own failover order wins; an empty one means they never chose, so
 * the machine's default runtime — whatever `machine.yaml` names today — stands in, and is never
 * written back, so changing the default later moves the Warden with it. With neither, the login is
 * `not_set` and nothing is invented: a name from somebody else's machine is worse than no name,
 * because it fails only once money is about to be spent.
 *
 * A named login this machine does not have is `unknown`. It stays in the owner's file untouched and is
 * skipped by selection, which already refuses an account the inventory omits. An EMPTY inventory
 * condemns nobody: it means the inventory is unreadable, not that every login vanished.
 */
export function resolveWardenLogin(
  config: WardenConfig,
  installedAgents: readonly string[],
  defaultRuntime: string | undefined,
): ResolvedWardenLogin {
  const configured = normalizeWardenAccounts(config.accounts);
  const fallback = defaultRuntime?.trim() ?? '';
  const source: WardenLogin['source'] =
    configured.length > 0 ? 'configured' : fallback === '' ? 'not_set' : 'machine_default';
  const accounts = source === 'machine_default' ? [{ agent: fallback }] : configured;
  const known = (agent: string): boolean => installedAgents.length === 0 || installedAgents.includes(agent);
  return {
    accounts,
    login: {
      source,
      unknown: accounts.filter(account => !known(account.agent)).map(account => account.agent),
      available: [...installedAgents],
    },
    usable: accounts.some(account => known(account.agent)),
  };
}

/**
 * What an operator should know about the configuration they have.
 *
 * An unknown login WARNS and is never rejected: the fleet installer may be about
 * to create it, and refusing the configuration would order-couple two tools that
 * have no reason to know about each other. Nor is it rewritten away: the owner
 * chooses another in Settings › Warden.
 *
 * The login warnings are only said while the LLM layer is on: with investigations off nothing needs a
 * login, and "no login is set" would be a problem the owner has no reason to fix.
 */
export function wardenConfigWarnings(config: WardenConfig, resolved: ResolvedWardenLogin): readonly string[] {
  const warnings: string[] = [];
  if (config.layers.llm) warnings.push(...loginWarnings(resolved));
  if (!config.enabled)
    warnings.push('the Warden is off (enabled=false); detection still runs, but nothing is triaged or acted on');
  return warnings;
}

/** What is wrong with the investigation login, in the operator's words. */
function loginWarnings(resolved: ResolvedWardenLogin): readonly string[] {
  const warnings: string[] = [];
  if (resolved.login.source === 'not_set')
    warnings.push(
      'no investigation login is set and this machine has no default runtime, so LLM investigations are unavailable — choose a login in Settings › Warden',
    );
  for (const agent of resolved.login.unknown)
    warnings.push(`unknown login '${agent}' — choose one in Settings › Warden (it is skipped until it exists here)`);
  if (resolved.accounts.length > 0 && !resolved.usable)
    warnings.push('no investigation login exists on this machine, so LLM investigations are unavailable');
  return warnings;
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
