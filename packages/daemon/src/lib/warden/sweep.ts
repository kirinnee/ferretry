/**
 * The warden sweep runtime — the thing that actually PRODUCES reports.
 *
 * Everything else in this directory was built and never reached: the detector,
 * the sus classifiers, the concurrency gate, the blessings, the failover
 * selector, the provenance recorder and the verdict parser all passed their tests
 * while `world.wardenReports` was a factory nothing called. This service is the
 * loop that joins them, and it is what turns four allowlisted modules into a
 * capability the product has.
 *
 * ═══ THE DOCTRINE THIS WHOLE FILE IS ORGANISED AROUND ═══
 *
 * The warden decides whether agents are healthy and can trigger failover. On
 * MISSING OR AMBIGUOUS EVIDENCE IT MUST REFUSE TO BLESS, NEVER DEFAULT TO
 * HEALTHY. Concretely, in this file:
 *
 * - A blessing is granted only from a report that was READ and classified
 *   `cleared`. A missing report, an unreadable one, or one whose verdict does not
 *   parse grants nothing — the target is re-investigated, which costs a session,
 *   rather than skipped, which costs the fleet.
 * - `lastSweepAt` is written only when a sweep actually completed. A status
 *   response with no `lastSweepAt` means "we do not know", and it must never be
 *   confusable with "we looked and everything is fine".
 * - A configuration that would not parse leaves escalation off, so the daemon
 *   cannot spend sessions on evidence it does not understand.
 * - An exhausted account list does NOT consume the spawn gap or the suppression
 *   fingerprint. Every configured account being ineligible is a reason the check
 *   did not happen, so the very next sweep after any account recovers must be
 *   able to escalate immediately.
 *
 * ═══ THE TWO SPAWN SITES SHARE ONE BUDGET ═══
 *
 * A fleet-sweep warden triages the whole anomaly set; an assigned warden
 * investigates one suspect session. Both draw down `maxAssignedWardens` through
 * `concurrency.ts`, because when each counted its own, a sweep warden plus the
 * assigned cap put several expensive sessions on the host at once — exactly what
 * the cap exists to prevent.
 *
 * ═══ WHAT IS NOT HERE, AND WHY ═══
 *
 * - PROVIDER OUTAGE detection. `provider_unavailable` is in the anomaly
 *   vocabulary and this sweep never produces one: the classifier reads the final
 *   rows of each session's pane, and no route or adapter in this daemon captures
 *   a pane snapshot (survey section H). Producing the anomaly from weaker
 *   evidence would be the failure mode the doctrine above forbids.
 * - MIGRATE CANDIDATES. The sweep prompt can carry a precomputed list of
 *   same-harness accounts for a quota-blocked session, and this sweep supplies
 *   none, because no candidate ranker exists in this daemon yet. The prompt
 *   forbids migrating to an account outside the list, so an absent list means no
 *   migration rather than a guessed one — the safe direction.
 * - ATTENTION SUPPRESSION OF AN ANOMALY. A flagged session is re-reported each
 *   sweep even while it already carries a durable escalation of the same class.
 *   That is noise rather than a wrong decision, and the alternative is worse:
 *   letting a board row remove an anomaly would make Attention an input to
 *   detection, which is precisely what this sweep must never allow. See
 *   `reconcileEscalations`, which reads boards only AFTER detection and writes
 *   only to them.
 */

import type { WardenAnomaly, WardenDetectResult } from './detect.ts';
import type {
  AttentionSource,
  WardenAnomaly as WireWardenAnomaly,
  WardenConfigView,
  WardenFailoverStatus,
  WardenRunView,
  WardenStatusView,
} from '@ferretry/protocol';
import {
  applyWardenConfigPatch,
  assignedCooldownMs,
  parseStoredWardenConfig,
  spawnGapMs,
  sweepIntervalMs,
  wardenAccountsOf,
  wardenConfigWarnings,
  wardenDetectOptions,
  type WardenConfig,
  type WardenConfigPatch,
} from './config.ts';
import { blessingTtlMs, isAnomalyBlessed, reconcileBlessings, recordBlessing, type BlessingStore } from './bless.ts';
import { decideAssignedWardens, wardenSlotsFree, type LiveWarden } from './concurrency.ts';
import { detectAnomalies, fingerprintAnomalies, isWardenScannableStatus } from './detect.ts';
import {
  planWardenEscalations,
  planWardenRemedy,
  type WardenEscalationBoard,
  type WardenEscalationRaise,
  type WardenEscalationVerdict,
} from './escalation.ts';
import {
  classifyWardenFailure,
  effectiveFailoverConfig,
  ineligibilityReason,
  isDemoted,
  reconcileDemotions,
  recordWardenFailure,
  recordWardenSuccess,
  selectWardenAccount,
  type WardenAccount,
  type WardenAccountHealth,
  type WardenFailoverState,
} from './failover.ts';
import {
  buildWardenSpawnProvenance,
  type WardenSelectionProvenance,
  type WardenSpawnFacts,
  type WardenSpawnProvenance,
} from './provenance.ts';
import { buildAssignedWardenPrompt, buildWardenSweepPrompt, type WardenPromptSettings } from './prompt.ts';
import {
  parseWardenRuntimeState,
  recordSweepFingerprint,
  spawnSuppressionKey,
  wardenMayStop,
  type WardenAssignmentRecord,
  type WardenRuntimeState,
} from './state.ts';
import { isTerminalStatus, WARDEN_LABEL, type WardenSessionView } from './types.ts';
import { classifyVerdict } from './verdicts.ts';

/** One session as the sweep reads it: the detector's view, plus where its
 *  evidence lives so a warden can be told to go and read it. */
export interface WardenFleetSession extends WardenSessionView {
  /** The session's own private directory inside the state home. */
  readonly directory: string;
  /** Where the agent is working. */
  readonly cwd?: string;
  readonly turn?: number;
}

/** Everything the daemon knows, live and terminal. Terminal history matters:
 *  a peer wait whose peer is a finished session is unanswerable, and telling
 *  that apart from a typo needs the whole index. */
export interface WardenFleetReader {
  fleet(): Promise<readonly WardenFleetSession[]>;
}

export interface WardenSpawnRequest {
  readonly agent: string;
  readonly model?: string;
  readonly name: string;
  readonly prompt: string;
  readonly cwd: string;
  /**
   * Unguessable per-assignment secret exported into this warden's own terminal.
   *
   * Absent for the fleet-sweep warden, which guards no single target. Present for
   * an assigned warden, and it is the ONLY thing that authorizes it to stop the
   * one session it was sent to look at.
   */
  readonly stopCapability?: string;
}

/** Putting a warden on the host. Its real implementation is the ordinary session
 *  start, so a warden is an ordinary managed session that happens to carry the
 *  warden label — which is what lets the detector's lineage shield see it. */
export interface WardenSpawner {
  spawn(request: WardenSpawnRequest): Promise<WardenSpawnFacts>;
}

/** Report artefacts on disk: the provenance sidecar this daemon owns, and the
 *  report a finished warden left behind. */
export interface WardenArtifacts {
  writeProvenance(reportPath: string, provenance: WardenSpawnProvenance): Promise<void>;
  readReport(reportPath: string): Promise<string | undefined>;
  /** The newest report, for the status surface: its identity and its first lines. */
  latest(): Promise<{ readonly reportId: string; readonly head: string } | undefined>;
  /** Absolute path for a report written at `at`, optionally about `targetId`. */
  reportPath(at: string, targetId?: string): string;
}

export interface WardenStateStore {
  read(): Promise<unknown>;
  write(state: WardenRuntimeState): Promise<void>;
}

export interface WardenConfigStore {
  read(): Promise<unknown>;
  write(config: WardenConfig): Promise<void>;
}

/** Accounts actually installed on this host. An empty answer means the inventory
 *  is unreadable — evidence about the host, never about an account. */
export interface WardenAgentInventory {
  installed(): Promise<readonly string[]>;
}

export interface WardenUsageReader {
  accounts(): Promise<readonly WardenAccountHealth[]>;
}

/** Where a supervision decision is recorded for a human to read later. Fleet-wide
 *  rather than per session: most of these are about the warden, not about any one
 *  agent. */
export interface WardenJournal {
  record(type: string, data: Readonly<Record<string, unknown>>): void;
}

/**
 * The warden's own finished reports, parsed into verdicts.
 *
 * TOTAL BY CONTRACT: `undefined` means the reports could not be read, which is
 * NOT the same as "no warden asked for a human". A short list read from a
 * partially unreadable directory would silently resolve live escalations, so the
 * sweep is told it is blind and reconciles nothing that pass.
 */
export interface WardenVerdictReader {
  recent(): Promise<readonly WardenEscalationVerdict[] | undefined>;
}

/** How the daemon's raise or refresh landed. */
export type WardenAttentionWrite = 'created' | 'refreshed' | 'unchanged' | 'rejected';

/**
 * The ONE attention store, reached through the same service every other caller
 * uses — never a second board of the warden's own.
 *
 * Every method is total: a board that cannot be read is `undefined`, a write
 * that the state machine refuses is `rejected`. A throw here would abort a sweep
 * that has already completed its real work.
 */
export interface WardenAttentionPort {
  board(sessionId: string): Promise<WardenEscalationBoard | undefined>;
  raise(sessionId: string, request: WardenEscalationRaise): Promise<WardenAttentionWrite>;
  resolveSource(sessionId: string, source: AttentionSource, sourceRef: string, note: string): Promise<boolean>;
}

export interface WardenSweepPorts {
  readonly fleet: WardenFleetReader;
  readonly spawner: WardenSpawner;
  readonly artifacts: WardenArtifacts;
  readonly state: WardenStateStore;
  readonly config: WardenConfigStore;
  readonly agents: WardenAgentInventory;
  readonly usage: WardenUsageReader;
  /** Read AFTER detection, for the escalation reconciliation only. */
  readonly verdicts: WardenVerdictReader;
  /** Written AFTER detection, for the escalation reconciliation only. */
  readonly attention: WardenAttentionPort;
  readonly journal: WardenJournal;
  /** Wall-clock milliseconds. */
  readonly nowMs: () => number;
  /** Unguessable per-assignment capabilities. */
  readonly capabilities: () => string;
}

export interface WardenSweepSettings extends WardenPromptSettings {
  /** Where a warden session itself runs — the state home, not any agent's
   *  workspace, so a warden can never be mistaken for work on a repository. */
  readonly wardenCwd: string;
  /**
   * Whether this daemon runs per-session monitors at all.
   *
   * NOT a detail: the detector's `dead_monitor` class asks "does this running
   * session have a live monitor handle", and in a daemon with no monitor
   * subsystem the answer is no for every session — so a raw sweep reports the
   * entire live fleet as broken, once per session, every five minutes. See
   * `collapseUnsupervisedMonitors` for what is done about it and why the answer is
   * not to suppress the evidence.
   */
  readonly supervisesMonitors: boolean;
}

/** Stable identity for the one fault "this daemon watches nothing" is. */
export const UNSUPERVISED_FLEET_KEY = 'daemon:no-monitor-subsystem';

/**
 * Restate per-session `dead_monitor` anomalies as the ONE daemon-level fault they
 * are when no monitor subsystem is mounted.
 *
 * WHY NOT JUST DROP THEM. Because a sweep over an unwatched fleet would then read
 * as clean, which is the exact failure this subsystem exists to prevent. Every
 * affected session id is carried on the single anomaly, so nothing is hidden — the
 * evidence is reported once, as one fault, instead of N times as N faults.
 *
 * WHY NOT PASS `hasLiveMonitor: true` INSTEAD. That would be a lie in the
 * dangerous direction twice over: it would report the fleet as watched, and it
 * would switch on the sus classifiers, which reason over a liveness ledger that
 * nothing updates in a daemon with no monitor. Verdicts from a frozen ledger are
 * worse than no verdicts.
 *
 * The fingerprint of the collapsed anomaly is keyed on `fleetKey`, so it is stable
 * across sweeps and across changes in which sessions are running: escalating once
 * about a permanent structural gap is right, and escalating every sweep is not.
 */
export function collapseUnsupervisedMonitors(
  anomalies: readonly WardenAnomaly[],
  supervisesMonitors: boolean,
): readonly WardenAnomaly[] {
  if (supervisesMonitors) return anomalies;
  const unmonitored = anomalies.filter(anomaly => anomaly.kind === 'dead_monitor');
  if (unmonitored.length === 0) return anomalies;
  const affected = unmonitored.map(anomaly => anomaly.sessionId).toSorted();
  const anchor = unmonitored.find(anomaly => anomaly.sessionId === affected[0]) ?? unmonitored[0];
  return [
    ...anomalies.filter(anomaly => anomaly.kind !== 'dead_monitor'),
    {
      kind: 'dead_monitor',
      // A required field, so it names the lowest affected id rather than nothing:
      // the fleet key above is what dedup and the fingerprint actually key on.
      sessionId: affected[0] as string,
      fleetKey: UNSUPERVISED_FLEET_KEY,
      affectedSessionIds: affected,
      status: anchor?.status ?? 'running',
      detail: `this daemon runs no per-session monitor subsystem, so no turn is watched — ${affected.length} active session${affected.length === 1 ? '' : 's'} unsupervised`,
    },
  ];
}

/** The one field the run view carries that is not an anomaly list. */
interface EscalationOutcome {
  readonly spawned?: string;
  readonly message?: string;
}

const failureMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * An anomaly as the wire declares it.
 *
 * The domain's own arrays are `readonly`, because a detector result must not be
 * editable by whoever reads it; the protocol's are not. Copying at the boundary
 * is the whole conversion — one place, so nothing downstream is tempted to widen
 * the domain type to match a serialization detail.
 */
function wireAnomaly(anomaly: WardenAnomaly): WireWardenAnomaly {
  const { affectedSessionIds, ledger, ...rest } = anomaly;
  return {
    ...rest,
    ...(affectedSessionIds === undefined ? {} : { affectedSessionIds: [...affectedSessionIds] }),
    ...(ledger === undefined ? {} : { ledger: { ...ledger } }),
  };
}

/**
 * The sweep, the status read and the configuration surface.
 *
 * SERIALIZED BY THE CALLER'S CHAIN, not by a lock in here: every mutation of the
 * durable state happens inside one `run`, and two overlapping runs would each
 * read the state before the other wrote it, so the second would resurrect the
 * first's already-spent spawn gap. The mount owns that chain because it also owns
 * the timer that fires the periodic run.
 */
export class WardenSweepService {
  constructor(
    private readonly ports: WardenSweepPorts,
    private readonly settings: WardenSweepSettings,
  ) {}

  /** The configuration as an operator reads it, with everything they should know
   *  about it. */
  async view(): Promise<WardenConfigView> {
    const stored = parseStoredWardenConfig(await this.ports.config.read());
    const installed = await this.installedAgents();
    return {
      config: stored.config,
      accounts: [...wardenAccountsOf(stored.config)],
      warnings: [...stored.warnings, ...wardenConfigWarnings(stored.config, installed)],
    };
  }

  /**
   * Apply an operator patch and persist it.
   *
   * The patch merges onto what is STORED rather than onto the defaults, so two
   * successive single-field patches compose. A stored document that did not parse
   * merges onto the defaults instead — which is the same fallback the loader
   * makes, so a PATCH can repair a broken document rather than being blocked by
   * it.
   */
  async updateConfig(patch: WardenConfigPatch): Promise<WardenConfigView> {
    const stored = parseStoredWardenConfig(await this.ports.config.read());
    const next = applyWardenConfigPatch(stored.config, patch);
    await this.ports.config.write(next);
    this.ports.journal.record('fleet.warden_config_changed', { fields: Object.keys(patch) });
    return {
      config: next,
      accounts: [...wardenAccountsOf(next)],
      warnings: [...wardenConfigWarnings(next, await this.installedAgents())],
    };
  }

  /**
   * What the LAST sweep found, never a fresh probe.
   *
   * A status route that goes and measures is a status route that hangs when the
   * thing it measures does, and this one is read by the surface an operator turns
   * to when the fleet is already struggling. `lastSweepAt` is absent until a
   * sweep has completed, which is what lets a caller tell "nothing has run" from
   * "a sweep ran and found nothing".
   */
  async status(): Promise<WardenStatusView> {
    const stored = parseStoredWardenConfig(await this.ports.config.read());
    const state = parseWardenRuntimeState(await this.ports.state.read());
    const fleet = await this.ports.fleet.fleet();
    const liveWarden = this.liveWardens(fleet, state)[0]?.wardenId;
    return {
      config: stored.config,
      ...(state.lastSweepAt === undefined ? {} : { lastSweepAt: state.lastSweepAt }),
      anomalies: (state.lastAnomalies ?? []).map(wireAnomaly),
      fingerprint: state.lastFingerprint ?? '',
      ...(liveWarden === undefined ? {} : { liveWarden }),
      ...(state.lastSpawnAt === undefined ? {} : { lastSpawnAt: state.lastSpawnAt }),
      ...(await this.latestReportField()),
      failover: await this.failoverStatus(stored.config, state.failover ?? {}),
    };
  }

  /**
   * One sweep.
   *
   * `force` is a manual `warden run --spawn`: it bypasses the enabled flag, the
   * spawn gap and the fingerprint suppression, because an operator asking for a
   * check now has already made the decision those gates exist to make for them.
   * It does NOT bypass the concurrency cap or account eligibility — those protect
   * the host and the accounts, not the operator's patience.
   */
  async run(options: { readonly force: boolean }): Promise<WardenRunView> {
    const stored = parseStoredWardenConfig(await this.ports.config.read());
    const config = stored.config;
    const fleet = await this.ports.fleet.fleet();
    const nowMs = this.ports.nowMs();
    const at = new Date(nowMs).toISOString();

    const scannable = fleet.filter(session => isWardenScannableStatus(session.state.status));
    const raw = detectAnomalies(scannable, nowMs, wardenDetectOptions(config), fleet);
    const collapsed = collapseUnsupervisedMonitors(raw.anomalies, this.settings.supervisesMonitors);
    const detected: WardenDetectResult = { anomalies: collapsed, fingerprint: fingerprintAnomalies(collapsed) };

    let state = parseWardenRuntimeState(await this.ports.state.read());
    state = this.pruneBlessings(state, fleet, nowMs);
    state = recordSweepFingerprint(state, detected.fingerprint);
    state = { ...state, lastSweepAt: at, lastAnomalies: detected.anomalies };
    await this.ports.state.write(state);

    const assigned = await this.runAssigned({
      anomalies: detected.anomalies.filter(anomaly => anomaly.assignedWarden === true),
      fleet,
      config,
      state,
      at,
      force: options.force,
    });
    state = assigned.state;

    const escalated = await this.escalate({
      anomalies: detected.anomalies.filter(anomaly => anomaly.assignedWarden !== true),
      fingerprint: detected.fingerprint,
      fleet,
      config,
      state,
      at,
      force: options.force,
    });
    await this.ports.state.write(escalated.state);

    // LAST, and deliberately so. Everything above — detection, the report
    // prompts, the spawn gates — has already been decided and persisted before
    // a single attention board is opened, which is what makes "ordinary
    // Attention cannot affect the scan" a property of the ORDER rather than a
    // promise. Moving this call earlier would break it.
    await this.reconcileEscalations(detected.anomalies, fleet);

    return {
      sweptAt: at,
      anomalies: detected.anomalies.map(wireAnomaly),
      ...escalated.outcome,
      ...(assigned.spawned.length === 0 ? {} : { assignedWardens: [...assigned.spawned] }),
    };
  }

  /** How often the timer that drives this should fire. */
  async intervalMs(): Promise<number> {
    return sweepIntervalMs(parseStoredWardenConfig(await this.ports.config.read()).config);
  }

  /** The last completed sweep, for the daemon's own health report. */
  async lastSweepAt(): Promise<string | undefined> {
    return parseWardenRuntimeState(await this.ports.state.read()).lastSweepAt;
  }

  /**
   * True when this capability is the secret minted for `targetId`'s live
   * assignment — the only case a warden-held credential may stop a session.
   *
   * Read from the durable state on every call rather than from a cache, so an
   * assignment reconciled away by the last sweep stops authorizing immediately
   * and a daemon restart does not amnesty one.
   */
  async mayStop(capability: string, targetId: string): Promise<boolean> {
    return wardenMayStop(parseWardenRuntimeState(await this.ports.state.read()), capability, targetId);
  }

  // ─── sweep internals ────────────────────────────────────────────────────────

  /**
   * Drop blessings that lapsed, whose session changed status, or whose session
   * vanished — BEFORE anything can be skipped on the strength of one.
   *
   * The early revocation is journalled: a session that STOPS being skipped must
   * be explicable rather than mysterious.
   */
  private pruneBlessings(
    state: WardenRuntimeState,
    fleet: readonly WardenFleetSession[],
    nowMs: number,
  ): WardenRuntimeState {
    const statuses = new Map(fleet.map(session => [session.config.id, session.state.status]));
    const pruned = reconcileBlessings(state.blessings ?? {}, statuses, nowMs);
    for (const sessionId of pruned.revoked) this.ports.journal.record('fleet.warden_bless_revoked', { sessionId });
    return { ...state, blessings: pruned.store };
  }

  /** Every live warden fleet-wide, assigned and sweep alike — the one budget both
   *  spawn sites draw down. */
  private liveWardens(fleet: readonly WardenFleetSession[], state: WardenRuntimeState): readonly LiveWarden[] {
    const targetByWarden = new Map<string, string>();
    for (const [targetId, record] of Object.entries(state.assignments ?? {}))
      targetByWarden.set(record.wardenId, targetId);
    return fleet
      .filter(session => session.config.label === WARDEN_LABEL && !isTerminalStatus(session.state.status))
      .map(session => {
        const targetId = targetByWarden.get(session.config.id);
        return { wardenId: session.config.id, ...(targetId === undefined ? {} : { targetId }) };
      });
  }

  /**
   * Reconcile finished assignments, then spawn what the gate allows.
   *
   * The reconciliation runs even when there is nothing to spawn and even when
   * escalation is disabled: a finished warden left in the assignment record holds
   * its target's slot forever and reads as "still under investigation" on every
   * surface that joins the two.
   */
  private async runAssigned(input: {
    readonly anomalies: readonly WardenAnomaly[];
    readonly fleet: readonly WardenFleetSession[];
    readonly config: WardenConfig;
    readonly state: WardenRuntimeState;
    readonly at: string;
    readonly force: boolean;
  }): Promise<{ readonly state: WardenRuntimeState; readonly spawned: readonly string[] }> {
    const byId = new Map(input.fleet.map(session => [session.config.id, session]));
    const queued = input.state.assignedQueue ?? [];
    const held = Object.keys(input.state.assignments ?? {}).length > 0;
    if (input.anomalies.length === 0 && queued.length === 0 && !held) return { state: input.state, spawned: [] };

    const reconciled = await this.reconcileAssignments(input.state, byId, input.config, input.at);
    let state = reconciled.state;
    // Escalation off: the reconciliation above still had to happen, and its
    // result is persisted, but nothing new is spawned.
    if (!input.force && !input.config.enabled) {
      await this.ports.state.write(state);
      return { state, spawned: [] };
    }

    const nowMs = this.ports.nowMs();
    const blessings = state.blessings ?? {};
    // A blessed anomaly must not even become a candidate, so it can never occupy
    // the single warden slot. Narrow: the exact kinds a warden cleared, only
    // while the session still holds the status it was cleared in.
    const candidates = input.anomalies.filter(anomaly => {
      const target = byId.get(anomaly.sessionId);
      return target === undefined || !isAnomalyBlessed(blessings, anomaly, target.state.status, nowMs);
    });

    const cooldown = assignedCooldownMs(input.config);
    const assignments = state.assignments ?? {};
    const cooldowns = state.assignedCooldowns ?? {};
    const isStillSuspect = (targetId: string): boolean => {
      const target = byId.get(targetId);
      if (target === undefined || isTerminalStatus(target.state.status)) return false;
      if (assignments[targetId] !== undefined) return false;
      const cooledAt = Date.parse(cooldowns[targetId] ?? '');
      return input.force || !Number.isFinite(cooledAt) || nowMs - cooledAt >= cooldown;
    };

    // A fresh anomaly supersedes a queued copy of the same target: it describes
    // the situation as it is now rather than as it was one sweep ago.
    const anomalyById = new Map<string, WardenAnomaly>();
    for (const anomaly of [...queued, ...candidates]) anomalyById.set(anomaly.sessionId, anomaly);

    const decision = decideAssignedWardens({
      maxConcurrent: input.config.maxAssignedWardens,
      live: this.liveWardens(input.fleet, state),
      candidates: candidates.map(anomaly => anomaly.sessionId),
      queued: queued.map(anomaly => anomaly.sessionId),
      isStillSuspect,
    });

    const spawned: string[] = [];
    /** Targets skipped because every account was ineligible. Queued, never
     *  cooled down, so the next sweep after any account recovers retries them. */
    const deferred: string[] = [];
    let nextAssignments = { ...assignments };
    let nextCooldowns = { ...cooldowns };
    for (const targetId of decision.spawn) {
      const anomaly = anomalyById.get(targetId);
      const target = byId.get(targetId);
      if (anomaly === undefined || target === undefined) continue;
      // Per spawn, so round-robin rotates across targets and fallback re-checks
      // the preferred account every time.
      const picked = await this.pickAccount(input.config, state);
      state = picked.state;
      if (picked.account === undefined) {
        deferred.push(targetId);
        continue;
      }
      const reportPath = this.ports.artifacts.reportPath(input.at, targetId);
      const capability = this.ports.capabilities();
      const result = await this.spawn({
        agent: picked.account.agent,
        ...(picked.account.model === undefined ? {} : { model: picked.account.model }),
        name: `warden:${target.config.teammate ?? targetId}`,
        prompt: buildAssignedWardenPrompt(anomaly, target, reportPath, this.settings),
        cwd: this.settings.wardenCwd,
        stopCapability: capability,
      });
      if (result.facts === undefined) {
        state = this.recordSpawnFailure(state, input.config, picked.account.agent, result.error);
        // The target cooldown damps a genuinely target-scoped failure and stops a
        // same-sweep hot loop; the STRIKE above is what routes the next spawn to
        // another account, which is the fault that actually needs routing.
        nextCooldowns = { ...nextCooldowns, [targetId]: input.at };
        this.ports.journal.record('fleet.warden_spawn_failed', {
          targetId,
          agent: picked.account.agent,
          message: failureMessage(result.error),
        });
        continue;
      }
      await this.writeProvenance(reportPath, result.facts, picked.selection, targetId);
      state = { ...state, failover: recordWardenSuccess(state.failover ?? {}, picked.account.agent) };
      // Only the kind this warden was actually shown. A sibling kind it was never
      // asked about stays visibly unjudged rather than borrowing its verdict.
      nextAssignments = {
        ...nextAssignments,
        [targetId]: {
          wardenId: result.facts.sessionId,
          spawnedAt: input.at,
          capability,
          kinds: [anomaly.kind],
          reportPath,
        },
      };
      spawned.push(result.facts.sessionId);
      this.ports.journal.record('fleet.warden_assigned', {
        wardenId: result.facts.sessionId,
        targetId,
        kind: anomaly.kind,
        reportPath,
      });
    }

    if (decision.dropped.length > 0)
      this.ports.journal.record('fleet.warden_dequeued', { targets: decision.dropped, reason: 'recovered' });

    const carried = [...decision.queue, ...deferred]
      .map(targetId => anomalyById.get(targetId))
      .filter((anomaly): anomaly is WardenAnomaly => anomaly !== undefined);
    state = {
      ...state,
      assignments: nextAssignments,
      assignedCooldowns: nextCooldowns,
      assignedQueue: carried,
    };
    await this.ports.state.write(state);
    return { state, spawned };
  }

  /**
   * Retire assignments whose warden is gone, blessing the target when — and only
   * when — the report it left says the session was CLEARED.
   *
   * This is the doctrine's sharpest edge. A missing report, an unreadable one, or
   * one whose verdict is anything but `cleared` grants no blessing at all: the
   * target is investigated again next sweep. Blessing on absent evidence would
   * make a session that later breaks invisible for the whole blessing lifetime.
   */
  private async reconcileAssignments(
    state: WardenRuntimeState,
    byId: ReadonlyMap<string, WardenFleetSession>,
    config: WardenConfig,
    at: string,
  ): Promise<{ readonly state: WardenRuntimeState }> {
    const assignments = { ...(state.assignments ?? {}) };
    const cooldowns = { ...(state.assignedCooldowns ?? {}) };
    let blessings: BlessingStore = state.blessings ?? {};
    const ttlMs = blessingTtlMs(config.blessMinutes);
    const nowMs = this.ports.nowMs();

    for (const [targetId, record] of Object.entries(assignments)) {
      const warden = byId.get(record.wardenId);
      if (warden !== undefined && !isTerminalStatus(warden.state.status)) continue;
      blessings = await this.blessIfCleared(blessings, targetId, record, byId, nowMs, ttlMs);
      delete assignments[targetId];
      cooldowns[targetId] = at;
    }
    return { state: { ...state, assignments, assignedCooldowns: cooldowns, blessings } };
  }

  private async blessIfCleared(
    blessings: BlessingStore,
    targetId: string,
    record: WardenAssignmentRecord,
    byId: ReadonlyMap<string, WardenFleetSession>,
    nowMs: number,
    ttlMs: number,
  ): Promise<BlessingStore> {
    const target = byId.get(targetId);
    if (target === undefined || record.kinds.length === 0) return blessings;
    const report = await this.ports.artifacts.readReport(record.reportPath).catch(() => undefined);
    if (report === undefined || report.trim() === '') return blessings;
    if (classifyVerdict(report) !== 'cleared') return blessings;
    const next = recordBlessing(
      blessings,
      { sessionId: targetId, kinds: record.kinds, status: target.state.status, wardenId: record.wardenId },
      nowMs,
      ttlMs,
    );
    this.ports.journal.record('fleet.warden_blessed', {
      targetId,
      wardenId: record.wardenId,
      kinds: record.kinds,
      expiresAt: next[targetId]?.expiresAt,
    });
    return next;
  }

  /**
   * The shared fleet-triage escalation.
   *
   * The gates are ordered cheapest-first, and account selection comes LAST on
   * purpose: exhaustion must not consume the spawn gap or the suppression
   * fingerprint, so the very next sweep after an account recovers escalates
   * immediately.
   */
  private async escalate(input: {
    readonly anomalies: readonly WardenAnomaly[];
    readonly fingerprint: string;
    readonly fleet: readonly WardenFleetSession[];
    readonly config: WardenConfig;
    readonly state: WardenRuntimeState;
    readonly at: string;
    readonly force: boolean;
  }): Promise<{ readonly state: WardenRuntimeState; readonly outcome: EscalationOutcome }> {
    const { config, force } = input;
    let state = input.state;
    if (!force && !config.enabled) return { state, outcome: { message: 'escalation disabled (enabled=false)' } };
    if (input.anomalies.length === 0) return { state, outcome: { message: 'no anomalies to escalate' } };

    const live = this.liveWardens(input.fleet, state);
    if (wardenSlotsFree(config.maxAssignedWardens, live.length) <= 0) {
      return {
        state,
        outcome: {
          message: `warden concurrency cap reached (${live.length}/${Math.max(1, config.maxAssignedWardens)} live)`,
        },
      };
    }

    const lastSpawnMs = Date.parse(state.lastSpawnAt ?? '');
    const gap = spawnGapMs(config);
    if (!force && Number.isFinite(lastSpawnMs) && this.ports.nowMs() - lastSpawnMs < gap)
      return { state, outcome: { message: `spawn gap not elapsed (last spawn ${state.lastSpawnAt})` } };

    const key = spawnSuppressionKey(state, input.fingerprint);
    if (!force && key === state.lastSpawnFingerprint)
      return { state, outcome: { message: 'anomaly set unchanged since the last escalation' } };

    const picked = await this.pickAccount(config, state);
    state = picked.state;
    if (picked.account === undefined)
      return { state, outcome: { message: 'every configured warden account is currently ineligible (exhausted)' } };

    const reportPath = this.ports.artifacts.reportPath(input.at);
    const result = await this.spawn({
      agent: picked.account.agent,
      ...(picked.account.model === undefined ? {} : { model: picked.account.model }),
      name: 'warden-sweep',
      prompt: buildWardenSweepPrompt({
        anomalies: input.anomalies,
        sessions: input.fleet,
        reportPath,
        at: input.at,
        settings: this.settings,
      }),
      cwd: this.settings.wardenCwd,
    });
    if (result.facts === undefined) {
      state = this.recordSpawnFailure(state, config, picked.account.agent, result.error);
      // A FAILED launch still consumes the spawn gap, so a persistently broken
      // account cannot be retried every sweep — but NOT the suppression key, so a
      // changed anomaly set can still escalate once the gap elapses.
      state = { ...state, lastSpawnAt: input.at };
      const message = `warden spawn failed: ${failureMessage(result.error)}`;
      this.ports.journal.record('fleet.warden_spawn_failed', { message, agent: picked.account.agent });
      return { state, outcome: { message } };
    }

    await this.writeProvenance(reportPath, result.facts, picked.selection);
    state = {
      ...state,
      failover: recordWardenSuccess(state.failover ?? {}, picked.account.agent),
      lastSpawnAt: input.at,
      lastSpawnFingerprint: key,
    };
    this.ports.journal.record('fleet.warden_spawned', {
      sessionId: result.facts.sessionId,
      count: input.anomalies.length,
      reportPath,
    });
    return { state, outcome: { spawned: result.facts.sessionId } };
  }

  // ─── escalation to a human ──────────────────────────────────────────────────

  /**
   * Raise, refresh and clear the node-scoped Attention a warden's explicit
   * NEEDS_HUMAN verdict earns.
   *
   * RUNS ON EVERY SWEEP, INCLUDING A DISABLED ONE. `enabled: false` stops the
   * daemon SPENDING sessions on new investigations; it does not mean a person
   * should keep staring at an escalation whose node recovered an hour ago. The
   * raise side is inert on a disabled warden anyway, because a disabled warden
   * writes no new reports to be judged from.
   *
   * BOARDS ARE READ FOR THE WHOLE FLEET, one read per session, which is the same
   * order the sweep already pays for the done markers. A durable pointer list of
   * "where we raised something" would be cheaper and would be a second account
   * of a fact the board owns — the failure this reconciliation exists to avoid.
   *
   * A BOARD AND ITS NODE ARE ADDED TOGETHER OR NOT AT ALL, which is what makes
   * `planWardenEscalations` safe to hand two independent lists: every board it
   * receives from here has a node, so its absent-node clearing is unreachable
   * from this caller. A session the fleet reader no longer returns contributes
   * neither, so it is not escalated and not cleared — its row, if it still has
   * one, is simply no longer readable. That is the honest consequence of removal
   * being an observation rather than an act, and it is why nothing here claims to
   * clear a session that has left.
   *
   * A DELETE SERVICE MUST RESOLVE OUTSIDE THE STORAGE RECONCILE, and this is the
   * constraint to meet before writing one. The rows have to be cleared while the
   * board is still authorized, which means before the index row is dropped — but
   * NOT from inside `DaemonStorage.reconcile`, which holds the exclusive storage
   * barrier for its whole body. Authorizing an attention write re-enters storage
   * to read the session documents, and that keyed read waits on the very barrier
   * the reconcile is holding, so the home lock would never be released. Resolve
   * first, outside; retire second.
   */
  private async reconcileEscalations(
    anomalies: readonly WardenAnomaly[],
    fleet: readonly WardenFleetSession[],
  ): Promise<void> {
    const verdicts = await this.ports.verdicts.recent();
    if (verdicts === undefined) {
      // Blind, and said out loud. Reconciling from a partial verdict list would
      // clear live escalations on the strength of reports nobody could read.
      this.ports.journal.record('fleet.warden_escalation_blind', {
        reason: 'the warden reports could not be read, so no escalation was raised or cleared this sweep',
      });
      return;
    }

    const read = await Promise.all(
      fleet.map(async session => ({ session, board: await this.ports.attention.board(session.config.id) })),
    );
    const boards: WardenEscalationBoard[] = [];
    const nodes: WardenFleetSession[] = [];
    for (const { session, board } of read) {
      if (board === undefined) {
        // FAIL CLOSED, PER NODE. A board we could not open is a board whose
        // addressed history we cannot see, and that history is the only thing
        // standing between a verdict a person already answered and the same
        // interruption arriving again. Dropping the node from the plan costs one
        // late escalation; raising without the watermark costs their trust in
        // the board.
        this.ports.journal.record('fleet.warden_escalation_blind_node', {
          sessionId: session.config.id,
          reason: 'this node’s attention board could not be read, so it was neither escalated nor cleared this sweep',
        });
        continue;
      }
      boards.push(board);
      nodes.push(session);
    }

    const plan = planWardenEscalations({
      anomalies,
      nodes,
      verdicts,
      boards,
      remedy: planWardenRemedy({ mayAct: this.settings.mayAct }),
      clientName: this.settings.clientName,
    });

    // Clearing first: a node may recover one class in the same sweep another is
    // raised on, and the two must not race for the board's active capacity.
    for (const resolution of plan.resolve) {
      const cleared = await this.ports.attention.resolveSource(
        resolution.sessionId,
        resolution.source,
        resolution.sourceRef,
        resolution.note,
      );
      if (cleared)
        this.ports.journal.record('fleet.warden_escalation_resolved', {
          sessionId: resolution.sessionId,
          anomalyKind: resolution.anomalyKind,
          sourceRef: resolution.sourceRef,
          reason: resolution.note,
        });
    }

    for (const request of plan.raise) {
      const write = await this.ports.attention.raise(request.sessionId, request);
      if (write === 'rejected') {
        this.ports.journal.record('fleet.warden_escalation_failed', {
          sessionId: request.sessionId,
          anomalyKind: request.anomalyKind,
          sourceRef: request.sourceRef,
        });
        continue;
      }
      // `unchanged` is the steady state of a situation nobody has fixed yet: the
      // item is already there and says the same thing. Recording it every sweep
      // would bury the transitions that mean something.
      if (write === 'unchanged') continue;
      this.ports.journal.record('fleet.warden_escalated', {
        sessionId: request.sessionId,
        anomalyKind: request.anomalyKind,
        sourceRef: request.sourceRef,
        reportPath: request.reportPath,
        change: write,
      });
    }
  }

  // ─── accounts ───────────────────────────────────────────────────────────────

  /**
   * The account the next warden spawn should use, or `undefined` on exhaustion.
   *
   * Demotions are reconciled against the usage feed first, so positive evidence
   * restores an account early rather than making it serve out a cooldown timer
   * whose cause has passed. Exhaustion is reported EDGE-triggered: one event per
   * episode, not one per sweep, or the journal would fill with the same fact.
   */
  private async pickAccount(
    config: WardenConfig,
    state: WardenRuntimeState,
  ): Promise<{
    readonly state: WardenRuntimeState;
    readonly account?: WardenAccount;
    readonly selection: WardenSelectionProvenance;
  }> {
    const accounts = wardenAccountsOf(config);
    const usage = await this.ports.usage.accounts().catch(() => []);
    const nowMs = this.ports.nowMs();
    const reconciled = reconcileDemotions(state.failover ?? {}, usage, nowMs);
    for (const restored of reconciled.restored)
      this.ports.journal.record('fleet.warden_account_restored', { agent: restored.agent, how: restored.how });

    const installed = await this.installedAgents();
    const wasExhausted = reconciled.state.exhaustedSince !== undefined;
    const previous = reconciled.state.lastSelection?.agent;
    const policy = effectiveFailoverConfig(config.failover).policy;
    const configuredFirst = accounts[0]?.agent ?? '';
    const selection = selectWardenAccount({
      accounts,
      failover: config.failover,
      installedAgents: installed,
      usage,
      state: reconciled.state,
      nowMs,
    });

    if (selection.exhausted) {
      if (!wasExhausted)
        this.ports.journal.record('fleet.warden_exhausted', {
          accounts: selection.reasons,
          since: selection.state.exhaustedSince,
        });
      return {
        state: { ...state, failover: selection.state },
        selection: { policy, selection: 'preferred', configuredFirst, skipped: selection.reasons },
      };
    }

    // A failover is a HEALTH-driven change of account. Round-robin rotation is
    // routine and never journalled — the recorded last selection already covers
    // it — so an operator reading the journal sees only changes that mean
    // something went wrong.
    if (selection.reason === 'failover' && previous !== undefined && previous !== selection.account.agent) {
      this.ports.journal.record('fleet.warden_failover', {
        from: previous,
        to: selection.account.agent,
        policy,
        reason: 'preferred account unhealthy',
      });
    }
    return {
      state: { ...state, failover: selection.state },
      account: selection.account,
      selection: {
        policy,
        selection: selection.reason,
        configuredFirst: configuredFirst === '' ? selection.account.agent : configuredFirst,
        skipped: selection.skipped,
      },
    };
  }

  /**
   * Record a spawn failure against the ACCOUNT, never against the target.
   *
   * Punishing the target is what starved suspect sessions one at a time while the
   * broken account stayed first in line: each sus session took one turn on a dead
   * account, was cooled down for it, and the account was never strike-counted.
   */
  private recordSpawnFailure(
    state: WardenRuntimeState,
    config: WardenConfig,
    agent: string,
    error: unknown,
  ): WardenRuntimeState {
    const message = failureMessage(error);
    const result = recordWardenFailure(
      state.failover ?? {},
      agent,
      classifyWardenFailure(message),
      message,
      this.ports.nowMs(),
      config.failover,
    );
    if (result.demoted)
      this.ports.journal.record('fleet.warden_account_demoted', {
        agent,
        until: result.state.demotedUntil?.[agent],
        strikes: result.strikes,
        evidence: message,
      });
    return { ...state, failover: result.state };
  }

  private async spawn(
    request: WardenSpawnRequest,
  ): Promise<{ readonly facts?: WardenSpawnFacts; readonly error?: unknown }> {
    try {
      return { facts: await this.ports.spawner.spawn(request) };
    } catch (error) {
      return { error };
    }
  }

  /**
   * Record who ran the check, beside the report the warden will write.
   *
   * A failure here is journalled and never rethrown, and it never strikes the
   * account: the warden is already live and working. Losing the sidecar degrades
   * the verdict list to "provenance unknown", which `reports.ts` already handles;
   * treating it as a launch failure would strike a working account and lose track
   * of a session that is running right now.
   */
  private async writeProvenance(
    reportPath: string,
    facts: WardenSpawnFacts,
    selection: WardenSelectionProvenance,
    targetId?: string,
  ): Promise<void> {
    try {
      await this.ports.artifacts.writeProvenance(reportPath, buildWardenSpawnProvenance(facts, selection, targetId));
    } catch (error) {
      this.ports.journal.record('fleet.warden_provenance_failed', {
        wardenId: facts.sessionId,
        ...(targetId === undefined ? {} : { targetId }),
        reportPath,
        message: failureMessage(error),
      });
    }
  }

  private async installedAgents(): Promise<readonly string[]> {
    return await this.ports.agents.installed().catch(() => []);
  }

  private async latestReportField(): Promise<Pick<WardenStatusView, 'lastReport'>> {
    const latest = await this.ports.artifacts.latest().catch(() => undefined);
    return latest === undefined ? {} : { lastReport: latest };
  }

  /** The failover block of the status: every configured account with its live
   *  health and why it is or is not eligible right now. */
  private async failoverStatus(config: WardenConfig, state: WardenFailoverState): Promise<WardenFailoverStatus> {
    const failover = effectiveFailoverConfig(config.failover);
    const usage = await this.ports.usage.accounts().catch(() => []);
    const installed = await this.installedAgents();
    const nowMs = this.ports.nowMs();
    const byAgent = new Map(usage.map(item => [item.agent, item]));
    return {
      policy: failover.policy,
      failureThreshold: failover.failureThreshold,
      cooldownMinutes: failover.cooldownMinutes,
      accounts: wardenAccountsOf(config).map(account => {
        const reason = ineligibilityReason(account, { installedAgents: installed, usage, state, nowMs });
        const health = byAgent.get(account.agent);
        return {
          agent: account.agent,
          ...(account.model === undefined ? {} : { model: account.model }),
          eligible: reason === undefined,
          ...(reason === undefined ? {} : { reason }),
          ...(isDemoted(state, account.agent, nowMs) ? { demotedUntil: state.demotedUntil?.[account.agent] } : {}),
          ...(state.strikes?.[account.agent] === undefined
            ? {}
            : { strikes: state.strikes[account.agent]?.count ?? 0 }),
          ...(health === undefined
            ? {}
            : {
                quota: {
                  ...(health.atLimit === undefined ? {} : { atLimit: health.atLimit }),
                  ...(health.authOk === undefined ? {} : { authOk: health.authOk }),
                },
              }),
        };
      }),
      ...(state.lastSelection === undefined ? {} : { lastSelection: state.lastSelection }),
      ...(state.exhaustedSince === undefined ? {} : { exhaustedSince: state.exhaustedSince }),
    };
  }
}
