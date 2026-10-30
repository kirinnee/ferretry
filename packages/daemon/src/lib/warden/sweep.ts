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

import type {
  AgendaSource,
  WardenAction,
  WardenCap,
  WardenConfigView,
  WardenFailoverStatus,
  WardenGuardConfig,
  WardenInvestigateView,
  WardenInvestigationOrigin,
  WardenJevBefore,
  WardenJevCheck,
  WardenLayerStatus,
  WardenLeaveDuration,
  WardenLeaveView,
  WardenRunView,
  WardenSpend,
  WardenStatusView,
  WardenTriageStatus,
  WardenAgendaView as WireAgendaView,
  WardenAnomaly as WireWardenAnomaly,
} from '@ferretry/protocol';
import {
  displaySystemCallsign,
  nextWardenInvestigatorSequence,
  wardenActionActor,
  wardenInvestigatorName,
  wardenInvestigatorSequence,
} from '@ferretry/protocol';
import { displayAgentName } from '../names/session-names.ts';
import type { TriageDecision, TriageGuardPort } from '../speedups/jev.ts';
import { type AgendaBoardInput, buildWardenAgendaView } from './agenda.ts';
import {
  BACKOFF_CEILING_MS,
  backoffHold,
  jevActStanding,
  jevSubject,
  reconcileBackoff,
  recordJevAct,
  recordLook,
} from './backoff.ts';
import {
  activeBlessing,
  clearStreak,
  growingBlessingMs,
  isAnomalyBlessed,
  mergeBlessing,
  reconcileBlessings,
  reconcileClearStreaks,
  recordClears,
} from './bless.ts';
import { decideAssignedWardens, type LiveWarden, wardenSlotsFree } from './concurrency.ts';
import {
  applyWardenConfigPatch,
  assignedCooldownMs,
  parseStoredWardenConfig,
  type ResolvedWardenLogin,
  resolveWardenLogin,
  type StoredWardenConfig,
  spawnGapMs,
  sweepIntervalMs,
  type WardenConfig,
  type WardenConfigPatch,
  wardenConfigWarnings,
  wardenDetectOptions,
} from './config.ts';
import type { WardenAnomaly, WardenDetectResult } from './detect.ts';
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
  normalizeWardenAccounts,
  reconcileDemotions,
  recordWardenFailure,
  recordWardenSuccess,
  selectWardenAccount,
  type WardenAccount,
  type WardenAccountHealth,
  type WardenFailoverState,
} from './failover.ts';
import { blessingViews, investigationList, retainRecords, WARDEN_STATUS_LIST_LIMIT } from './feed.ts';
import {
  recordWardenAsk,
  recordWardenJevCheck,
  recordWardenOutcome,
  wardenAskActor,
  wardenHistory,
  withDailyRollup,
} from './daily.ts';
import {
  capSkipKey,
  JEV_CHECKS_SHOWN,
  jevBeforeInvestigation,
  jevBeforeOf,
  jevCapSkipOf,
  jevCheckOf,
  pruneCapSkips,
  pruneJevBefore,
  rememberJevBefore,
  type WardenJevCheckLog,
} from './jev-checks.ts';
import { leftoverBrowserCandidates } from './leftovers.ts';
import { wardenOwnerRoutes } from './owner-routes.ts';
import { REFLEX_NUDGE_MESSAGE } from './liveness.ts';
import type { ReflexEvent } from './liveness-monitor.ts';
import { buildAssignedWardenPrompt, buildWardenSweepPrompt, type WardenPromptSettings } from './prompt.ts';
import {
  buildWardenSpawnProvenance,
  type WardenSelectionProvenance,
  type WardenSpawnFacts,
  type WardenSpawnProvenance,
} from './provenance.ts';
import {
  jevActDetail,
  jevNudgeMessage,
  mayActAlone,
  verdictAct,
  type WardenRemedyPort,
  type WardenVerdictAct,
  wardenActDetail,
  wardenNudgeMessage,
} from './remedy.ts';
import {
  parseWardenRuntimeState,
  jevHandoffKey,
  recordJevHandoff,
  type WardenJevHandoff,
  recordSweepFingerprint,
  spawnSuppressionKey,
  WARDEN_HISTORY_LIMIT,
  type WardenAssignmentRecord,
  type WardenQueueEntryMeta,
  type WardenRuntimeState,
  wardenMayStop,
} from './state.ts';
import { DEFAULT_TICK_SECONDS } from './sus.ts';
import { instantMs } from './time.ts';
import {
  effectiveLayers,
  firstResponse,
  forgetPassedOn,
  guardBackingOff,
  guardHealthAfter,
  newFlagCount,
  passedOnKey,
  prunePassedOn,
  recordGuardDecision,
  jevActsFor,
  jevJudges,
  jevWithinBudget,
  HOURLY_CAP_SHARE,
  recordJevAction,
  redactTriageSnapshot,
  retractJevAction,
  triageDayFor,
  triageSnapshotOf,
  type WardenGuardOutcome,
  type WardenInvestigationRecord,
  type WardenLayersInEffect,
  type WardenTextRedactor,
  type WardenTriageEvidence,
  wardenSavings,
  wardenSpend,
} from './triage.ts';
import { isTerminalStatus, WARDEN_LABEL, type WardenSessionView } from './types.ts';
import { classifyVerdict, parseWardenReports, structuredVerdict } from './verdicts.ts';

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
  /**
   * Whether the liveness monitor has stopped seeing altogether (`WardenLivenessMonitor.stalled`). Absent:
   * never. While it is, every unwatched ferret is ONE daemon fault ({@link collapseUnwatchedFleet}).
   */
  monitorStalled?(): boolean;
}

export interface WardenSpawnRequest {
  readonly agent: string;
  readonly model?: string;
  readonly name: string;
  readonly prompt: string;
  readonly cwd: string;
  /** The investigation effort the owner chose. */
  readonly effort?: string;
  /**
   * Unguessable per-assignment secret exported into this warden's own terminal.
   *
   * Absent for the fleet-sweep warden, which guards no single target. Present for
   * an assigned warden, and it is the ONLY thing that authorizes it to stop the
   * one session it was sent to look at.
   */
  readonly stopCapability?: string;
  /**
   * The investigator's own callsign, `warden-00002a`. Always set by the sweep: a system session that
   * asked for no name would be handed a first name from the pool, and those are for real ferrets.
   */
  readonly teammate?: string;
}

/** Every one of the 16,777,215 investigator names is held — a fleet no machine will hold, refused rather than looped. */
const NO_INVESTIGATOR_NAME = new Error('every warden-xxxxxx name is in use');

/** The spawner's answer when the callsign it was asked to claim is already held. */
export class WardenCallsignTakenError extends Error {
  constructor(readonly callsign: string) {
    super(`callsign ${callsign} is already claimed`);
    this.name = 'WardenCallsignTakenError';
  }
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
  /**
   * Persist `config` — the settings in effect with the owner's `patch` applied. The patch travels too:
   * an edit the owner has not confirmed yet is held in the file, and the store must make the owner's
   * change to that held edit as well rather than overwrite it with what is in effect.
   */
  write(config: WardenConfig, patch: WardenConfigPatch): Promise<void>;
}

/** Accounts actually installed on this host, by the NAME an operator types (`claude-default`), never by the
 *  fleet manifest's opaque id. An empty answer means the inventory is unreadable — evidence about the host,
 *  never about an account. */
export interface WardenAgentInventory {
  installed(): Promise<readonly string[]>;
  /** The name a stored login reference means today (a name it had before, or its id), or `undefined` when none answers to it. */
  currentName(reference: string): Promise<string | undefined>;
  /** The machine's default runtime, read fresh: the investigation login when the owner chose none. */
  defaultRuntime(): Promise<string | undefined>;
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
export type WardenAgendaWrite = 'created' | 'refreshed' | 'unchanged' | 'rejected';

/**
 * The ONE agenda store, reached through the same service every other caller
 * uses — never a second board of the warden's own.
 *
 * Every method is total: a board that cannot be read is `undefined`, a write
 * that the state machine refuses is `rejected`. A throw here would abort a sweep
 * that has already completed its real work.
 */
export interface WardenAgendaPort {
  board(sessionId: string): Promise<WardenEscalationBoard | undefined>;
  raise(sessionId: string, request: WardenEscalationRaise): Promise<WardenAgendaWrite>;
  resolveSource(sessionId: string, source: AgendaSource, sourceRef: string, note: string): Promise<boolean>;
}

/** What the daemon can read about a flagged ferret for Jev. Total: an unreadable ferret is no evidence. */
export interface WardenTriageEvidenceReader {
  evidence(sessionId: string): Promise<WardenTriageEvidence>;
}

/** A finished warden's own cost, priced from its transcript. `undefined` until analytics can price it. */
export interface WardenInvestigationCostReader {
  costUsd(wardenSessionId: string): Promise<number | undefined>;
}

/** One session's agenda board, in the view's shape, for reading the Warden's own notifications back. */
export interface WardenFeedReader {
  board(sessionId: string): Promise<AgendaBoardInput | undefined>;
}

export interface WardenSweepPorts {
  /** The Jev guard, built for the guard settings in effect. It holds no key: see `speedups/jev.ts`. */
  readonly guard: (settings: WardenGuardConfig) => TriageGuardPort;
  readonly evidence: WardenTriageEvidenceReader;
  /** The vault redactor every Jev snapshot passes through before anything leaves the machine. */
  readonly redactor: WardenTextRedactor;
  /** Carrying out a verdict the owner let the Warden act on alone. */
  readonly remedies: WardenRemedyPort;
  readonly costs: WardenInvestigationCostReader;
  readonly feed: WardenFeedReader;
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
  readonly attention: WardenAgendaPort;
  readonly journal: WardenJournal;
  /** Jev's checks, one record each, kept beside the reports (`jev-checks.ts`). */
  readonly jevChecks: WardenJevCheckLog;
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
  /** This machine's name, read when a notification is written, so one among every machine's says which. */
  readonly machineName?: () => string | undefined;
}

/** Stable identity for the one fault "this daemon watches nothing" is. */
export const UNSUPERVISED_FLEET_KEY = 'daemon:no-monitor-subsystem';

/** Stable identity for the one fault "this daemon's liveness monitor has stopped seeing" is. */
export const STALLED_MONITOR_FLEET_KEY = 'daemon:liveness-stalled';

/** Why no ferret is watched, when that is the daemon's fault rather than any ferret's. */
export type WardenUnwatchedFleet = 'unsupervised' | 'stalled';

/**
 * Restate per-session `dead_monitor` anomalies as the ONE daemon-level fault they
 * are when no ferret CAN be watched: no monitor subsystem is mounted, or the
 * liveness monitor itself has stopped seeing (`WardenLivenessMonitor.stalled` —
 * a starved host whose ticks run late, or a tick blind to the whole fleet).
 *
 * WHY NOT JUST DROP THEM. Because a sweep over an unwatched fleet would then read
 * as clean, which is the exact failure this subsystem exists to prevent. Every
 * affected session id is carried on the single anomaly, so nothing is hidden — the
 * evidence is reported once, as one fault, instead of N times as N faults.
 *
 * WHY NOT PASS `hasLiveMonitor: true` INSTEAD. That would be a lie in the
 * dangerous direction twice over: it would report the fleet as watched, and it
 * would switch on the sus classifiers, which reason over a liveness ledger that
 * nothing updates. Verdicts from a frozen ledger are worse than no verdicts.
 *
 * The fingerprint of the collapsed anomaly is keyed on `fleetKey`, so it is stable
 * across sweeps and across changes in which sessions are running: escalating once
 * about a structural gap is right, and escalating every sweep is not. A fleet
 * anomaly is no one ferret's, so Jev is offered no act on it (`jevActsFor`).
 */
export function collapseUnwatchedFleet(
  anomalies: readonly WardenAnomaly[],
  unwatched: WardenUnwatchedFleet | undefined,
): readonly WardenAnomaly[] {
  if (unwatched === undefined) return anomalies;
  const unmonitored = anomalies.filter(anomaly => anomaly.kind === 'dead_monitor');
  if (unmonitored.length === 0) return anomalies;
  const affected = unmonitored.map(anomaly => anomaly.sessionId).toSorted();
  const anchor = unmonitored.find(anomaly => anomaly.sessionId === affected[0]) ?? unmonitored[0];
  const count = `${affected.length} active session${affected.length === 1 ? '' : 's'} unsupervised`;
  return [
    ...anomalies.filter(anomaly => anomaly.kind !== 'dead_monitor'),
    {
      kind: 'dead_monitor',
      // A required field, so it names the lowest affected id rather than nothing:
      // the fleet key above is what dedup and the fingerprint actually key on.
      sessionId: affected[0] as string,
      fleetKey: unwatched === 'unsupervised' ? UNSUPERVISED_FLEET_KEY : STALLED_MONITOR_FLEET_KEY,
      affectedSessionIds: affected,
      status: anchor?.status ?? 'running',
      detail:
        unwatched === 'unsupervised'
          ? `this daemon runs no per-session monitor subsystem, so no turn is watched — ${count}`
          : `this daemon's liveness monitor has seen no ferret for five minutes — the daemon or its host is stuck, not the ferrets — ${count}`,
    },
  ];
}

/** {@link collapseUnwatchedFleet} for a daemon that does or does not mount monitors at all. */
export function collapseUnsupervisedMonitors(
  anomalies: readonly WardenAnomaly[],
  supervisesMonitors: boolean,
): readonly WardenAnomaly[] {
  return collapseUnwatchedFleet(anomalies, supervisesMonitors ? undefined : 'unsupervised');
}

/** Why an owner's request for an investigation was refused. */
export type WardenRequestFailure =
  /** The Warden is off. */
  | 'off'
  /** No such ferret. */
  | 'not_found'
  /** The ferret has finished; there is nothing left to investigate. */
  | 'finished'
  /** Today's investigation cap is reached. */
  | 'cap'
  /** No investigation login exists on this machine. */
  | 'no_login'
  /** Nothing about the ferret is flagged or cleared, so there is nothing to leave alone. */
  | 'not_flagged';

export class WardenRequestError extends Error {
  constructor(
    readonly failure: WardenRequestFailure,
    message: string,
  ) {
    super(message);
    this.name = 'WardenRequestError';
  }
}

/** The layers in effect right now, with the budget that decided them. */
interface TriageBudget {
  readonly status: WardenTriageStatus;
  readonly layers: WardenLayersInEffect;
  readonly spend: ReturnType<typeof wardenSpend>;
}

/** How many logins one spawn tries before it waits for the next sweep. */
export const MAX_SPAWN_ATTEMPTS = 3;

/** What the owner's "Leave it longer" choices last. `until_change` is bounded so nothing is forever. */
const LEAVE_MS: Readonly<Record<WardenLeaveDuration, number>> = {
  '1h': 3_600_000,
  '4h': 4 * 3_600_000,
  until_change: 7 * 86_400_000,
};

/** A lifetime as a person reads it: minutes under an hour, hours otherwise. */
export function leftAloneFor(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} h`;
}

/** How long a clear leaves the flag alone, in the actions list's words. */
function leftAloneNote(subject: string | undefined, ttlMs: number, streak: number): string {
  if (subject === undefined) return `for ${leftAloneFor(ttlMs)}${streakNote(streak)}`;
  return `until its situation changes — a new turn or a different command — for ${leftAloneFor(BACKOFF_CEILING_MS)} at most`;
}

/** Why a clear lasts longer than the first one did. */
function streakNote(streak: number): string {
  return streak <= 0 ? '' : ` — cleared ${streak + 1} times in a row, so it is left alone longer each time`;
}

/** When a paced cap is back, as a person reads it: `07:00 UTC`. */
export function pacedUntilLabel(pacedUntil: string | undefined): string {
  return pacedUntil === undefined ? 'the next hour' : `${pacedUntil.slice(11, 16)} UTC`;
}

/** Whether a cap is reached only for this hour, not for the day. */
export function capPaced(spend: Pick<WardenSpend, 'capsPaced'>, cap: WardenCap): boolean {
  return (spend.capsPaced ?? []).includes(cap);
}

/** Why flags were left for the owner rather than investigated, in the run's own words. */
export function investigationsOffMessage(
  layers: WardenLayersInEffect,
  waiting: number,
  spend: Pick<WardenSpend, 'capsPaced' | 'pacedUntil'> = {},
): string {
  const flags = `${waiting} flag${waiting === 1 ? '' : 's'}${layers.jev.active ? ' Jev did not clear' : ''}`;
  const wait = waiting === 1 ? 'waits' : 'wait';
  switch (layers.llm.reason) {
    case 'no_login':
      return `no investigation login exists on this machine: ${flags} ${wait} for you until one is chosen in Settings › Warden`;
    case 'investigation_cap':
      return capPaced(spend, 'investigation')
        ? `this hour’s share of the investigation cap is spent: ${flags} ${wait} until ${pacedUntilLabel(spend.pacedUntil)}`
        : `today’s investigation cap is reached: ${flags} ${wait} for you until midnight UTC`;
    default:
      return `investigations are off: ${flags} ${wait} for you and nothing is spent on ${waiting === 1 ? 'it' : 'them'}`;
  }
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
  private readonly ports: WardenSweepPorts;

  constructor(
    ports: WardenSweepPorts,
    private readonly settings: WardenSweepSettings,
  ) {
    // Every state write carries the daily rollup, so no call site has to remember to fold it.
    this.ports = { ...ports, state: withDailyRollup(ports.state, ports.nowMs) };
  }

  /** The configuration as an operator reads it, with everything they should know
   *  about it. */
  async view(): Promise<WardenConfigView> {
    const stored = await this.storedConfig();
    const resolved = await this.resolveLogin(stored.config);
    return {
      config: stored.config,
      accounts: [...resolved.accounts],
      warnings: [...stored.warnings, ...wardenConfigWarnings(stored.config, resolved)],
      login: resolved.login,
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
    const stored = await this.storedConfig();
    const next = applyWardenConfigPatch(stored.config, patch);
    await this.ports.config.write(next, patch);
    this.ports.journal.record('fleet.warden_config_changed', { fields: Object.keys(patch) });
    const resolved = await this.resolveLogin(next);
    return {
      config: next,
      accounts: [...resolved.accounts],
      warnings: [...wardenConfigWarnings(next, resolved)],
      login: resolved.login,
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
  async status(nextSweepAt?: string): Promise<WardenStatusView> {
    const stored = await this.storedConfig();
    const state = parseWardenRuntimeState(await this.ports.state.read());
    const fleet = await this.ports.fleet.fleet();
    const nowMs = this.ports.nowMs();
    const live = this.liveWardens(fleet, state);
    const liveWarden = live[0]?.wardenId;
    const liveIds = new Set([
      ...live.map(warden => warden.wardenId),
      ...Object.values(state.assignments ?? {}).map(assignment => assignment.wardenId),
    ]);
    const resolved = await this.resolveLogin(stored.config);
    const budget = this.budget(stored.config, state, nowMs, resolved.usable);
    const jevChecks = await this.ports.jevChecks.recent(JEV_CHECKS_SHOWN).catch(() => undefined);
    const investigators = new Map(
      (state.investigations ?? []).flatMap(record =>
        record.wardenName === undefined ? [] : [[record.id, record.wardenName] as const],
      ),
    );
    return {
      config: stored.config,
      ...(state.lastSweepAt === undefined ? {} : { lastSweepAt: state.lastSweepAt }),
      ...(nextSweepAt === undefined ? {} : { nextSweepAt }),
      anomalies: (state.lastAnomalies ?? []).map(wireAnomaly),
      fingerprint: state.lastFingerprint ?? '',
      ...(liveWarden === undefined ? {} : { liveWarden }),
      ...(state.lastSpawnAt === undefined ? {} : { lastSpawnAt: state.lastSpawnAt }),
      ...(await this.latestReportField()),
      failover: await this.failoverStatus(stored.config, resolved.accounts, state.failover ?? {}),
      login: resolved.login,
      triage: budget.status,
      spend: budget.spend,
      savings: wardenSavings(triageDayFor(state.triageDay, nowMs), state.investigations ?? [], state.costAverage),
      investigations: [
        ...investigationList({
          queue: state.assignedQueue ?? [],
          meta: state.queueMeta ?? {},
          records: state.investigations ?? [],
          live: wardenId => liveIds.has(wardenId),
          // A queued flag says what Jev has done about it so far, as its investigation will once it starts.
          jevFor: anomaly =>
            jevBeforeInvestigation({
              kind: anomaly.kind,
              ...optionalLast(state.jevBefore?.[jevHandoffKey(anomaly.sessionId, anomaly.kind)]),
              jevOn: stored.config.layers.jev,
              force: false,
            }),
        }).map(entry => {
          const wardenName = entry.wardenSession === undefined ? undefined : investigators.get(entry.wardenSession);
          return wardenName === undefined ? entry : { ...entry, wardenName };
        }),
      ],
      actions: (state.actions ?? []).slice(0, WARDEN_STATUS_LIST_LIMIT).map(action => ({ ...action })),
      blessings: [...blessingViews(state.blessings ?? {}, nowMs)],
      history: [...wardenHistory(state, nowMs)],
      // A record that cannot be read is left out — unknown, as from an older daemon — never shown as none.
      ...(jevChecks === undefined ? {} : { jevChecks: [...jevChecks] }),
    };
  }

  /**
   * What the Warden needs the owner for: its own open notifications, read back from the boards
   * (`attention.ts`). A thin read, never a second list — they are raised and cleared by the sweep
   * (`reconcileEscalations`) and answered in the unified Agenda inbox. What could not be read is said
   * out loud as a degraded view rather than read as "nothing waits".
   */
  async agenda(): Promise<WireAgendaView> {
    const stored = await this.storedConfig();
    const state = parseWardenRuntimeState(await this.ports.state.read());
    const fleet = await this.ports.fleet.fleet();
    const live = fleet.filter(
      session => !isTerminalStatus(session.state.status) && session.config.label !== WARDEN_LABEL,
    );
    const read = await Promise.all(
      live.map(async session => await this.ports.feed.board(session.config.id).catch(() => undefined)),
    );
    const boards = read.filter((board): board is AgendaBoardInput => board !== undefined);
    const reports = await this.ports.verdicts.recent().catch(() => undefined);
    return buildWardenAgendaView({
      now: this.ports.nowMs(),
      sessions: fleet,
      boards,
      unreadBoards: read.length - boards.length,
      reportsUnreadable: reports === undefined,
      ...(state.lastSweepAt === undefined ? {} : { lastSweepAt: state.lastSweepAt }),
      ...(state.failover?.exhaustedSince === undefined ? {} : { exhaustedSince: state.failover.exhaustedSince }),
      sweepIntervalMinutes: stored.config.intervalMinutes,
    });
  }

  /**
   * The owner asks for an investigation of one ferret.
   *
   * It skips Jev and any blessing — the owner has already decided it deserves a look — and joins the
   * queue AHEAD of the sweep's own flags, behind earlier requests of the owner's. It still waits for a
   * free slot and still counts against today's cap: asking is not a way round the budget. Refused
   * while the Warden is off, for a ferret that has finished, and once the cap is reached.
   *
   * Only queues. The caller runs a sweep right after, which spawns it if a slot is free.
   */
  async requestInvestigation(sessionId: string, note?: string): Promise<WardenInvestigateView> {
    const stored = await this.storedConfig();
    if (!stored.config.enabled)
      throw new WardenRequestError(
        'off',
        'The Warden is off. Turn it on in Settings › Warden to ask for an investigation.',
      );
    const target = (await this.ports.fleet.fleet()).find(session => session.config.id === sessionId);
    if (target === undefined) throw new WardenRequestError('not_found', `no ferret ${sessionId}`);
    if (isTerminalStatus(target.state.status))
      throw new WardenRequestError('finished', `${sessionId} has finished, so there is nothing left to investigate`);
    const nowMs = this.ports.nowMs();
    const state = parseWardenRuntimeState(await this.ports.state.read());
    const existing = state.assignments?.[sessionId];
    if (existing !== undefined)
      return {
        sessionId,
        state: 'running',
        wardenSession: existing.wardenId,
        message: 'A warden is already investigating this ferret.',
      };
    const resolved = await this.resolveLogin(stored.config);
    if (!resolved.usable)
      throw new WardenRequestError(
        'no_login',
        resolved.login.source === 'not_set'
          ? 'No investigation login is set and this machine has no default runtime. Choose one in Settings › Warden.'
          : `Unknown login '${resolved.accounts[0]?.agent}' — choose one in Settings › Warden.`,
      );
    const budget = this.budget(stored.config, state, nowMs, resolved.usable);
    if (budget.spend.capsHit.includes('investigation'))
      throw new WardenRequestError(
        'cap',
        capPaced(budget.spend, 'investigation')
          ? `This hour’s share of the investigation cap ($${(stored.config.caps.investigationUsdPerDay * HOURLY_CAP_SHARE).toFixed(2)} of $${stored.config.caps.investigationUsdPerDay.toFixed(2)} a day) is spent. Try again at ${pacedUntilLabel(budget.spend.pacedUntil)}.`
          : `Today’s investigation cap ($${stored.config.caps.investigationUsdPerDay.toFixed(2)}) is reached. Raise it in Settings › Warden, or wait until midnight UTC.`,
      );
    const at = new Date(nowMs).toISOString();
    const queue = (state.assignedQueue ?? []).filter(anomaly => anomaly.sessionId !== sessionId);
    const meta = state.queueMeta ?? {};
    const owners = queue.filter(anomaly => meta[anomaly.sessionId]?.origin === 'owner').length;
    const request: WardenAnomaly = {
      kind: 'owner_request',
      sessionId,
      status: target.state.status,
      detail: note ?? 'You asked the Warden to investigate this ferret.',
      since: at,
      ...(target.config.teammate === undefined ? {} : { teammate: target.config.teammate }),
      ...(target.config.label === undefined ? {} : { label: target.config.label }),
    };
    const nextQueue = [...queue.slice(0, owners), request, ...queue.slice(owners)];
    await this.ports.state.write({
      ...state,
      assignedQueue: nextQueue,
      queueMeta: {
        ...meta,
        [sessionId]: { queuedAt: at, origin: 'owner', ...(note === undefined ? {} : { note }) },
      },
    });
    this.ports.journal.record('fleet.warden_investigation_requested', { sessionId, position: owners + 1 });
    return {
      sessionId,
      state: 'queued',
      position: owners + 1,
      message:
        stored.config.maxAssignedWardens === 1
          ? 'Queued. One investigation runs at a time.'
          : `Queued. ${stored.config.maxAssignedWardens} investigations run at a time.`,
    };
  }

  /** Where an owner's request stands after the sweep that followed it. */
  async investigationStatus(sessionId: string): Promise<WardenInvestigateView> {
    const state = parseWardenRuntimeState(await this.ports.state.read());
    const running = state.assignments?.[sessionId];
    if (running !== undefined)
      return {
        sessionId,
        state: 'running',
        wardenSession: running.wardenId,
        message: 'A warden is investigating it now.',
      };
    const index = (state.assignedQueue ?? []).findIndex(anomaly => anomaly.sessionId === sessionId);
    return {
      sessionId,
      state: 'queued',
      ...(index < 0 ? {} : { position: index + 1 }),
      message: 'Queued: it starts when a slot is free.',
    };
  }

  /**
   * The owner leaves a flagged or cleared ferret alone for longer than the Warden would.
   *
   * NARROW, like every blessing: it covers the kinds flagged or cleared on that ferret right now, in the
   * status it holds now, so a new kind of trouble still raises a flag and any change of status ends it.
   * It never SHORTENS a blessing already in force — the later expiry wins — and it takes the ferret out
   * of the investigation queue, because the owner's latest word about it is "leave it". It counts into
   * no streak: the streak measures the Warden's own clears. Refused for a ferret that has finished, and
   * for one with nothing flagged or cleared, where there is nothing to leave alone.
   */
  async leaveAlone(sessionId: string, duration: WardenLeaveDuration): Promise<WardenLeaveView> {
    const target = (await this.ports.fleet.fleet()).find(session => session.config.id === sessionId);
    if (target === undefined) throw new WardenRequestError('not_found', `no ferret ${sessionId}`);
    if (isTerminalStatus(target.state.status))
      throw new WardenRequestError('finished', `${sessionId} has finished, so there is nothing left to watch`);
    const nowMs = this.ports.nowMs();
    const state = parseWardenRuntimeState(await this.ports.state.read());
    const status = target.state.status;
    const store = state.blessings ?? {};
    const current = activeBlessing(store, sessionId, nowMs);
    const kinds = [
      ...new Set([
        ...(state.lastAnomalies ?? [])
          .filter(anomaly => anomaly.sessionId === sessionId && anomaly.status === status)
          .map(anomaly => anomaly.kind)
          .filter(kind => kind !== 'owner_request'),
        ...(current?.status === status ? current.kinds : []),
      ]),
    ];
    if (kinds.length === 0)
      throw new WardenRequestError(
        'not_flagged',
        'Nothing about this ferret is flagged or cleared right now, so there is nothing to leave alone.',
      );
    const blessings = mergeBlessing(
      store,
      { sessionId, kinds, status, by: 'owner', ...(duration === 'until_change' ? { untilChange: true } : {}) },
      nowMs,
      LEAVE_MS[duration],
    );
    const blessing = blessings[sessionId] as NonNullable<(typeof blessings)[string]>;
    const how =
      duration === 'until_change'
        ? 'until its status changes'
        : `for ${leftAloneFor((instantMs(blessing.expiresAt) ?? nowMs) - nowMs)}`;
    const at = new Date(nowMs).toISOString();
    const meta = { ...(state.queueMeta ?? {}) };
    delete meta[sessionId];
    await this.ports.state.write(
      this.recordAction(
        {
          ...state,
          blessings,
          assignedQueue: (state.assignedQueue ?? []).filter(anomaly => anomaly.sessionId !== sessionId),
          queueMeta: meta,
        },
        {
          at,
          sessionId,
          action: 'bless',
          outcome: 'done',
          by: 'owner',
          actor: 'owner',
          ...(kinds[0] === undefined ? {} : { anomalyKind: kinds[0] }),
          detail: `You asked the Warden to leave it alone ${how}.`,
        },
      ),
    );
    this.ports.journal.record('fleet.warden_left_alone', { sessionId, duration, kinds, expiresAt: blessing.expiresAt });
    return {
      blessing: blessingViews({ [sessionId]: blessing }, nowMs)[0] as WardenLeaveView['blessing'],
      message: `Left alone ${how}. A new kind of trouble, or a change of status, still raises a flag.`,
    };
  }

  /** The layers in effect and today's spend, from the durable state. */
  private budget(config: WardenConfig, state: WardenRuntimeState, nowMs: number, hasLogin: boolean): TriageBudget {
    const spend = wardenSpend({
      caps: config.caps,
      today: triageDayFor(state.triageDay, nowMs),
      records: state.investigations ?? [],
      ...(state.costAverage === undefined ? {} : { average: state.costAverage }),
      nowMs,
    });
    const layers = effectiveLayers(config.layers, config.enabled, spend, hasLogin);
    const guard = config.layers.jev ? state.guard : undefined;
    return {
      spend,
      layers,
      status: {
        ...layers,
        ...(guard?.lastFailure === undefined ? {} : { guardFailure: guard.lastFailure }),
        ...(guard !== undefined && guardBackingOff(guard, nowMs) && guard.backoffUntil !== undefined
          ? { guardBackoffUntil: guard.backoffUntil }
          : {}),
      },
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
    const stored = await this.storedConfig();
    const config = stored.config;
    const login = await this.resolveLogin(config);
    const fleet = await this.ports.fleet.fleet();
    const nowMs = this.ports.nowMs();
    const at = new Date(nowMs).toISOString();

    const scannable = fleet.filter(session => isWardenScannableStatus(session.state.status));
    const raw = detectAnomalies(scannable, nowMs, wardenDetectOptions(config), fleet);
    const unwatched = !this.settings.supervisesMonitors
      ? 'unsupervised'
      : this.ports.fleet.monitorStalled?.() === true
        ? 'stalled'
        : undefined;
    const collapsed = collapseUnwatchedFleet(raw.anomalies, unwatched);
    const detected: WardenDetectResult = { anomalies: collapsed, fingerprint: fingerprintAnomalies(collapsed) };

    let state = parseWardenRuntimeState(await this.ports.state.read());
    const today = triageDayFor(state.triageDay, nowMs);
    state = this.pruneClears(state, fleet, detected.anomalies, nowMs);
    state = recordSweepFingerprint(state, detected.fingerprint);
    state = {
      ...state,
      lastSweepAt: at,
      lastAnomalies: detected.anomalies,
      triageDay: { ...today, flags: today.flags + newFlagCount(state.lastAnomalies ?? [], detected.anomalies) },
    };
    await this.ports.state.write(state);
    state = await this.closeLeftovers(state, fleet, config, nowMs);

    const assigned = await this.runAssigned({
      anomalies: detected.anomalies.filter(anomaly => anomaly.assignedWarden === true),
      fleet,
      config,
      login,
      state,
      at,
      force: options.force,
    });
    state = assigned.state;

    const escalated = await this.escalate({
      anomalies: detected.anomalies.filter(anomaly => anomaly.assignedWarden !== true),
      fleet,
      config,
      login,
      state,
      at,
      force: options.force,
    });
    const final = await this.priceInvestigations(escalated.state, fleet, at);
    await this.ports.state.write(final);

    // LAST, and deliberately so. Everything above — detection, the report
    // prompts, the spawn gates — has already been decided and persisted before
    // a single agenda board is opened, which is what makes "ordinary
    // Attention cannot affect the scan" a property of the ORDER rather than a
    // promise. Moving this call earlier would break it.
    await this.reconcileEscalations(detected.anomalies, fleet, {
      config,
      login,
      state: final,
      at,
      spawned: [...assigned.spawned, ...(escalated.outcome.spawned === undefined ? [] : [escalated.outcome.spawned])],
    });

    return {
      sweptAt: at,
      anomalies: detected.anomalies.map(wireAnomaly),
      ...escalated.outcome,
      ...(assigned.spawned.length === 0 ? {} : { assignedWardens: [...assigned.spawned] }),
    };
  }

  /**
   * Act on what one liveness tick found. A quiet ferret is nudged only while the Warden is on and the
   * owner lets it nudge alone, and every nudge is listed under Recent actions. A frozen one is NOT acted
   * on here: it is journalled, and the next sweep raises it as a flag that goes through the layers like
   * any other. Answers whether anything froze, so the caller can bring that sweep forward.
   */
  async reflex(events: readonly ReflexEvent[]): Promise<{ readonly frozen: boolean }> {
    if (events.length === 0) return { frozen: false };
    const config = parseStoredWardenConfig(await this.ports.config.read()).config;
    let state = parseWardenRuntimeState(await this.ports.state.read());
    const at = new Date(this.ports.nowMs()).toISOString();
    for (const event of events) {
      const quiet = Math.floor(event.assessment.quietSeconds / 60);
      if (event.kind === 'frozen') {
        this.ports.journal.record('fleet.warden_frozen', {
          sessionId: event.sessionId,
          quietSeconds: Math.floor(event.assessment.strongQuietSeconds),
        });
        continue;
      }
      if (!config.enabled || !config.mayActAlone.nudge) continue;
      const base = {
        at,
        sessionId: event.sessionId,
        action: 'nudge' as const,
        by: 'warden' as const,
        actor: 'auto' as const,
      };
      try {
        await this.ports.remedies.nudge(event.sessionId, REFLEX_NUDGE_MESSAGE);
        state = this.recordAction(state, {
          ...base,
          outcome: 'done',
          detail: `Nudged: no output, screen change or subprocess for ${quiet} min.`,
        });
        this.ports.journal.record('fleet.warden_reflex_nudged', { sessionId: event.sessionId, quietMinutes: quiet });
      } catch (error) {
        state = this.recordAction(state, {
          ...base,
          outcome: 'failed',
          detail: `The nudge did not take: ${failureMessage(error)}.`,
        });
      }
    }
    await this.ports.state.write(state);
    return { frozen: events.some(event => event.kind === 'frozen') };
  }

  /** The settings in effect, and nothing else — cheap enough to read on every session event. */
  async currentConfig(): Promise<WardenConfig> {
    return parseStoredWardenConfig(await this.ports.config.read()).config;
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
   * vanished — BEFORE anything can be skipped on the strength of one — and with
   * them the clear streaks and Jev's answers that no longer describe a standing
   * flag.
   *
   * The early revocation is journalled: a session that STOPS being skipped must
   * be explicable rather than mysterious.
   */
  private pruneClears(
    state: WardenRuntimeState,
    fleet: readonly WardenFleetSession[],
    anomalies: readonly WardenAnomaly[],
    nowMs: number,
  ): WardenRuntimeState {
    const statuses = new Map(fleet.map(session => [session.config.id, session.state.status]));
    const pruned = reconcileBlessings(state.blessings ?? {}, statuses, nowMs);
    for (const sessionId of pruned.revoked) this.ports.journal.record('fleet.warden_bless_revoked', { sessionId });
    const live = new Set(fleet.filter(session => !isTerminalStatus(session.state.status)).map(s => s.config.id));
    return {
      ...state,
      blessings: pruned.store,
      clearStreaks: reconcileClearStreaks(state.clearStreaks ?? {}, statuses, anomalies, pruned.store, nowMs),
      passedOn: prunePassedOn(state.passedOn ?? [], anomalies),
      jevCapSkips: pruneCapSkips(state.jevCapSkips ?? [], anomalies, nowMs),
      jevBefore: pruneJevBefore(state.jevBefore ?? {}, anomalies),
      backoff: reconcileBackoff(state.backoff ?? {}, live, nowMs),
    };
  }

  /**
   * Clear flags: bless them for a lifetime that doubles with each clear in a row, merged into any
   * blessing the ferret already holds in the same status, and count the clear into the streak.
   */
  private clearFlags(
    state: WardenRuntimeState,
    request: {
      readonly sessionId: string;
      readonly kinds: readonly WardenAnomaly['kind'][];
      readonly status: WardenFleetSession['state']['status'];
      readonly by: 'jev' | 'warden';
      readonly wardenId?: string;
    },
    config: WardenConfig,
    nowMs: number,
  ): { readonly state: WardenRuntimeState; readonly ttlMs: number; readonly streak: number } {
    const streaks = state.clearStreaks ?? {};
    const streak = clearStreak(streaks, request.sessionId, request.kinds, request.status);
    const ttlMs = growingBlessingMs(config.blessMinutes, streak);
    return {
      ttlMs,
      streak,
      state: {
        ...state,
        blessings: mergeBlessing(state.blessings ?? {}, { ...request, streak }, nowMs, ttlMs),
        clearStreaks: recordClears(streaks, request.sessionId, request.kinds, request.status),
      },
    };
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
   * Reconcile finished assignments, then triage and spawn what the gate allows.
   *
   * The reconciliation runs even when there is nothing to spawn and even when
   * the Warden is off: a finished warden left in the assignment record holds
   * its target's slot forever and reads as "still under investigation" on every
   * surface that joins the two — and its verdict, once read, is acted on.
   *
   * WHAT REACHES THE GATE. The owner's own requests always do (they were refused
   * at the door if the Warden is off or the cap is hit). The sweep's flags reach
   * it only while the LLM layer is on. Before that, with the Jev layer on, each
   * NEW flag is put to Jev, which settles what it is sure enough about — leaves
   * it, or acts on it alone (`triage.ts`); a flag Jev hands on with
   * investigations off is the owner's to read, never a spawn. A flag already
   * queued, investigated or cooling down is never put to Jev again — that would
   * pay for the same answer every sweep — and neither is a subject Jev already
   * acted on.
   */
  private async runAssigned(input: {
    readonly anomalies: readonly WardenAnomaly[];
    readonly fleet: readonly WardenFleetSession[];
    readonly config: WardenConfig;
    readonly login: ResolvedWardenLogin;
    readonly state: WardenRuntimeState;
    readonly at: string;
    readonly force: boolean;
  }): Promise<{ readonly state: WardenRuntimeState; readonly spawned: readonly string[] }> {
    const byId = new Map(input.fleet.map(session => [session.config.id, session]));
    const queuedBefore = input.state.assignedQueue ?? [];
    const held = Object.keys(input.state.assignments ?? {}).length > 0;
    if (input.anomalies.length === 0 && queuedBefore.length === 0 && !held) return { state: input.state, spawned: [] };

    const reconciled = await this.reconcileAssignments(input.state, byId, input.config, input.at);
    let state = reconciled.state;
    // Off: the reconciliation above still had to happen, and its result is
    // persisted, but nothing new is triaged or spawned.
    if (!input.force && !input.config.enabled) {
      await this.ports.state.write(state);
      return { state, spawned: [] };
    }

    const nowMs = this.ports.nowMs();
    const budget = this.budget(input.config, state, nowMs, input.login.usable);
    const investigating = input.force || budget.layers.llm.active;
    const guarding = !input.force && budget.layers.jev.active;
    const meta: Record<string, WardenQueueEntryMeta> = { ...(state.queueMeta ?? {}) };
    // A flag queued while investigations were on is no longer the Warden's to
    // investigate once the owner turns them off. One queued while a cap or a
    // missing login holds them off waits in its place; the owner's own requests
    // always keep theirs.
    // A situation already looked at waits its rung of the backoff, and one already cleared waits for
    // its subject to change (`backoff.ts`) — queued or fresh alike. The owner's requests never wait.
    const backoffBase = assignedCooldownMs(input.config);
    const heldOff = (anomaly: WardenAnomaly): boolean =>
      !input.force &&
      anomaly.kind !== 'owner_request' &&
      backoffHold(state.backoff ?? {}, anomaly, nowMs, backoffBase) !== undefined;
    const queued = queuedBefore.filter(
      anomaly =>
        (investigating || input.config.layers.llm || meta[anomaly.sessionId]?.origin === 'owner') &&
        (meta[anomaly.sessionId]?.origin === 'owner' || !heldOff(anomaly)),
    );
    const isOwnerRequest = (targetId: string): boolean =>
      queued.some(anomaly => anomaly.sessionId === targetId && anomaly.kind === 'owner_request');

    const blessings = state.blessings ?? {};
    const cooldown = assignedCooldownMs(input.config);
    const assignments = state.assignments ?? {};
    const cooldowns = state.assignedCooldowns ?? {};
    const isStillSuspect = (targetId: string): boolean => {
      const target = byId.get(targetId);
      if (target === undefined || isTerminalStatus(target.state.status)) return false;
      if (assignments[targetId] !== undefined) return false;
      // The owner asked: no cooldown applies, and no anomaly needs to persist.
      if (isOwnerRequest(targetId)) return true;
      const cooledAt = Date.parse(cooldowns[targetId] ?? '');
      return input.force || !Number.isFinite(cooledAt) || nowMs - cooledAt >= cooldown;
    };

    // A blessed anomaly must not even become a candidate, so it can never occupy
    // the single warden slot. Narrow: the exact kinds a warden cleared, only
    // while the session still holds the status it was cleared in.
    const unblessed = input.anomalies.filter(anomaly => {
      const target = byId.get(anomaly.sessionId);
      if (heldOff(anomaly)) return false;
      return target === undefined || !isAnomalyBlessed(blessings, anomaly, target.state.status, nowMs);
    });

    const queuedIds = new Set(queued.map(anomaly => anomaly.sessionId));
    const askable = (anomaly: WardenAnomaly): boolean =>
      guarding && !queuedIds.has(anomaly.sessionId) && isStillSuspect(anomaly.sessionId);
    const jev = await this.passThroughJev(unblessed.filter(askable), input.config, state, byId, investigating);
    state = jev.state;
    // Jev switched off by its cap is still a check the owner should see was skipped, once per flag.
    if (!input.force && jevCapped(budget.layers.jev)) {
      const unasked = unblessed.filter(
        anomaly => !queuedIds.has(anomaly.sessionId) && isStillSuspect(anomaly.sessionId),
      );
      state = await this.noteCapSkips(state, unasked, input.config, investigating, nowMs);
    }
    const passed = new Set(jev.passed);
    const viaJev = new Set(jev.passed.map(anomaly => anomaly.sessionId));
    const candidates = investigating ? unblessed.filter(anomaly => !askable(anomaly) || passed.has(anomaly)) : [];
    const originOf = (targetId: string): WardenInvestigationOrigin =>
      meta[targetId]?.origin ?? (viaJev.has(targetId) ? 'jev' : 'sweep');

    // A fresh anomaly supersedes a queued copy of the same target: it describes
    // the situation as it is now rather than as it was one sweep ago. The one
    // exception is the owner's request, which no flag may overwrite.
    const anomalyById = new Map<string, WardenAnomaly>();
    for (const anomaly of [...queued, ...candidates]) {
      if (anomalyById.get(anomaly.sessionId)?.kind === 'owner_request') continue;
      anomalyById.set(anomaly.sessionId, anomaly);
    }

    // With investigations off — a cap reached, no login — only the owner's own
    // requests may start; the sweep's queued flags wait for them to come back,
    // in their place.
    const waiting = investigating ? [] : queued.filter(anomaly => anomaly.kind !== 'owner_request');
    const decision = decideAssignedWardens({
      maxConcurrent: input.config.maxAssignedWardens,
      live: this.liveWardens(input.fleet, state),
      candidates: candidates.map(anomaly => anomaly.sessionId),
      queued: queued.filter(anomaly => !waiting.includes(anomaly)).map(anomaly => anomaly.sessionId),
      isStillSuspect,
    });

    // The hourly limit and the investigation cap are budgets, not slots: what
    // they hold back is queued, never dropped, and starts once they allow it.
    const spend = budget.spend;
    const allowed = input.force
      ? decision.spawn.length
      : spend.capsHit.includes('investigation')
        ? 0
        : Math.max(0, input.config.caps.maxInvestigationsPerHour - spend.investigationsLastHour);
    const spawnNow = decision.spawn.slice(0, allowed);
    const heldBack = decision.spawn.slice(allowed);

    const spawned: string[] = [];
    /** Targets skipped because every account was ineligible. Queued, never
     *  cooled down, so the next sweep after any account recovers retries them. */
    const deferred: string[] = [];
    let nextAssignments = { ...assignments };
    let nextCooldowns = { ...cooldowns };
    let records = state.investigations ?? [];
    for (const targetId of spawnNow) {
      const anomaly = anomalyById.get(targetId);
      const target = byId.get(targetId);
      if (anomaly === undefined || target === undefined) continue;
      const reportPath = this.ports.artifacts.reportPath(input.at, targetId);
      const capability = this.ports.capabilities();
      // Per spawn, so round-robin rotates across targets and fallback re-checks
      // the preferred account every time; a login that fails to start hands the
      // same spawn to the next one, within this sweep.
      const result = await this.spawnOnAnyAccount(
        input.login.accounts,
        input.config,
        state,
        {
          name: `Investigate ${target.config.teammate === undefined ? targetId.slice(0, 8) : displayAgentName(target.config.teammate)}`,
          prompt: buildAssignedWardenPrompt(anomaly, target, reportPath, this.settings),
          cwd: this.settings.wardenCwd,
          effort: input.config.investigation.effort,
          stopCapability: capability,
        },
        { targetId },
      );
      state = result.state;
      if (result.started === undefined) {
        if (result.exhausted) {
          deferred.push(targetId);
          continue;
        }
        // The target cooldown damps a genuinely target-scoped failure and stops a
        // same-sweep hot loop; the STRIKES are what route the next spawn to
        // another account, which is the fault that actually needs routing.
        nextCooldowns = { ...nextCooldowns, [targetId]: input.at };
        delete meta[targetId];
        continue;
      }
      const { facts, selection } = result.started;
      const investigator = result.started.investigator;
      await this.writeProvenance(reportPath, facts, selection, targetId, investigator);
      // Only the kind this warden was actually shown. A sibling kind it was never
      // asked about stays visibly unjudged rather than borrowing its verdict.
      nextAssignments = {
        ...nextAssignments,
        [targetId]: {
          wardenId: facts.sessionId,
          spawnedAt: input.at,
          capability,
          kinds: [anomaly.kind],
          reportPath,
          ...(anomaly.subject === undefined ? {} : { subject: anomaly.subject }),
        },
      };
      records = [
        {
          id: facts.sessionId,
          scope: 'session',
          origin: anomaly.kind === 'owner_request' ? 'owner' : originOf(targetId),
          targetId,
          anomalyKind: anomaly.kind,
          startedAt: input.at,
          reportPath,
          agent: facts.agent,
          ...(facts.model === undefined ? {} : { model: facts.model }),
          ...(investigator === undefined ? {} : { wardenName: investigator }),
          jev: jevBeforeInvestigation({
            kind: anomaly.kind,
            ...optionalLast(state.jevBefore?.[jevHandoffKey(targetId, anomaly.kind)]),
            jevOn: input.config.layers.jev,
            force: input.force,
          }),
        },
        ...records,
      ];
      // The investigation looks for itself: once it is done, a flag that still stands is put to Jev afresh —
      // and what Jev said before is this investigation's, not the next one's.
      state = {
        ...state,
        passedOn: forgetPassedOn(state.passedOn ?? [], targetId),
        jevBefore: forgetJevBefore(state.jevBefore ?? {}, targetId, anomaly.kind),
      };
      delete meta[targetId];
      spawned.push(facts.sessionId);
      this.ports.journal.record('fleet.warden_assigned', {
        wardenId: facts.sessionId,
        ...(investigator === undefined ? {} : { investigator: displaySystemCallsign(investigator) }),
        targetId,
        kind: anomaly.kind,
        reportPath,
      });
    }

    if (decision.dropped.length > 0)
      this.ports.journal.record('fleet.warden_dequeued', { targets: decision.dropped, reason: 'recovered' });
    for (const targetId of decision.dropped) delete meta[targetId];

    const carried = [
      ...[...heldBack, ...decision.queue, ...deferred]
        .map(targetId => anomalyById.get(targetId))
        .filter((anomaly): anomaly is WardenAnomaly => anomaly !== undefined),
      ...waiting,
    ];
    for (const anomaly of carried)
      meta[anomaly.sessionId] ??= {
        queuedAt: input.at,
        origin: anomaly.kind === 'owner_request' ? 'owner' : originOf(anomaly.sessionId),
      };
    for (const targetId of Object.keys(meta))
      if (!carried.some(anomaly => anomaly.sessionId === targetId)) delete meta[targetId];
    state = {
      ...state,
      assignments: nextAssignments,
      assignedCooldowns: nextCooldowns,
      assignedQueue: carried,
      queueMeta: meta,
      investigations: retainRecords(records, input.at.slice(0, 10), WARDEN_HISTORY_LIMIT),
    };
    await this.ports.state.write(state);
    return { state, spawned };
  }

  /**
   * Put flags to Jev, once each, and return the ones it handed on — to an investigation when one can
   * follow, to the owner otherwise.
   *
   * A flag Jev already handed on while it stands is handed on again without a call. Once today's Jev
   * cap is reached part-way, the rest are handed on unasked: the cap turns off Jev, not the layers
   * after it. Only a REAL answer is remembered — a failure, a back-off or an unredactable snapshot is
   * asked again next sweep, so a blip never becomes a permanent "Jev could not settle it".
   *
   * ONE TRY: a subject Jev already acted on is not asked about again. While the act still has time to
   * land the flag is neither asked about nor handed on; after that it is handed on unasked.
   */
  private async passThroughJev(
    anomalies: readonly WardenAnomaly[],
    config: WardenConfig,
    state: WardenRuntimeState,
    byId: ReadonlyMap<string, WardenFleetSession>,
    investigating: boolean,
  ): Promise<{ readonly state: WardenRuntimeState; readonly passed: readonly WardenAnomaly[] }> {
    let next = state;
    const passed: WardenAnomaly[] = [];
    let capped = false;
    const nowMs = this.ports.nowMs();
    for (const anomaly of anomalies) {
      const key = passedOnKey(anomaly);
      const tried = jevActStanding(next.backoff ?? {}, anomaly, nowMs);
      if (tried?.standing === 'landing') continue;
      if (tried?.standing === 'escalate') {
        passed.push(anomaly);
        if (!(next.passedOn ?? []).includes(key)) next = this.handOnAfterAct(next, anomaly, key, nowMs);
        continue;
      }
      if ((next.passedOn ?? []).includes(key)) {
        passed.push(anomaly);
        continue;
      }
      // A flag Jev cannot judge is handed on unasked, and remembered so it is noted once, not per sweep.
      if (!jevJudges(anomaly)) {
        passed.push(anomaly);
        this.ports.journal.record('fleet.warden_jev_handed_on', {
          sessionId: anomaly.sessionId,
          kind: anomaly.kind,
          why: 'not_judgeable',
        });
        next = withJevBefore(
          withJevHandoff(
            { ...next, passedOn: [...(next.passedOn ?? []), key] },
            anomaly,
            { why: 'not_judgeable', confidence: 0 },
            nowMs,
          ),
          anomaly,
          { verdict: 'not_asked', why: 'not_judgeable' },
        );
        continue;
      }
      if (capped) {
        passed.push(anomaly);
        next = await this.noteCapSkip(next, anomaly, config, investigating, nowMs);
        continue;
      }
      const guarded = await this.askGuard(anomaly, config, next, byId, investigating);
      next = guarded.state;
      if (guarded.outcome === undefined) {
        capped = true;
        passed.push(anomaly);
        next = await this.noteCapSkip(next, anomaly, config, investigating, nowMs);
        continue;
      }
      if (guarded.settled) continue;
      passed.push(anomaly);
      if (guarded.decided) next = { ...next, passedOn: [...(next.passedOn ?? []), key] };
      // Why it was handed on, for the owner's notification when no investigation can follow (`owner-routes.ts`).
      if (guarded.outcome.kind === 'escalate') next = withJevHandoff(next, anomaly, guarded.outcome, nowMs);
    }
    return { state: next, passed };
  }

  /**
   * Hand on, once, a flag Jev already acted on: journal it, and — when the act was on this very subject
   * — take the act back out of today's savings, since the flag it did not settle is now someone else's.
   */
  private handOnAfterAct(
    state: WardenRuntimeState,
    anomaly: WardenAnomaly,
    key: string,
    nowMs: number,
  ): WardenRuntimeState {
    const acted = state.backoff?.[`${anomaly.sessionId}|${anomaly.kind}`]?.jevActed;
    const same = acted?.subject === jevSubject(anomaly);
    this.ports.journal.record('fleet.warden_jev_handed_on', {
      sessionId: anomaly.sessionId,
      kind: anomaly.kind,
      why: 'already_acted',
      ...(acted === undefined ? {} : { action: acted.action, actedAt: acted.at, sameSubject: same }),
    });
    const today = triageDayFor(state.triageDay, nowMs);
    const handedOn = withJevHandoff(state, anomaly, { why: 'already_acted', confidence: 0 }, nowMs);
    const before = state.jevBefore?.[jevHandoffKey(anomaly.sessionId, anomaly.kind)];
    return {
      ...(before === undefined
        ? withJevBefore(handedOn, anomaly, { verdict: 'not_asked', why: 'already_acted' })
        : handedOn),
      passedOn: [...(state.passedOn ?? []), key],
      triageDay: same ? retractJevAction(today, instantMs(acted?.at)) : today,
    };
  }

  /**
   * Put one flag to Jev, the first responder, and do what its answer allows (`triage.ts`
   * {@link firstResponse}).
   *
   * `outcome` is `undefined` when the Jev cap is already reached: Jev is not called, and the flag is
   * handed on unasked. While Jev is backing off, the flag is handed on without a call. A snapshot the
   * vault redactor cannot scrub is NEVER sent: that flag is handed on instead. `decided` is true only
   * for a real answer, which is the only one worth remembering. `settled` is true when nothing is left
   * to hand on: Jev left the flag, or its act took.
   *
   * - LEAVE clears the flag's kind for a lifetime that grows with each clear in a row, and holds its
   *   subject until it changes — as an investigation's LEAVE does.
   * - An ACT goes through the same remedies, journal and actions list as an investigation's verdict,
   *   as Jev's; its subject is remembered so Jev never acts on it twice. An act that does not take is
   *   handed on.
   * - Anything else is handed on; a recommendation Jev was sure of but could not carry out is put in
   *   front of the owner as held when no investigation can follow.
   */
  private async askGuard(
    anomaly: WardenAnomaly,
    config: WardenConfig,
    state: WardenRuntimeState,
    byId: ReadonlyMap<string, WardenFleetSession>,
    investigating: boolean,
  ): Promise<{
    readonly state: WardenRuntimeState;
    readonly outcome?: WardenGuardOutcome;
    readonly decided?: boolean;
    readonly settled?: boolean;
  }> {
    const nowMs = this.ports.nowMs();
    const at = new Date(nowMs).toISOString();
    const today = triageDayFor(state.triageDay, nowMs);
    if (!jevWithinBudget(today, config.caps, nowMs)) return { state };
    const health = state.guard ?? {};
    if (guardBackingOff(health, nowMs))
      return {
        state: withJevBefore(state, anomaly, { verdict: 'not_asked', why: 'backoff' }),
        outcome: { kind: 'escalate', why: 'failed', confidence: 0 },
      };

    const evidence = await this.ports.evidence.evidence(anomaly.sessionId).catch(() => ({ recentTurns: [] }));
    let snapshot: Awaited<ReturnType<typeof redactTriageSnapshot>>;
    try {
      snapshot = await redactTriageSnapshot(triageSnapshotOf(anomaly, evidence), this.ports.redactor);
    } catch {
      this.ports.journal.record('fleet.warden_guard_unredacted', { sessionId: anomaly.sessionId, kind: anomaly.kind });
      return {
        state: withJevBefore({ ...state, guard: { ...health, lastFailure: { code: 'unredacted', at } } }, anomaly, {
          verdict: 'not_asked',
          why: 'unredacted',
        }),
        outcome: { kind: 'escalate', why: 'failed', confidence: 0, failure: 'unredacted' },
      };
    }
    const decision: TriageDecision = await this.ports
      .guard(config.guard)
      .decide(snapshot)
      .catch(
        (): TriageDecision => ({
          verdict: 'unsure',
          confidence: 0,
          model: config.guard.model,
          inputTokens: 0,
          latencyMs: 0,
          failure: { code: 'provider_error' },
        }),
      );
    const outcome = firstResponse(decision, {
      leaveThreshold: config.guard.threshold,
      offered: jevActsFor(anomaly),
      acts: config.jevActs,
      mayActAlone: config.mayActAlone,
    });
    let next: WardenRuntimeState = {
      ...state,
      triageDay: recordGuardDecision(today, decision, outcome, nowMs),
      guard: guardHealthAfter(health, decision, nowMs),
    };
    this.ports.journal.record('fleet.warden_guarded', {
      sessionId: anomaly.sessionId,
      kind: anomaly.kind,
      verdict: decision.verdict,
      outcome: outcome.kind,
      confidence: outcome.confidence,
      ...(outcome.kind === 'escalate' ? { why: outcome.why, route: investigating ? 'investigation' : 'owner' } : {}),
      ...(decision.failure === undefined ? {} : { failure: decision.failure.code }),
    });
    const decided = decision.failure === undefined;
    const target = byId.get(anomaly.sessionId);
    const check = (took?: boolean) =>
      jevCheckOf({
        anomaly,
        decision,
        outcome,
        route: investigating ? 'investigation' : 'owner',
        nowMs,
        ...(took === undefined ? {} : { took }),
      });
    const base = {
      at,
      sessionId: anomaly.sessionId,
      by: 'jev' as const,
      actor: 'jev' as const,
      anomalyKind: anomaly.kind,
      confidence: outcome.confidence,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    };
    if (outcome.kind === 'leave' && target !== undefined) {
      const cleared = this.clearFlags(
        next,
        { sessionId: anomaly.sessionId, kinds: [anomaly.kind], status: target.state.status, by: 'jev' },
        config,
        nowMs,
      );
      // Jev's confident leave holds this subject like an investigation's LEAVE: until it changes.
      next = { ...cleared.state, backoff: recordLook(cleared.state.backoff ?? {}, anomaly, nowMs, true) };
      next = this.recordAction(next, {
        ...base,
        action: 'bless',
        outcome: 'done',
        detail: `Jev was ${Math.round(outcome.confidence * 100)}% sure it is healthy, so this flag is left alone ${leftAloneNote(anomaly.subject, cleared.ttlMs, cleared.streak)}.`,
      });
      return { state: await this.noteJevCheck(next, check()), outcome, decided, settled: true };
    }
    if (outcome.kind === 'act') {
      const act: WardenVerdictAct = { action: outcome.act, reason: outcome.reason };
      const sure = `Jev, ${Math.round(outcome.confidence * 100)}% sure`;
      const done = await this.carryOut(
        next,
        anomaly.sessionId,
        act,
        { ...base, action: act.action },
        {
          detail: (result, error) => jevActDetail(act.action, act.reason, outcome.confidence, result, error),
          nudge: jevNudgeMessage(outcome.message ?? ''),
          stopReason: `${sure}: ${act.reason}`,
        },
      );
      next = await this.noteJevCheck(done.state, check(done.done));
      if (!done.done) return { state: next, outcome, decided, settled: false };
      next = {
        ...next,
        triageDay: recordJevAction(next.triageDay ?? today),
        backoff: recordJevAct(next.backoff ?? {}, anomaly, nowMs, outcome.act, assignedCooldownMs(config)),
      };
      return { state: next, outcome, decided, settled: true };
    }
    if (outcome.kind === 'escalate' && outcome.recommends !== undefined && !investigating && target !== undefined) {
      this.ports.journal.record('fleet.warden_action_held', {
        targetId: anomaly.sessionId,
        action: outcome.recommends,
        by: 'jev',
        confidence: outcome.confidence,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      });
      next = this.recordAction(next, {
        ...base,
        action: outcome.recommends,
        outcome: 'held',
        detail: jevActDetail(outcome.recommends, decision.reason ?? outcome.recommends, outcome.confidence, 'held'),
      });
    }
    return { state: await this.noteJevCheck(next, check()), outcome, decided, settled: false };
  }

  /**
   * Write one of Jev's checks beside the reports and count it into its day. A record that cannot be
   * written costs that record — said in the journal — and never the sweep: the flag is already decided.
   */
  private async noteJevCheck(state: WardenRuntimeState, check: WardenJevCheck): Promise<WardenRuntimeState> {
    await this.ports.jevChecks.append(check).catch((error: unknown) => {
      this.ports.journal.record('fleet.warden_jev_check_unwritten', {
        sessionId: check.sessionId,
        kind: check.anomalyKind,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const counted = recordWardenJevCheck(state, check);
    // A healthy check settled its flag: there is nothing for an investigation to say Jev did first.
    return check.verdict === 'healthy'
      ? counted
      : withJevBefore(
          counted,
          { sessionId: check.sessionId, kind: check.anomalyKind },
          jevBeforeOf({ ...check, verdict: check.verdict }),
        );
  }

  /**
   * Note every flag the sweep hands on without asking Jev because its cap is spent: those Jev would have
   * been asked about — not one it already answered while it stands, nor one it never judges.
   */
  private async noteCapSkips(
    state: WardenRuntimeState,
    anomalies: readonly WardenAnomaly[],
    config: WardenConfig,
    investigating: boolean,
    nowMs: number,
  ): Promise<WardenRuntimeState> {
    let next = state;
    for (const anomaly of anomalies) {
      if ((next.passedOn ?? []).includes(passedOnKey(anomaly)) || !jevJudges(anomaly)) continue;
      next = await this.noteCapSkip(next, anomaly, config, investigating, nowMs);
    }
    return next;
  }

  /**
   * Note, once while it stands, a flag handed on without asking Jev because its cap — the day's, or this
   * hour's share of it — is spent. Handed on again every sweep, it is written down only the first time.
   */
  private async noteCapSkip(
    state: WardenRuntimeState,
    anomaly: WardenAnomaly,
    config: WardenConfig,
    investigating: boolean,
    nowMs: number,
  ): Promise<WardenRuntimeState> {
    const today = triageDayFor(state.triageDay, nowMs);
    const key = capSkipKey(anomaly, today.day);
    if ((state.jevCapSkips ?? []).includes(key)) return state;
    const why = today.jevUsd >= config.caps.jevUsdPerDay ? 'jev_cap' : 'jev_paced';
    const skip = jevCapSkipOf(anomaly, why, investigating ? 'investigation' : 'owner', nowMs);
    return this.noteJevCheck({ ...state, jevCapSkips: [...(state.jevCapSkips ?? []), key] }, skip);
  }

  /**
   * Close what finished ferrets left running, by rule (`leftovers.ts`): no Jev, no investigation, no
   * spend. Only while the Warden is on, and only alone when the owner lets it close leftovers alone —
   * otherwise the recommendation is put in front of them, once per leftover. Every close, hold and
   * failure is listed under Recent actions and journalled.
   */
  private async closeLeftovers(
    state: WardenRuntimeState,
    fleet: readonly WardenFleetSession[],
    config: WardenConfig,
    nowMs: number,
  ): Promise<WardenRuntimeState> {
    if (!config.enabled) return state;
    const at = new Date(nowMs).toISOString();
    let next = state;
    for (const candidate of leftoverBrowserCandidates(fleet, nowMs, { tickSeconds: DEFAULT_TICK_SECONDS })) {
      const base = {
        at,
        sessionId: candidate.sessionId,
        action: 'close_leftover' as const,
        by: 'warden' as const,
        actor: 'auto' as const,
      };
      // Said once per leftover: a hold or a failure repeated every sweep would bury the list.
      const said = (next.actions ?? []).some(
        action =>
          action.sessionId === candidate.sessionId &&
          action.action === 'close_leftover' &&
          action.outcome !== 'done' &&
          (instantMs(action.at) ?? 0) >= (instantMs(candidate.since) ?? 0),
      );
      if (said) continue;
      if (!config.mayActAlone.closeLeftovers) {
        next = this.recordAction(next, {
          ...base,
          outcome: 'held',
          detail:
            'A browser this ferret launched is still running after its turn ended. The Warden would close it (never the ferret), but closing leftovers alone is off — turn on Close leftover browsers in Settings › Warden, or close it from the ferret’s terminal.',
        });
        continue;
      }
      try {
        const closed = await this.ports.remedies.closeLeftoverBrowsers(candidate.sessionId);
        if (closed === 0) continue;
        next = this.recordAction(next, {
          ...base,
          outcome: 'done',
          detail: `Closed ${closed === 1 ? 'a leftover browser' : `${closed} leftover browsers`}: its turn had ended and nothing else of its own was running. The ferret itself was not touched.`,
        });
        this.ports.journal.record('fleet.warden_leftover_closed', {
          sessionId: candidate.sessionId,
          browsers: closed,
          since: candidate.since,
        });
      } catch (error) {
        next = this.recordAction(next, {
          ...base,
          outcome: 'failed',
          detail: `Closing its leftover browser did not take: ${failureMessage(error)}.`,
        });
      }
    }
    return next;
  }

  /**
   * Newest first, bounded: the list the owner reads as "Recent actions" — and the ONE place an action
   * is counted toward the day's stats, stamped with who acted and, for an investigation's verdict, which
   * investigator it was.
   */
  private recordAction(state: WardenRuntimeState, action: WardenAction): WardenRuntimeState {
    const record =
      action.reportPath === undefined
        ? undefined
        : state.investigations?.find(entry => entry.reportPath === action.reportPath);
    const investigator = action.investigator ?? record?.wardenName;
    // An investigation's act says what Jev did first, so the list never shows an LLM verdict without it.
    const jev = action.jev ?? record?.jev;
    const stamped: WardenAction = {
      ...action,
      actor: action.actor ?? wardenActionActor(action),
      ...(investigator === undefined ? {} : { investigator }),
      ...(jev === undefined ? {} : { jev }),
    };
    return recordWardenOutcome(
      { ...state, actions: [stamped, ...(state.actions ?? [])].slice(0, WARDEN_HISTORY_LIMIT) },
      stamped,
    );
  }

  /**
   * Retire assignments whose warden is gone: bless the target when — and only
   * when — the report it left says the session was CLEARED, and carry out what
   * an explicit verdict asks for, as far as the owner allowed.
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
    let next: WardenRuntimeState = state;
    const nowMs = this.ports.nowMs();

    for (const [targetId, record] of Object.entries(assignments)) {
      const warden = byId.get(record.wardenId);
      if (warden !== undefined && !isTerminalStatus(warden.state.status)) continue;
      const report = await this.ports.artifacts.readReport(record.reportPath).catch(() => undefined);
      const readable = report !== undefined && report.trim() !== '';
      const verdict = readable ? classifyVerdict(report) : undefined;
      next = {
        ...next,
        investigations: (next.investigations ?? []).map(entry =>
          entry.id === record.wardenId
            ? { ...entry, finishedAt: entry.finishedAt ?? at, ...(verdict === undefined ? {} : { verdict }) }
            : entry,
        ),
      };
      next = this.blessIfCleared(next, targetId, record, byId, verdict, config, nowMs, at);
      // Paid for: the next look at the same subject waits a rung longer, and a cleared one waits for it
      // to change. An unreadable report is no answer, so it counts as a look but never as a clearance.
      let backoff = next.backoff ?? {};
      for (const kind of record.kinds)
        backoff = recordLook(
          backoff,
          { sessionId: targetId, kind, subject: record.subject },
          nowMs,
          verdict === 'cleared',
        );
      next = { ...next, backoff };
      if (readable) next = await this.actOnVerdict(next, targetId, record, report, byId, config, at);
      delete assignments[targetId];
      cooldowns[targetId] = at;
    }
    return { state: { ...next, assignments, assignedCooldowns: cooldowns } };
  }

  /** Clear the kinds a finished warden was shown — when, and only when, its report says CLEARED. */
  private blessIfCleared(
    state: WardenRuntimeState,
    targetId: string,
    record: WardenAssignmentRecord,
    byId: ReadonlyMap<string, WardenFleetSession>,
    verdict: ReturnType<typeof classifyVerdict> | undefined,
    config: WardenConfig,
    nowMs: number,
    at: string,
  ): WardenRuntimeState {
    const target = byId.get(targetId);
    if (target === undefined || record.kinds.length === 0 || verdict !== 'cleared') return state;
    const cleared = this.clearFlags(
      state,
      {
        sessionId: targetId,
        kinds: record.kinds,
        status: target.state.status,
        wardenId: record.wardenId,
        by: 'warden',
      },
      config,
      nowMs,
    );
    this.ports.journal.record('fleet.warden_blessed', {
      targetId,
      wardenId: record.wardenId,
      kinds: record.kinds,
      expiresAt: cleared.state.blessings?.[targetId]?.expiresAt,
      streak: cleared.streak,
    });
    return this.recordAction(cleared.state, {
      at,
      sessionId: targetId,
      action: 'bless',
      outcome: 'done',
      by: 'warden',
      actor: 'llm',
      ...(record.kinds[0] === undefined ? {} : { anomalyKind: record.kinds[0] }),
      reportPath: record.reportPath,
      detail: `The investigation found it healthy, so this flag is left alone ${leftAloneNote(record.subject, cleared.ttlMs, cleared.streak)}.`,
    });
  }

  /**
   * Carry out an explicit verdict, as far as the owner allowed — the ONLY path by which the Warden acts.
   *
   * The marker alone authorizes: a report that drifted off the template is indexed for reading and
   * never executed. A ferret that has finished since is left alone — the verdict judged a situation
   * that no longer exists. An act the owner did not allow is HELD, which puts it in front of them.
   */
  private async actOnVerdict(
    state: WardenRuntimeState,
    targetId: string,
    record: WardenAssignmentRecord,
    report: string,
    byId: ReadonlyMap<string, WardenFleetSession>,
    config: WardenConfig,
    at: string,
  ): Promise<WardenRuntimeState> {
    const target = byId.get(targetId);
    if (target === undefined || isTerminalStatus(target.state.status)) return state;
    const parsed = parseWardenReports([{ path: record.reportPath, content: report, mtimeMs: this.ports.nowMs() }]);
    const recommendation = (parsed.find(entry => entry.targetSession === targetId) ?? parsed[0])?.recommendation;
    const act = verdictAct(structuredVerdict(report), recommendation);
    if (act === undefined) return state;
    const base = {
      at,
      sessionId: targetId,
      action: act.action,
      by: 'warden' as const,
      actor: 'llm' as const,
      ...(record.kinds[0] === undefined ? {} : { anomalyKind: record.kinds[0] }),
      reportPath: record.reportPath,
      ...(act.action === 'failover' ? { agent: act.agent } : {}),
    };
    if (!mayActAlone(act, config.mayActAlone)) {
      this.ports.journal.record('fleet.warden_action_held', { targetId, action: act.action, by: 'warden' });
      return this.recordAction(state, { ...base, outcome: 'held', detail: wardenActDetail(act, 'held') });
    }
    const done = await this.carryOut(state, targetId, act, base, {
      detail: (outcome, error) => wardenActDetail(act, outcome, error),
      nudge: wardenNudgeMessage(act.reason),
      stopReason: `Warden verdict: ${act.reason}`,
    });
    return done.state;
  }

  /**
   * Carry out one act the owner let the Warden do alone — THE one remedy path, for an investigation's
   * verdict and for Jev alike: the same remedies, the same journal events (naming who decided) and the
   * same Recent actions row. The caller has already applied `mayActAlone`.
   */
  private async carryOut(
    state: WardenRuntimeState,
    targetId: string,
    act: WardenVerdictAct,
    base: Omit<WardenAction, 'outcome' | 'detail'>,
    words: {
      readonly detail: (outcome: 'done' | 'failed', error?: string) => string;
      readonly nudge: string;
      readonly stopReason: string;
    },
  ): Promise<{ readonly state: WardenRuntimeState; readonly done: boolean }> {
    // Read the fleet afresh: the sweep's snapshot is older than the verdict, and nothing else stands in
    // front of these remedies, so a ferret gone or finished since is never restarted, resumed or stopped.
    const target = (await this.ports.fleet.fleet()).find(session => session.config.id === targetId);
    if (target === undefined || isTerminalStatus(target.state.status)) return { state, done: false };
    try {
      if (act.action === 'failover') await this.ports.remedies.failover(targetId, act.agent);
      else if (act.action === 'nudge') await this.ports.remedies.nudge(targetId, words.nudge);
      else if (act.action === 'resume') await this.ports.remedies.resume(targetId);
      else if (act.action === 'restart') await this.ports.remedies.restart(targetId);
      else await this.ports.remedies.stop(targetId, words.stopReason);
    } catch (error) {
      const message = failureMessage(error);
      this.ports.journal.record('fleet.warden_action_failed', {
        targetId,
        action: act.action,
        by: base.by,
        message,
        ...(base.confidence === undefined ? {} : { confidence: base.confidence }),
        ...(base.reason === undefined ? {} : { reason: base.reason }),
      });
      return {
        state: this.recordAction(state, { ...base, outcome: 'failed', detail: words.detail('failed', message) }),
        done: false,
      };
    }
    this.ports.journal.record('fleet.warden_acted', {
      targetId,
      action: act.action,
      by: base.by,
      ...(base.confidence === undefined ? {} : { confidence: base.confidence }),
      ...(base.reason === undefined ? {} : { reason: base.reason }),
    });
    return { state: this.recordAction(state, { ...base, outcome: 'done', detail: words.detail('done') }), done: true };
  }

  /**
   * Mark investigations whose warden is gone as finished, and price the finished ones analytics can now
   * read. Pricing is retried each sweep for a day — analytics reads a transcript some time after it
   * ends — and every price that lands updates the running average the savings line and the cap's
   * estimate of an unpriced investigation are drawn from.
   */
  private async priceInvestigations(
    state: WardenRuntimeState,
    fleet: readonly WardenFleetSession[],
    at: string,
  ): Promise<WardenRuntimeState> {
    const records = state.investigations ?? [];
    if (records.length === 0) return state;
    // Live: running in the fleet, holding an assignment, or started by THIS sweep — the fleet was read
    // before it spawned, so a warden it just started is not in that read and must not read as finished.
    const live = new Set([
      ...this.liveWardens(fleet, state).map(warden => warden.wardenId),
      ...Object.values(state.assignments ?? {}).map(assignment => assignment.wardenId),
    ]);
    const nowMs = this.ports.nowMs();
    let average = state.costAverage ?? { count: 0, totalUsd: 0 };
    const priced: WardenInvestigationRecord[] = [];
    for (const record of records) {
      const finished = record.finishedAt ?? (live.has(record.id) || record.startedAt === at ? undefined : at);
      const finishedMs = finished === undefined ? undefined : Date.parse(finished);
      const worthAsking = record.costUsd === undefined && finishedMs !== undefined && nowMs - finishedMs < 86_400_000;
      const costUsd = worthAsking ? await this.ports.costs.costUsd(record.id).catch(() => undefined) : undefined;
      if (costUsd !== undefined && Number.isFinite(costUsd) && costUsd >= 0)
        average = { count: average.count + 1, totalUsd: average.totalUsd + costUsd };
      priced.push({
        ...record,
        ...(finished === undefined ? {} : { finishedAt: finished }),
        ...(costUsd !== undefined && Number.isFinite(costUsd) && costUsd >= 0 ? { costUsd } : {}),
      });
    }
    return { ...state, investigations: priced, ...(average.count === 0 ? {} : { costAverage: average }) };
  }

  /**
   * The shared fleet-triage escalation.
   *
   * The flags go through the layers in order: blessed ones are not part of the
   * set, Jev (when its layer is on) settles what it is sure enough about, and only
   * then is an investigation considered — and only while the LLM layer is on.
   * With it off, the flags Jev did not clear are the owner's to read.
   *
   * The spawn gates are ordered cheapest-first, and account selection comes LAST
   * on purpose: exhaustion must not consume the spawn gap or the suppression
   * fingerprint, so the very next sweep after an account recovers escalates
   * immediately. The suppression key is taken over the flags that reached the
   * investigation, so the same set is not investigated again next sweep.
   */
  private async escalate(input: {
    readonly anomalies: readonly WardenAnomaly[];
    readonly fleet: readonly WardenFleetSession[];
    readonly config: WardenConfig;
    readonly login: ResolvedWardenLogin;
    readonly state: WardenRuntimeState;
    readonly at: string;
    readonly force: boolean;
  }): Promise<{ readonly state: WardenRuntimeState; readonly outcome: EscalationOutcome }> {
    const { config, force } = input;
    let state = input.state;
    if (!force && !config.enabled) return { state, outcome: { message: 'the Warden is off (enabled=false)' } };
    const nowMs = this.ports.nowMs();
    const byId = new Map(input.fleet.map(session => [session.config.id, session]));
    const blessings = state.blessings ?? {};
    const unblessed = input.anomalies.filter(anomaly => {
      const target = byId.get(anomaly.sessionId);
      return target === undefined || !isAnomalyBlessed(blessings, anomaly, target.state.status, nowMs);
    });
    if (unblessed.length === 0) return { state, outcome: { message: 'no anomalies to escalate' } };

    const budget = this.budget(config, state, nowMs, input.login.usable);
    const investigating = force || budget.layers.llm.active;
    // Jev answers first: as the first responder it acts whatever the investigation gates say. A ferret an
    // assigned warden is investigating or waiting for is not Jev's to touch — those flags go on unasked.
    const guarded = !force && budget.layers.jev.active;
    let anomalies: readonly WardenAnomaly[] = unblessed;
    if (guarded) {
      const investigated = new Set([
        ...Object.keys(state.assignments ?? {}),
        ...(state.assignedQueue ?? []).map(anomaly => anomaly.sessionId),
      ]);
      const askable = unblessed.filter(anomaly => !investigated.has(anomaly.sessionId));
      const jev = await this.passThroughJev(askable, config, state, byId, investigating);
      state = jev.state;
      anomalies = [...unblessed.filter(anomaly => investigated.has(anomaly.sessionId)), ...jev.passed];
      if (anomalies.length === 0)
        return { state, outcome: { message: 'Jev settled every flag; nothing to investigate' } };
    } else if (!force && jevCapped(budget.layers.jev)) {
      const investigated = new Set(Object.keys(state.assignments ?? {}));
      const skipped = unblessed.filter(anomaly => !investigated.has(anomaly.sessionId));
      state = await this.noteCapSkips(state, skipped, config, investigating, nowMs);
    }
    // Only then the free gates on the investigation itself: a flag they hold back is not paid for.
    const held = investigating ? this.spawnHeldBack(config, state, input.fleet, budget, nowMs, force) : undefined;
    if (held !== undefined) return { state, outcome: { message: held } };
    if (!investigating)
      return { state, outcome: { message: investigationsOffMessage(budget.layers, anomalies.length, budget.spend) } };

    const key = spawnSuppressionKey(state, fingerprintAnomalies(anomalies));
    if (!force && key === state.lastSpawnFingerprint)
      return { state, outcome: { message: 'anomaly set unchanged since the last escalation' } };

    const reportPath = this.ports.artifacts.reportPath(input.at);
    const result = await this.spawnOnAnyAccount(
      input.login.accounts,
      config,
      state,
      {
        name: 'Fleet triage',
        prompt: buildWardenSweepPrompt({
          anomalies,
          sessions: input.fleet,
          reportPath,
          at: input.at,
          settings: this.settings,
        }),
        cwd: this.settings.wardenCwd,
        effort: config.investigation.effort,
      },
      {},
    );
    state = result.state;
    if (result.started === undefined) {
      if (result.exhausted)
        return { state, outcome: { message: 'every configured warden account is currently ineligible (exhausted)' } };
      // A FAILED launch still consumes the spawn gap, so a persistently broken
      // account cannot be retried every sweep — but NOT the suppression key, so a
      // changed anomaly set can still escalate once the gap elapses.
      return {
        state: { ...state, lastSpawnAt: input.at },
        outcome: { message: `warden spawn failed: ${failureMessage(result.error)}` },
      };
    }

    const { facts, selection } = result.started;
    const investigator = result.started.investigator;
    await this.writeProvenance(reportPath, facts, selection, undefined, investigator);
    // What Jev did first is one answer only when every flag the triage covers got the same one.
    const jevPerFlag = anomalies.map(anomaly =>
      jevBeforeInvestigation({
        kind: anomaly.kind,
        ...optionalLast(state.jevBefore?.[jevHandoffKey(anomaly.sessionId, anomaly.kind)]),
        jevOn: config.layers.jev,
        force,
      }),
    );
    const jev = jevPerFlag.every(entry => JSON.stringify(entry) === JSON.stringify(jevPerFlag[0]))
      ? jevPerFlag[0]
      : undefined;
    state = {
      ...state,
      jevBefore: anomalies.reduce(
        (store, anomaly) => forgetJevBefore(store, anomaly.sessionId, anomaly.kind),
        state.jevBefore ?? {},
      ),
      lastSpawnAt: input.at,
      lastSpawnFingerprint: key,
      sweepCoverage: {
        wardenId: facts.sessionId,
        reportPath,
        anomalies: anomalies.map(anomaly => ({ sessionId: anomaly.sessionId, kind: anomaly.kind })),
      },
      investigations: retainRecords(
        [
          {
            id: facts.sessionId,
            scope: 'fleet',
            origin: guarded ? 'jev' : 'sweep',
            startedAt: input.at,
            reportPath,
            agent: facts.agent,
            ...(facts.model === undefined ? {} : { model: facts.model }),
            ...(investigator === undefined ? {} : { wardenName: investigator }),
            ...(jev === undefined ? {} : { jev }),
          },
          ...(state.investigations ?? []),
        ],
        input.at.slice(0, 10),
        WARDEN_HISTORY_LIMIT,
      ),
    };
    this.ports.journal.record('fleet.warden_spawned', {
      sessionId: facts.sessionId,
      ...(investigator === undefined ? {} : { investigator: displaySystemCallsign(investigator) }),
      count: anomalies.length,
      reportPath,
    });
    return { state, outcome: { spawned: facts.sessionId } };
  }

  /**
   * Why the fleet warden may not start now, from the gates that cost nothing and do not depend on which
   * flags it would be sent: the concurrency cap, the spawn gap and the hourly limit. `force` passes the
   * last two, never the first — the cap protects the host, not the operator's patience.
   */
  private spawnHeldBack(
    config: WardenConfig,
    state: WardenRuntimeState,
    fleet: readonly WardenFleetSession[],
    budget: TriageBudget,
    nowMs: number,
    force: boolean,
  ): string | undefined {
    const live = this.liveWardens(fleet, state);
    if (wardenSlotsFree(config.maxAssignedWardens, live.length) <= 0)
      return `warden concurrency cap reached (${live.length}/${Math.max(1, config.maxAssignedWardens)} live)`;
    if (force) return undefined;
    const lastSpawnMs = Date.parse(state.lastSpawnAt ?? '');
    if (Number.isFinite(lastSpawnMs) && nowMs - lastSpawnMs < spawnGapMs(config))
      return `spawn gap not elapsed (last spawn ${state.lastSpawnAt})`;
    if (budget.spend.investigationsLastHour >= config.caps.maxInvestigationsPerHour)
      return `hourly investigation limit reached (${config.caps.maxInvestigationsPerHour} per hour)`;
    return undefined;
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
    sweep: {
      readonly config: WardenConfig;
      readonly login: ResolvedWardenLogin;
      /** The state this sweep wrote last. */
      readonly state: WardenRuntimeState;
      readonly at: string;
      /** Wardens this sweep started: not in the fleet it read, and running all the same. */
      readonly spawned: readonly string[];
    },
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
          reason: 'this node’s agenda could not be read, so it was neither escalated nor cleared this sweep',
        });
        continue;
      }
      boards.push(board);
      nodes.push(session);
    }

    // Why each standing flag is the owner's, from what this sweep decided (`owner-routes.ts`).
    const nowMs = this.ports.nowMs();
    const live = new Set([...this.liveWardens(fleet, sweep.state).map(warden => warden.wardenId), ...sweep.spawned]);
    const statuses = new Map(fleet.map(session => [session.config.id, session.state.status]));
    const routes = wardenOwnerRoutes({
      anomalies,
      state: sweep.state,
      layers: this.budget(sweep.config, sweep.state, nowMs, sweep.login.usable).layers,
      enabled: sweep.config.enabled,
      statusOf: sessionId => statuses.get(sessionId),
      liveWarden: wardenId => live.has(wardenId),
      nowMs,
    });
    const machine = this.settings.machineName?.();
    const plan = planWardenEscalations({
      anomalies,
      nodes,
      verdicts,
      boards,
      remedy: planWardenRemedy({ mayAct: this.settings.mayAct }),
      clientName: this.settings.clientName,
      routes,
      notified: new Set(Object.keys(sweep.state.notified ?? {})),
      ...(machine === undefined || machine === '' ? {} : { machine }),
      at: sweep.at,
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

    // Who was told: a subject is remembered from the notification that landed until it has no reason left,
    // so the owner hears about it once per episode however often they clear it (`escalation.ts`).
    const standing = new Set(plan.standing);
    const notified: Record<string, string> = Object.fromEntries(
      Object.entries(sweep.state.notified ?? {}).filter(([key]) => standing.has(key)),
    );
    let state = sweep.state;
    for (const request of plan.raise) {
      const write = await this.ports.attention.raise(request.sessionId, request);
      if (write !== 'rejected' && notified[request.subjectKey] === undefined) {
        notified[request.subjectKey] = sweep.at;
        // Counted once per episode, when the owner is first told — the day's "Asked you".
        const actor = wardenAskActor(request.reason);
        if (actor !== undefined) state = recordWardenAsk(state, sweep.at, actor);
      }
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
        reason: request.reason,
        ...(request.reportPath === undefined ? {} : { reportPath: request.reportPath }),
        change: write,
      });
    }
    if (state !== sweep.state || JSON.stringify(notified) !== JSON.stringify(sweep.state.notified ?? {}))
      await this.ports.state.write({ ...state, notified });
  }

  // ─── accounts ───────────────────────────────────────────────────────────────

  /**
   * Start one warden, handing the spawn to the next login when one fails to start — within this sweep,
   * bounded by {@link MAX_SPAWN_ATTEMPTS} and by the logins there are.
   *
   * Every failure strikes its ACCOUNT, as a single failure always did, so the order of the next sweep is
   * still decided by the failover state; trying the next login now only stops one broken login from
   * costing a whole sweep. `exhausted` means no login was eligible at the FIRST pick: nothing was tried,
   * and the caller defers rather than cooling anything down.
   */
  private async spawnOnAnyAccount(
    accounts: readonly WardenAccount[],
    config: WardenConfig,
    state: WardenRuntimeState,
    request: Omit<WardenSpawnRequest, 'agent' | 'model'>,
    context: Readonly<Record<string, unknown>>,
  ): Promise<{
    readonly state: WardenRuntimeState;
    readonly started?: {
      readonly facts: WardenSpawnFacts;
      readonly account: WardenAccount;
      readonly selection: WardenSelectionProvenance;
      /** The investigator's callsign, `warden-00002a`. */
      readonly investigator: string;
    };
    readonly exhausted: boolean;
    readonly error?: unknown;
  }> {
    const tried = new Set<string>();
    const attempts = Math.min(MAX_SPAWN_ATTEMPTS, Math.max(1, accounts.length));
    let next = state;
    let error: unknown;
    // One name per spawn, kept across the accounts it is tried on: a login that fails to start has not
    // used it, so the sequence has no gaps for a refused start.
    const issued = await this.issueInvestigator(next);
    next = issued.state;
    let investigator = issued.name;
    if (investigator === undefined) return { state: next, exhausted: false, error: NO_INVESTIGATOR_NAME };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const picked = await this.pickAccount(accounts, config, next, tried);
      next = picked.state;
      if (picked.account === undefined) return { state: next, exhausted: attempt === 0, error };
      const start = (teammate: string): Promise<{ readonly facts?: WardenSpawnFacts; readonly error?: unknown }> =>
        this.spawn({
          ...request,
          teammate,
          agent: (picked.account as WardenAccount).agent,
          ...((picked.account as WardenAccount).model === undefined
            ? {}
            : { model: (picked.account as WardenAccount).model }),
        });
      let result = await start(investigator);
      // A name another session took since the ledger was read is no fault of the account: take the next
      // free one and try once more, without a strike.
      if (result.error instanceof WardenCallsignTakenError) {
        this.ports.journal.record('fleet.warden_callsign_taken', {
          ...context,
          investigator: displaySystemCallsign(investigator),
        });
        const taken = wardenInvestigatorSequence(investigator);
        const again = await this.issueInvestigator(next, taken === undefined ? [] : [taken]);
        next = again.state;
        if (again.name !== undefined) {
          investigator = again.name;
          result = await start(investigator);
        }
      }
      if (result.facts !== undefined)
        return {
          state: { ...next, failover: recordWardenSuccess(next.failover ?? {}, picked.account.agent) },
          started: { facts: result.facts, account: picked.account, selection: picked.selection, investigator },
          exhausted: false,
        };
      error = result.error;
      next = this.recordSpawnFailure(next, config, picked.account.agent, error);
      tried.add(picked.account.agent);
      this.ports.journal.record('fleet.warden_spawn_failed', {
        ...context,
        agent: picked.account.agent,
        attempt: attempt + 1,
        message: failureMessage(error),
      });
    }
    return { state: next, exhausted: false, error };
  }

  /**
   * The next investigator name, `warden-00002a`: the sequence after the last one issued that no session
   * in the fleet holds, and not one in `refused`. Persisted at once, so a restart never reissues it.
   * Never a name from the pool: those are for real ferrets.
   */
  private async issueInvestigator(
    state: WardenRuntimeState,
    refused: readonly number[] = [],
  ): Promise<{ readonly state: WardenRuntimeState; readonly name?: string }> {
    const fleet = await this.ports.fleet.fleet().catch(() => []);
    const inUse = new Set<number>(refused);
    for (const session of fleet) {
      const sequence = wardenInvestigatorSequence(session.config.teammate);
      if (sequence !== undefined) inUse.add(sequence);
    }
    const sequence = nextWardenInvestigatorSequence(state.investigatorSequence ?? 0, inUse);
    if (sequence === undefined) return { state };
    return { state: { ...state, investigatorSequence: sequence }, name: wardenInvestigatorName(sequence) };
  }

  /**
   * The account the next warden spawn should use, or `undefined` on exhaustion.
   *
   * Demotions are reconciled against the usage feed first, so positive evidence
   * restores an account early rather than making it serve out a cooldown timer
   * whose cause has passed. Exhaustion is reported EDGE-triggered: one event per
   * episode, not one per sweep, or the journal would fill with the same fact.
   */
  private async pickAccount(
    accounts: readonly WardenAccount[],
    config: WardenConfig,
    state: WardenRuntimeState,
    tried: ReadonlySet<string> = new Set(),
  ): Promise<{
    readonly state: WardenRuntimeState;
    readonly account?: WardenAccount;
    readonly selection: WardenSelectionProvenance;
  }> {
    const policy = effectiveFailoverConfig(config.failover).policy;
    // No login at all is not an exhausted one: nothing failed, so nothing is journalled or raised.
    if (accounts.length === 0)
      return { state, selection: { policy, selection: 'preferred', configuredFirst: '', skipped: {} } };
    const usage = await this.ports.usage.accounts().catch(() => []);
    const nowMs = this.ports.nowMs();
    const reconciled = reconcileDemotions(state.failover ?? {}, usage, nowMs);
    for (const restored of reconciled.restored)
      this.ports.journal.record('fleet.warden_account_restored', { agent: restored.agent, how: restored.how });

    const installed = await this.installedAgents();
    const wasExhausted = reconciled.state.exhaustedSince !== undefined;
    const previous = reconciled.state.lastSelection?.agent;
    const configuredFirst = accounts[0]?.agent ?? '';
    const selection = selectWardenAccount({
      accounts,
      failover: config.failover,
      installedAgents: installed,
      usage,
      state: reconciled.state,
      nowMs,
      excluded: tried,
    });

    // Every login left has failed to start this spawn: that is not exhaustion, and nothing is recorded.
    if (selection.exhausted && tried.size > 0)
      return {
        state: { ...state, failover: reconciled.state },
        selection: { policy, selection: 'preferred', configuredFirst, skipped: selection.reasons },
      };
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
    investigator?: string,
  ): Promise<void> {
    try {
      await this.ports.artifacts.writeProvenance(
        reportPath,
        buildWardenSpawnProvenance(facts, selection, targetId, investigator),
      );
    } catch (error) {
      this.ports.journal.record('fleet.warden_provenance_failed', {
        wardenId: facts.sessionId,
        ...(targetId === undefined ? {} : { targetId }),
        reportPath,
        message: failureMessage(error),
      });
    }
  }

  /**
   * The stored configuration, with every login named the way the fleet names it today.
   *
   * A `warden.yaml` that holds a runtime's opaque id (an earlier picker stored one) or a name the runtime
   * had before is read as the runtime's current name, so selection, the picker and the status all see one
   * spelling. Nothing is written here: the next save persists the name. A reference nothing answers to
   * stays as written, and is reported unknown rather than guessed at.
   */
  private async storedConfig(): Promise<StoredWardenConfig> {
    const stored = parseStoredWardenConfig(await this.ports.config.read());
    if (stored.config.accounts.length === 0) return stored;
    const accounts = await Promise.all(
      stored.config.accounts.map(async account => {
        const name = await this.ports.agents.currentName(account.agent).catch(() => undefined);
        return name === undefined || name === account.agent ? account : { ...account, agent: name };
      }),
    );
    if (accounts.every((account, index) => account === stored.config.accounts[index])) return stored;
    return { ...stored, config: { ...stored.config, accounts: [...normalizeWardenAccounts(accounts)] } };
  }

  private async installedAgents(): Promise<readonly string[]> {
    return await this.ports.agents.installed().catch(() => []);
  }

  /** The investigation login in effect: the owner's order, else the machine's default runtime, else none. */
  private async resolveLogin(config: WardenConfig): Promise<ResolvedWardenLogin> {
    const installed = await this.installedAgents();
    const defaultRuntime = await this.ports.agents.defaultRuntime().catch(() => undefined);
    return resolveWardenLogin(config, installed, defaultRuntime);
  }

  private async latestReportField(): Promise<Pick<WardenStatusView, 'lastReport'>> {
    const latest = await this.ports.artifacts.latest().catch(() => undefined);
    return latest === undefined ? {} : { lastReport: latest };
  }

  /** The failover block of the status: every configured account with its live
   *  health and why it is or is not eligible right now. */
  private async failoverStatus(
    config: WardenConfig,
    accounts: readonly WardenAccount[],
    state: WardenFailoverState,
  ): Promise<WardenFailoverStatus> {
    const failover = effectiveFailoverConfig(config.failover);
    const usage = await this.ports.usage.accounts().catch(() => []);
    const installed = await this.installedAgents();
    const nowMs = this.ports.nowMs();
    const byAgent = new Map(usage.map(item => [item.agent, item]));
    return {
      policy: failover.policy,
      failureThreshold: failover.failureThreshold,
      cooldownMinutes: failover.cooldownMinutes,
      accounts: accounts.map(account => {
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

/** Whether the owner switched Jev on and its cap — the day's, or this hour's share — has switched it off. */
function jevCapped(layer: WardenLayerStatus): boolean {
  return layer.configured && layer.reason === 'jev_cap';
}

/** Remember Jev's last word on one flag (`jev-checks.ts` {@link rememberJevBefore}). */
function withJevBefore(
  state: WardenRuntimeState,
  anomaly: { readonly sessionId: string; readonly kind: string },
  before: WardenJevBefore,
): WardenRuntimeState {
  return {
    ...state,
    jevBefore: rememberJevBefore(state.jevBefore ?? {}, jevHandoffKey(anomaly.sessionId, anomaly.kind), before),
  };
}

/** Forget Jev's last word on one flag: an investigation has taken it. */
function forgetJevBefore(
  store: Readonly<Record<string, WardenJevBefore>>,
  sessionId: string,
  kind: WardenAnomaly['kind'],
): Readonly<Record<string, WardenJevBefore>> {
  const key = jevHandoffKey(sessionId, kind);
  return Object.fromEntries(Object.entries(store).filter(([existing]) => existing !== key));
}

const optionalLast = (last: WardenJevBefore | undefined): { readonly last?: WardenJevBefore } =>
  last === undefined ? {} : { last };

/** Remember why Jev handed one flag on (`state.ts` {@link recordJevHandoff}): an escalation, or one it never judges. */
function withJevHandoff(
  state: WardenRuntimeState,
  anomaly: WardenAnomaly,
  outcome: Omit<WardenJevHandoff, 'at' | 'status'>,
  nowMs: number,
): WardenRuntimeState {
  return {
    ...state,
    jevHandoffs: recordJevHandoff(state.jevHandoffs ?? {}, anomaly, {
      at: new Date(nowMs).toISOString(),
      status: anomaly.status,
      why: outcome.why,
      confidence: outcome.confidence,
      ...(outcome.recommends === undefined ? {} : { recommends: outcome.recommends }),
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
    }),
  };
}
