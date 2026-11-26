import { milliseconds } from '@ferretry/std';
import type { Clock, Log, SpawnPort, StatePort } from '@ferretry/kernel/contract';
import type { z } from 'zod';
import type { AskToStopJobsResult, ConversionPreview } from '../../contract/move.ts';
import { byRecordedHarness, UnsupportedHarnessFamilyError } from '../../contract/records.ts';
import type { JobKeeperSource } from '../../contract/job-keeping.ts';
import type { JobsMovePorts } from '../lib/moves/jobs-move.ts';
import { KernelProcessProbe, type ProcessHostFacts } from '../adapters/moves/process-inventory.ts';
import { StateMoveReportStore } from '../adapters/moves/state-move-report.ts';
import { KeyedSerialExecutor } from '../adapters/storage/keyed-serial-executor.ts';
import type { DaemonStorage } from '../adapters/storage/session-storage.ts';
import { type AgentJobControl, AgentJobStopper } from '../lib/moves/stop-jobs.ts';
import { agentJobsMessage, agentJobsMessageId } from '../lib/moves/agent-jobs.ts';
import type { ObservedSession } from '../lib/moves/outcome-render.ts';
import type { MovePreflight } from '../lib/moves/preflight-service.ts';
import type { MovePane } from '../lib/moves/process-inventory-port.ts';
import type { ProcRow } from '../lib/moves/process-table.ts';
import type { MoveReportStore } from '../lib/moves/report-store.ts';
import type { MoveTranscriptTail, ProcessSignalPort } from '../lib/moves/ports.ts';
import { SessionConfigSchema, SessionStateSchema, type SessionView } from '../lib/protocol/session.ts';
import { SessionMoveError, type SessionMoveSubsystem } from '../lib/runtime/mounts/session-move.ts';
import { sessionMoveContribution } from '../lib/runtime/mounts/session-move.ts';
import type { RelaunchDrift } from './relaunch-settings.ts';
import { type LoginMoveNeeds, moveToLogin } from './move-login.ts';
import { type RestartContext, type RestartNeeds, restartInPlace } from './restart-in-place.ts';
import type { SessionDirectorySubsystem } from '../lib/session/directory/subsystem.ts';
import { type SessionId, tryParseSessionId } from '../lib/session-id.ts';

/**
 * Moving a live ferret onto another login of its harness (or restarting it where it is): `POST /v1/ferrets/:ferretId/move`,
 * its safety gate, the conversion preview, the relaunch settings and the "ask the agent to stop its background jobs" route,
 * over the service that drives them ({@link createSessionMoveSubsystem}).
 *
 * This module has no `Seams`, no jobs, no releases of its own and no protocol features: every constructor in the build
 * is pure, so the single build sits where the move was always assembled. Its adapters (the report store, the process
 * probe the job stopper follows a pid with, the serial executor) are fixed, built here over the kernel ports it is handed;
 * every owner the move borrows is a need.
 *
 * Ferret lifecycle, launch and resume are Ferrets' own, and the runtime a move lands on is Runtimes' to resolve and
 * describe, so they reach this module only as typed {@link SessionMoveNeeds}. A move reads each of them at the moment it
 * decides, never earlier.
 *
 * What it provides is the service itself: the restart service and the Warden call it directly, and its four routes are
 * the module's contribution.
 */

/**
 * What the ferret-move module is built from. Every field is either a kernel port, a Ferrets owner, or a port named for a
 * piece of ANOTHER plugin that Ferrets (core) cannot import (`lib/moves/ports.ts`); the host binds each, and an unbound one
 * is a fail-closed skeleton that refuses the move before it writes anything.
 */
export interface SessionMoveNeeds {
  // ─── kernel ports ───
  /** The move report is a declared state file (`MoveInflightFiles`) beneath it. */
  readonly state: StatePort;
  /** Runs `ps`, which a pid is followed through when procfs does not list it. */
  readonly spawn: SpawnPort;
  /** The machine's `/proc` facts, plus where a process is working. */
  readonly host: ProcessHostFacts;
  readonly clock: Clock;
  /** Where a refusal that could not be journalled is said. */
  readonly log: Pick<Log, 'warn'>;
  // ─── Ferrets' own ───
  readonly storage: DaemonStorage;
  readonly sessions: SessionDirectorySubsystem;
  /** The relaunch-settings read (W2-c): asked whether a relaunch would run the ferret on other harness settings. */
  readonly launch: RelaunchDrift;
  readonly preflight: MovePreflight;
  /** The ferret's pane, reached through its runner by the registry's handle: what the gate reads (never a tmux session name). */
  readonly pane: (id: SessionId) => MovePane;
  /** What a Restart, and a move onto another login, need of the Ferrets service (`restart-in-place.ts`). */
  readonly restart: RestartNeeds;
  /** What a move onto another login borrows of Runtimes and the harness (`move-login.ts`). */
  readonly login: LoginMoveNeeds;
  /** Puts one Ferretry-authored message in the session's queue (a closure over the queue and its deliverer). */
  readonly askAgent: SessionMoveParts['askAgent'];
  /**
   * The job keeper (Terminals contributes it through the `jobs.keeper` hook), read at the moment of a move. Absent or
   * answering nothing, no attachment is ever known and nothing is detached: the gate classifies as it always did.
   */
  readonly jobs?: SessionMoveParts['jobs'];
  // ─── other plugins' pieces (unbound until their owner lands) ───
  /** Conversation: the session's own transcript tail. */
  readonly transcripts: MoveTranscriptTail;
  /** Terminals: the registered pane's identity. */
  readonly paneIdentity: SessionMoveParts['paneIdentity'];
  /** The host: signals one pid, and names the pids never signalled. */
  readonly signals: ProcessSignalPort;
}

/** What other code uses of the session-move module. */
export type SessionMoveProvides = SessionMoveSubsystem & AgentJobControl;

/** The collaborators a move needs. Grouped because positional arguments in the order the flow happens to use them is a call site nobody can check. */
interface SessionMoveParts {
  readonly storage: DaemonStorage;
  /** Where a refusal that could not be journalled is said. */
  readonly log: Pick<Log, 'warn'>;
  /** Pids read wherever they are on the host, for following a stopped job out of its pane (`move/stop-jobs.ts`). */
  readonly processes: { lookup(pids: readonly number[]): Promise<ReadonlyMap<number, ProcRow>> };
  readonly sessions: SessionDirectorySubsystem;
  readonly preflight: MovePreflight;
  readonly pane: (id: SessionId) => MovePane;
  readonly restart: RestartNeeds;
  readonly login: LoginMoveNeeds;
  /**
   * Puts one Ferretry-authored message in the session's queue — the only thing a refused move's
   * "ask the agent to stop its background jobs" does. `created` is false when `messageId` was queued before.
   */
  readonly askAgent: (id: SessionId, message: { readonly id: string; readonly text: string }) => Promise<boolean>;
  readonly reports: MoveReportStore;
  readonly clock: Clock;
  /** The job keeper, when one is contributed: told to detach attachments before the pane dies, asked what to hand over. */
  readonly jobs?: () => JobKeeperSource | undefined;
  /**
   * The session's own transcript, which is what the preflight joins its open tool ids against.
   *
   * Until a session recorded its transcript this was an EMPTY array and every open tool was
   * classified `unknown`, which the gate refuses on — the daemon knew a tool was running and not
   * what it was. With provenance persisted the join has real evidence, and a session that still has
   * no locatable transcript degrades to exactly the previous behaviour rather than to a guess.
   */
  readonly transcripts: MoveTranscriptTail;
  /** The registered pane's identity (pane id, pid, process start), or nothing when none can be read. */
  readonly paneIdentity: (id: SessionId) => Promise<string | undefined>;
  readonly signals: ProcessSignalPort;
  /** Serializes whole moves of one session, so two cannot restamp the same document. */
  readonly serial: KeyedSerialExecutor;
  /** The relaunch-settings read (W2-c): asked whether a relaunch would run the ferret on other harness settings. */
  readonly launch: RelaunchDrift;
}

/** The documents a move reasons about, parsed by the schemas that govern them. */
interface MoveSubject {
  readonly config: z.infer<typeof SessionConfigSchema>;
  readonly state: z.infer<typeof SessionStateSchema>;
}

/** What a conversion preview answers while no conversion is built: a refusal in a sentence, which is what the sheet shows. */
const CONVERSION_NOT_BUILT = 'converting a conversation onto another harness is not built yet. Nothing was changed.';

/**
 * Moving one ferret onto another login, or restarting it where it is, over the preflight that was built for exactly this.
 *
 * WHAT A MOVE IS MADE OF, and why each part is where it is:
 *
 *   * THE GATE RUNS FIRST AND WRITES NOTHING. `MovePreflight` inventories the pane's process
 *     tree, the codex footer and the session's own open tools, and refuses work it cannot show will
 *     survive the kill. Nothing above it is allowed to mutate the session, so a refused move
 *     leaves a session exactly as it found it.
 *   * THE REPORT IS WRITTEN BEFORE THE PANE DIES, because it is the only account of what the kill
 *     destroyed and the pane is the evidence. It is also what the replacement agent is handed: the
 *     handoff message names the file.
 *   * THE DOCUMENT IS RESTAMPED, NOT REPLACED. `updateConfig` merges over what is on disk, so the
 *     session keeps its id, directory, journal, callsign and history and changes only the runtime,
 *     the model, and the incarnation counting the relaunches.
 *   * THE RELAUNCH IS A RESUME of the Ferrets service with the live pane replaced. Everything a safe replacement needs
 *     — snapshot before kill, the launch gate, the per-ferret queue — is the service's, already built and tested.
 *
 * ONLY `revived` IS A MOVE. The other dispositions are relaunch failures that do NOT throw, and both settle the report as
 * a FAILURE: treating the absence of an exception as success is precisely how a move reports a move that did not happen.
 *
 * THE CONFIGURATION IS NOT ROLLED BACK when the relaunch fails after the pane was replaced, and the report says so in those
 * words: a rollback is a second write that can fail on its own, and it would race whatever the resume did next. It is put
 * back only while the registered pane is provably the one that served before (`restart-in-place.ts`).
 */
function createSessionMoveSubsystem(parts: SessionMoveParts): SessionMoveSubsystem & AgentJobControl {
  /** The preflight's look at a session, shared by the move and by the ask that clears its way. */
  const inspect = async (id: SessionId, { config, state }: MoveSubject, requesterPid?: number) => {
    // A harness with no family is refused by name BEFORE anything is read or touched, as a preflight refusal: the route
    // answers it as a stated 409 and the replay slot stays free, never a 500 that a destroyed pane would have earned.
    const harness = transcriptHarnessOf(id, config.harness);
    return await parts.preflight.inspect(
      {
        sessionId: id,
        harness: config.harness,
        pane: parts.pane(id),
        status: state.status,
        ...(state.turnState === undefined ? {} : { turnState: state.turnState }),
        ...(state.permissionRequest === undefined ? {} : { awaitingPermission: true }),
        turn: state.turn,
        // The state document's own record of the tool calls this session has open: ABSENT is unknown, never "none".
        openTools: state.openTools,
        ...(state.subprocessSince === undefined ? {} : { subprocessSince: state.subprocessSince }),
      },
      // The session's OWN transcript, resolved from the provenance its start recorded. A session
      // with none reads as an empty tail, which classifies every open tool `unknown` and refuses
      // the move — the same fail-closed answer this call gave before, now reached only when
      // the evidence is genuinely absent rather than always.
      await parts.transcripts.tail({
        sessionId: id,
        harness,
      }),
      requesterPid === undefined ? {} : { requesterPid },
    );
  };

  /** Both documents, or a stated refusal. A session whose pair does not parse
   *  is one nothing may restamp: the write would merge new fields over a document already broken. */
  const subject = async (id: SessionId): Promise<MoveSubject> => {
    const raw = await parts.storage.readConfig(id);
    const config = SessionConfigSchema.safeParse(raw);
    const state = SessionStateSchema.safeParse(await parts.storage.readState(id));
    if (!config.success || !state.success)
      throw new SessionMoveError('unusable', `the documents for session ${id} do not satisfy the protocol`);
    // The pane is the ferret's own, reached through its runner by the registry's handle: the session document no longer
    // carries a terminal address (a 5.0 ferret has none), so nothing here parses one.
    return { config: config.data, state: state.data };
  };

  /** The view of a session this mount just moved. A document it cannot read back is a wiring fault. */
  const view = async (id: SessionId, when: string): Promise<SessionView> => {
    const found = await parts.sessions.get(id).catch(() => undefined);
    if (found === undefined) throw new SessionMoveError('failed', `session ${id} ${when} but cannot be read back`);
    return found;
  };

  /** What the session looks like after a failed attempt, for the outcome section. An unreadable one
   *  is reported as absent rather than guessed at — the renderer says UNKNOWN, which is the truth. */
  const observed = async (id: SessionId): Promise<ObservedSession | undefined> => {
    const found = await parts.sessions.get(id).catch(() => undefined);
    if (found === undefined) return undefined;
    return {
      binary: found.config.agent,
      ...(found.config.model === undefined ? {} : { model: found.config.model }),
      status: found.state.status,
    };
  };

  // The jobs half of every pane-killing relaunch (Restart and a move onto another login both run `relaunchInPlace`).
  const jobsPorts: JobsMovePorts = {
    keeper: () => parts.jobs?.(),
    sleep: async ms => await parts.clock.sleep(milliseconds(ms)),
    nowMs: () => Date.parse(parts.clock.now()),
    log: parts.log,
  };

  /** What a relaunch in place is run from, for a move onto `to` (a Restart's `to` is the runtime it is on). */
  const relaunching = (
    id: SessionId,
    subjectOf: MoveSubject,
    request: Parameters<SessionMoveSubsystem['move']>[1],
    to: string,
  ): RestartContext => ({
    storage: parts.storage,
    clock: parts.clock,
    reports: parts.reports,
    preflight: parts.preflight,
    restart: parts.restart,
    jobs: jobsPorts,
    paneIdentity: parts.paneIdentity,
    inspect: async () => await inspect(id, subjectOf, trustedRequesterPid(parts.log, id, request)),
    refused: async (report, decision) =>
      await recordMoveRefusal(parts.storage, parts.log, id, {
        to,
        verdict: report.worstVerdict,
        cause: decision.reason,
        described: parts.preflight.describe(report),
        by: request.movedBy ?? 'owner',
      }),
    view: async when => await view(id, when),
    observed: async () => await observed(id),
  });

  const move = async (id: SessionId, request: Parameters<SessionMoveSubsystem['move']>[1]): Promise<SessionView> => {
    const documents = await subject(id);
    // THE SUBJECT IS THE REGISTRY RECORD, not a lifecycle half of the session document. A ferret on the runtime the request
    // names is RESTARTED in place; one asked onto another runtime is MOVED onto that login (`move-login.ts`). Both are one
    // relaunch with the live pane replaced; neither plans anything the other does not.
    const own = parts.restart.record(id);
    if (own === undefined) throw new SessionMoveError('not_found', `no ferret ${id}`);
    if (own.runtime !== undefined && request.agent === own.runtime)
      return await restartInPlace(relaunching(id, documents, request, own.runtime), id, request, documents.config);
    return await moveToLogin(relaunching(id, documents, request, request.agent), parts.login, id, request, documents);
  };

  /**
   * What converting onto another harness would carry. No conversion is built (it needs the harnesses' own exporters), so the
   * preview says so as a refusal, which is an answer here and not an error: it is what the sheet shows in place of the
   * confirm button.
   */
  const conversionPreview = async (
    _id: SessionId,
    request: { readonly agent: string; readonly model?: string },
  ): Promise<ConversionPreview> => ({ kind: 'refused', targetAgent: request.agent, reason: CONVERSION_NOT_BUILT });

  /** The id a caller named, parsed, of a session that exists — or the refusal saying which it is not. */
  const existing = (reference: string): SessionId => {
    const id = tryParseSessionId(reference);
    if (id === undefined)
      throw new SessionMoveError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
    if (parts.storage.findSession(id) === undefined) throw new SessionMoveError('not_found', `no session ${reference}`);
    return id;
  };

  /**
   * LOOKS AGAIN rather than trusting the refusal the person saw: jobs finish, and the agent must be told
   * about the ones running now. It asks about the agent's own blocking jobs only, and queues nothing at all
   * when there are none — a message about work that already ended would only confuse the agent.
   */
  const askToStopJobs = async (id: SessionId): Promise<AskToStopJobsResult> => {
    const report = await inspect(id, await subject(id));
    const jobs = parts.preflight.agentJobs(report);
    if (jobs.length === 0)
      throw new SessionMoveError(
        'no_jobs',
        'none of the agent’s own background jobs is in the way any more — run the safety check again',
      );
    const messageId = agentJobsMessageId(jobs);
    const created = await parts.askAgent(id, { id: messageId, text: agentJobsMessage(jobs) });
    return { messageId, jobs: [...jobs], alreadyAsked: !created };
  };

  return {
    // The Warden's own reach into a move's way (`warden/auto-move-service.ts`); no route serves either.
    blockingJobs: async reference => {
      const id = existing(reference);
      return parts.preflight.agentJobs(await inspect(id, await subject(id)));
    },
    // Serialized with moves of the same session, so a move never reads the tree while it is being cleared.
    stopAgentJobs: async reference => {
      const id = existing(reference);
      const target = await subject(id);
      return await parts.serial.run(
        id,
        async () =>
          await new AgentJobStopper({
            inspect: async () => await inspect(id, target),
            lookup: async pids => await parts.processes.lookup(pids),
            signal: (pid, signal) => parts.signals.signal(pid, signal),
            // Never these, whatever a pane's tree claims: init, this daemon, and what started it.
            protectedPids: parts.signals.protectedPids(),
            sleep: async ms => await parts.clock.sleep(milliseconds(ms)),
            nowMs: () => parts.clock.nowMs(),
          }).stop(),
      );
    },
    askToStopJobs: async reference => await askToStopJobs(existing(reference)),
    conversionPreview: async (reference, request) => await conversionPreview(existing(reference), request),
    move: async (reference, request) => {
      const id = tryParseSessionId(reference);
      if (id === undefined)
        throw new SessionMoveError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
      if (parts.storage.findSession(id) === undefined)
        throw new SessionMoveError('not_found', `no session ${reference}`);
      // WHOLE moves serialize, not just their writes: the gate reads a pane, the restamp writes
      // the document that pane's replacement is launched from, and a second move interleaving
      // between the two would relaunch the first one's target under the second one's account.
      return await parts.serial.run(id, async () => await move(id, request));
    },
    relaunchSettings: async reference => {
      const id = tryParseSessionId(reference);
      if (id === undefined)
        throw new SessionMoveError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
      if (parts.storage.findSession(id) === undefined)
        throw new SessionMoveError('not_found', `no session ${reference}`);
      return await parts.launch.drift(id);
    },
  };
}

export const sessionMoveModule: SessionMoveModule = {
  id: 'sessionMove',
  build: (needs, _seams, _lifecycle) => {
    const { state, spawn, host, clock } = needs;
    // Hoisted so the handover and restart subsystems share this exact mover.
    const sessionMove = createSessionMoveSubsystem({
      storage: needs.storage,
      log: needs.log,
      processes: new KernelProcessProbe(spawn, host, clock),
      sessions: needs.sessions,
      preflight: needs.preflight,
      pane: needs.pane,
      restart: needs.restart,
      login: needs.login,
      askAgent: needs.askAgent,
      ...(needs.jobs === undefined ? {} : { jobs: needs.jobs }),
      reports: new StateMoveReportStore(state),
      clock,
      transcripts: needs.transcripts,
      paneIdentity: needs.paneIdentity,
      signals: needs.signals,
      // Its own queue: a move holds its lock across a pane kill and a relaunch, and must not
      // make every unrelated document write in the process wait behind it.
      serial: new KeyedSerialExecutor(),
      launch: needs.launch,
    });
    return {
      id: 'sessionMove',
      provides: sessionMove,
      jobs: {},
      contributes: sessionMoveContribution(sessionMove),
    };
  },
};

/** The module's build contract, as `daemon/moves.ts` composes it: built once with its needs, providing the mover and contributing its routes. */
export interface SessionMoveModule {
  readonly id: 'sessionMove';
  build(
    needs: SessionMoveNeeds,
    seams: undefined,
    lifecycle: unknown,
  ): {
    readonly id: 'sessionMove';
    readonly provides: SessionMoveProvides;
    readonly jobs: Record<string, never>;
    readonly contributes: ReturnType<typeof sessionMoveContribution>;
  };
}

/**
/** The inventory items that blocked a move, as the journal records them: a title and, where there is one, its detail. */
function blockersOf(described: {
  readonly items: ReadonlyArray<{ readonly blocks: boolean; readonly title: string; readonly detail?: string }>;
}): Array<{ title: string; detail?: string }> {
  return described.items
    .filter(item => item.blocks)
    .map(item => ({ title: item.title, ...(item.detail === undefined ? {} : { detail: item.detail }) }));
}

/**
 * The transcript family a session's harness is read as, or a stated preflight refusal naming the harness.
 *
 * A harness with no family (a third harness stamped in a session document) is never read as Claude's transcript. The
 * refusal is a `harness_mismatch` `SessionMoveError` — a 409 decided before anything is touched — so the replay guard
 * frees the slot and a fresh request id is evaluated, instead of the unplaceable error a destroyed pane would be.
 */
type TranscriptHarness = Parameters<MoveTranscriptTail['tail']>[0]['harness'];

function transcriptHarnessOf(id: SessionId, harness: string): TranscriptHarness {
  try {
    return byRecordedHarness(harness, { claude: () => 'claude' as const, codex: () => 'codex' as const });
  } catch (error) {
    if (error instanceof UnsupportedHarnessFamilyError)
      throw new SessionMoveError(
        'harness_mismatch',
        `session ${id} runs the ${harness} harness, which a move cannot read yet; nothing was changed. ${error.message}`,
      );
    throw error;
  }
}

/**
 * The `fy` pid the gate may leave out as the requesting call — only from the session ITSELF moving itself (`movedBy` is
 * the admitted session credential's own `session:<id>`, never a field of the body). Any other caller (the owner, another
 * ferret, a script) names a pid for no call of this session's, so it is ignored, and said so: a pid from elsewhere would
 * otherwise exempt a running job from the gate without a trace.
 */
export function trustedRequesterPid(
  log: Pick<Log, 'warn'>,
  id: SessionId,
  request: { readonly requesterPid?: number; readonly movedBy?: string },
): number | undefined {
  if (request.requesterPid === undefined) return undefined;
  if (request.movedBy === `session:${id}`) return request.requesterPid;
  log.warn('a move named a requesting pid but is not a self-move; the pid is ignored and the gate sees every process', {
    session: id,
    by: request.movedBy ?? 'owner',
    requesterPid: request.requesterPid,
  });
  return undefined;
}

/**
 * Journals one refused move as `session.move_refused`, shaped like `session.move_forced` (what it stopped on rather
 * than what it went past). It is the ONLY write a refusal makes — the session's documents are never touched — and it
 * is the one record of the 409, so refusals can be counted and their causes compared.
 */
export async function recordMoveRefusal(
  storage: Pick<DaemonStorage, 'append'>,
  log: Pick<Log, 'warn'>,
  id: SessionId,
  refusal: {
    readonly to: string;
    readonly verdict: string;
    readonly cause: string;
    readonly described: Parameters<typeof blockersOf>[0];
    readonly by: string;
  },
): Promise<void> {
  try {
    await storage.append(id, 'session.move_refused', {
      to: refusal.to,
      verdict: refusal.verdict,
      cause: refusal.cause,
      blockers: blockersOf(refusal.described),
      by: refusal.by,
    });
  } catch (error) {
    // A failed append never changes the outcome: the caller still throws the typed refusal, which the replay guard
    // treats as re-presentable, so the same request is re-evaluated once the journal recovers.
    log.warn('a refused move could not be journalled; it is still refused', {
      session: id,
      event: 'session.move_refused',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
