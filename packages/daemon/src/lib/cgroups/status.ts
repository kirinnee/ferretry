/**
 * What the last save could NOT put into force, kept where the next read is certain to find it.
 *
 * WHY THIS DOCUMENT EXISTS AT ALL. A save persists the operator's intent even when the host manager
 * refuses the live apply — that is deliberate, and `service.ts` says why. But the refusal itself
 * used to live only in the answer to the PATCH that produced it: the restart requirement was
 * recomputed from placement SHAPE on every later read, and a session that kept its old cap because
 * the write was refused still has a scope and still has enforcement on, so the very next GET called
 * it current. One page refresh, or one daemon restart, and the only record that a running agent is
 * bounded by numbers nobody asked for was gone. That is the absent-evidence-read-as-a-benign-result
 * failure this whole surface is written against, so the evidence is durable now.
 *
 * WHAT SUPERSEDES IT. A save, and nothing else. Every save rewrites this document with its OWN
 * outcome — an empty record when everything applied — because a save is the one operation that
 * re-attempts every write this record is about. A read never rewrites it: a GET that pruned its own
 * evidence would be a write on the read path, contending with the barrier every save takes, and a
 * concurrent save would then be racing a reader for one file.
 *
 * A SCOPE SUPERSEDES ITSELF BY BEING RELAUNCHED. Each per-session entry names the exact scope the
 * write was refused for, and a scope name carries a per-launch nonce — so a session found in a
 * DIFFERENT scope is provably a new incarnation that was launched with the saved limits, and the
 * old entry stops applying to it without anyone having to clear it. A session that is no longer
 * live says nothing either. Both fall out of matching rather than out of a rule someone maintains.
 *
 * TOLERANT ON READ, in the conservative direction. A record that cannot be read is not an empty
 * one: it is the state where this daemon cannot say which sessions hold the saved limits, so every
 * governed session is reported restart-required until a save re-establishes the truth.
 *
 * Pure: no IO, no clock, no globals.
 */

import { type CgroupConfig, CgroupConfigSchema } from '@ferretry/protocol';
import { z } from 'zod';
import { CgroupDocumentReadFailure, cgroupIssueSummary } from './config.ts';

/** One managed scope whose own property write the host manager refused. */
export interface CgroupScopeApplyFailure {
  readonly sessionId: string;
  /** The exact scope the write was refused for, nonce included — see the header for why that is
   *  what makes a relaunch supersede this entry by itself. */
  readonly scope: string;
  /** The manager's own words. */
  readonly failure: string;
}

/** One pane whose identity or placement was not safe enough to receive a property write. */
export interface CgroupUnprovenApply {
  readonly sessionId: string;
  /** The evidence the pane ledger or placement reader could not establish. */
  readonly failure: string;
}

/** Everything the last save could not apply live. */
export interface CgroupApplyStatus {
  /** The exact saved intent this outcome belongs to. A status for any other config is stale. */
  readonly config: CgroupConfig;
  /** Set exactly when the fleet aggregate itself could not be configured, in which case nothing
   *  beneath it was attempted and `scopes` is empty. */
  readonly fleet?: string;
  readonly scopes: readonly CgroupScopeApplyFailure[];
  /** Named panes the save could not safely address. They remain conservative until another save. */
  readonly unproven: readonly CgroupUnprovenApply[];
  /** Set when the ledger could not enumerate its complete population, or a save did not finish. */
  readonly incomplete?: string;
}

/** The record a save that applied everything leaves behind. Written rather than deleted: beside
 *  enabled intent, absence is interrupted/legacy evidence and cannot establish a clean apply;
 *  only this exact-config record proves the save finished. */
export function cleanCgroupApplyStatus(config: CgroupConfig): CgroupApplyStatus {
  return { config, scopes: [], unproven: [] };
}

/**
 * Write-ahead evidence placed before the config document changes or any host write begins.
 *
 * It is deliberately a valid, conservative record. If the daemon exits anywhere in the save, a
 * later GET sees either a config mismatch or this incomplete marker; an identical-config retry can
 * therefore never leave an older clean outcome masquerading as the result of the interrupted save.
 */
export function pendingCgroupApplyStatus(config: CgroupConfig): CgroupApplyStatus {
  return {
    config,
    scopes: [],
    unproven: [],
    incomplete: 'the last resource-limit save did not finish recording its live apply outcome',
  };
}

const CgroupScopeApplyFailureSchema = z.object({
  sessionId: z.string().min(1),
  scope: z.string().min(1),
  failure: z.string().min(1),
});

const CgroupUnprovenApplySchema = z.object({
  sessionId: z.string().min(1),
  failure: z.string().min(1),
});

const CgroupApplyStatusSchema = z.object({
  config: CgroupConfigSchema,
  fleet: z.string().min(1).optional(),
  scopes: z.array(CgroupScopeApplyFailureSchema).readonly().default([]),
  unproven: z.array(CgroupUnprovenApplySchema).readonly().default([]),
  incomplete: z.string().min(1).optional(),
});

export interface StoredCgroupApplyStatus {
  readonly status: CgroupApplyStatus;
  /** True when the record is present and could not be used as written, so nothing about the last
   *  apply is established by it. */
  readonly unreadable: boolean;
  /** Non-empty exactly when `unreadable` is true; the operator's version of why. */
  readonly warnings: readonly string[];
}

/**
 * The evidence a persisted record means.
 *
 * Absent is ordinary only while the expected intent is disabled, as on a daemon that has never
 * saved. Beside enabled intent it is conservative unknown evidence: an interrupted or legacy save
 * must not be called clean. A document that is present and invalid is conservative in either state
 * — see the header.
 */
export function parseStoredCgroupApplyStatus(value: unknown, expected: CgroupConfig): StoredCgroupApplyStatus {
  const clean = cleanCgroupApplyStatus(expected);
  if (value === undefined || value === null)
    return expected.enabled
      ? {
          status: clean,
          unreadable: true,
          warnings: [
            'the record of what the saved limits reached is absent, so no live session can be reported as holding them; save the resource limits again to establish it',
          ],
        }
      : { status: clean, unreadable: false, warnings: [] };
  if (value instanceof CgroupDocumentReadFailure)
    return {
      status: clean,
      unreadable: true,
      warnings: [
        `the record of what the last save could apply could not be read (${value.message}), so no live session can be reported as holding the saved limits; save the resource limits again to re-establish it`,
      ],
    };
  const parsed = CgroupApplyStatusSchema.safeParse(value);
  if (parsed.success && cgroupConfigsEqual(parsed.data.config, expected))
    return { status: parsed.data, unreadable: false, warnings: [] };
  if (parsed.success)
    return {
      status: clean,
      unreadable: true,
      warnings: [
        'the record of what the last save could apply belongs to a different resource-limit configuration, so no live session can be reported as holding the saved limits; save again to re-establish it',
      ],
    };
  return {
    status: clean,
    unreadable: true,
    warnings: [
      `the record of what the last save could apply did not validate (${cgroupIssueSummary(parsed.error.issues)}), so no live session can be reported as holding the saved limits; save the resource limits again to re-establish it`,
    ],
  };
}

function cgroupConfigsEqual(left: CgroupConfig, right: CgroupConfig): boolean {
  return (
    left.enabled === right.enabled &&
    left.fleet.cpuPercent === right.fleet.cpuPercent &&
    left.fleet.memoryPercent === right.fleet.memoryPercent &&
    left.perAgent.cpuPercent === right.perAgent.cpuPercent &&
    left.perAgent.memoryPercent === right.perAgent.memoryPercent
  );
}

/** The one sentence a refused aggregate is reported by, wherever it is reported from. It has to say
 *  three things at once: the document DID change, the numbers are not on the host, and a launch
 *  will now refuse rather than quietly run uncapped. */
export function fleetApplyWarning(failure: string, slice: string): string {
  return `${failure} — the saved limits are stored but are not in force on ${slice}; every running session keeps whatever it was launched with, and new launches stay fail-closed until the host manager answers or enforcement is turned off. Save again once it does.`;
}

/** The one sentence a refused scope is reported by. */
export function scopeApplyWarning(scope: CgroupScopeApplyFailure): string {
  return `${scope.sessionId}: ${scope.failure} — ${scope.scope} still holds the limits it was launched with; relaunch it to pick up the saved values.`;
}

/** The minimum one live pane has to say for the recorded evidence to be read against it. */
export interface LivePlacementFacts {
  readonly sessionId: string;
  /** The managed scope it is in, when it is in one. */
  readonly scope?: string;
  readonly exempt: boolean;
}

/**
 * What a persisted record still says about the sessions that are live NOW.
 *
 * Exempt sessions are never named: an aggregate this daemon could not configure says nothing about
 * a session it never puts inside that aggregate.
 */
export function unappliedCgroupEvidence(input: {
  readonly stored: StoredCgroupApplyStatus;
  readonly placements: readonly LivePlacementFacts[];
  readonly slice: string;
}): { readonly restart: readonly string[]; readonly warnings: readonly string[] } {
  if (!input.stored.status.config.enabled) return { restart: [], warnings: [] };
  const governedPlacements = input.placements.filter(placement => !placement.exempt);
  const governed = governedPlacements.map(placement => placement.sessionId);
  if (input.stored.unreadable) return { restart: governed, warnings: [] };
  const restart = new Set<string>();
  const warnings: string[] = [];
  if (input.stored.status.incomplete !== undefined) {
    for (const sessionId of governed) restart.add(sessionId);
    warnings.push(
      `${input.stored.status.incomplete}; no live session can be reported as holding the saved limits until the operator saves them again`,
    );
  }
  if (input.stored.status.fleet !== undefined) {
    for (const sessionId of governed) restart.add(sessionId);
    warnings.push(fleetApplyWarning(input.stored.status.fleet, input.slice));
  }
  const unproven = input.stored.status.unproven.filter(entry =>
    governedPlacements.some(placement => placement.sessionId === entry.sessionId),
  );
  for (const entry of unproven) {
    restart.add(entry.sessionId);
    warnings.push(
      `${entry.sessionId}: the last save could not prove a safe live pane to update (${entry.failure}); save the resource limits again once the pane ledger is healthy`,
    );
  }
  const live = input.stored.status.scopes.filter(scope =>
    input.placements.some(
      placement => placement.sessionId === scope.sessionId && placement.scope === scope.scope && !placement.exempt,
    ),
  );
  for (const scope of live) {
    restart.add(scope.sessionId);
    warnings.push(scopeApplyWarning(scope));
  }
  return { restart: [...restart], warnings };
}
