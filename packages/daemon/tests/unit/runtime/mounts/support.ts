import { createHash } from 'node:crypto';
import {
  PIN_SCHEMA_VERSION,
  SessionConfigSchema,
  SessionStateSchema,
  TERMINAL_MAX_GLOBAL,
  TERMINAL_MAX_PER_SESSION,
  type CreateTerminalRequest,
  type LearningConfig,
  type Pin,
  type PinSnapshot,
  type SendResult,
  type SessionView,
  type SignalSessionRequest,
  type StartSessionRequest,
  type TaskActionRequest,
  type TaskCreateRequestInput,
  type TerminalListView,
  type TerminalView,
} from '@ferretry/protocol';
import type { AnalyticsPricingRate } from '../../../../src/lib/analytics/pricing.ts';
import {
  BrowserControlError,
  type BrowserLoginLifecycle,
  type BrowserLoginStatus,
} from '../../../../src/lib/browser/control/index.ts';
import type { FinishedAnalyticsSession } from '../../../../src/lib/analytics/session-record.ts';
import {
  AttentionService,
  type AttentionLedger,
  type AttentionLedgerRepository,
  type AttentionMutation,
} from '../../../../src/lib/attention/index.ts';
import type {
  LearningState,
  LearningStorePort,
  Observation,
  Proposal,
  RunManifest,
  Tombstone,
} from '../../../../src/lib/learning/index.ts';
import { CALLSIGN_WINDOW_MS, type NameClaim } from '../../../../src/lib/names/index.ts';
import type { AnalyticsSubsystem } from '../../../../src/lib/runtime/mounts/analytics.ts';
import type { LearningSubsystem } from '../../../../src/lib/runtime/mounts/learning.ts';
import type { NameSubsystem } from '../../../../src/lib/runtime/mounts/names.ts';
import { PinService, type PinRepository, type PinSessionDirectory } from '../../../../src/lib/pins/index.ts';
import type { TaskBoardSubsystem } from '../../../../src/lib/runtime/mounts/task-boards.ts';
import { TaskBoardError } from '../../../../src/lib/task-boards/error.ts';
import {
  EMPTY_TASK_BOARD_REPOSITORY_STATE,
  type TaskBoardCredentialIssuer,
  type TaskBoardRepository,
  type TaskBoardRepositoryState,
  type TaskBoardSession,
  type TaskBoardSessionDirectory,
} from '../../../../src/lib/task-boards/types.ts';
import { RecommendError, type RecommendSubsystem } from '../../../../src/lib/runtime/mounts/recommend.ts';
import { SessionReadError, type SessionDirectorySubsystem } from '../../../../src/lib/runtime/mounts/sessions.ts';
import {
  SessionControlError,
  type SessionControlSubsystem,
} from '../../../../src/lib/runtime/mounts/session-control.ts';
import {
  SessionMigrateError,
  type SessionMigrateSubsystem,
} from '../../../../src/lib/runtime/mounts/session-migrate.ts';
import { SessionResumeError, type SessionResumeSubsystem } from '../../../../src/lib/runtime/mounts/session-resume.ts';
import {
  SessionSendError,
  type SendInput,
  type SessionSendSubsystem,
} from '../../../../src/lib/runtime/mounts/session-send.ts';
import { SessionSignalError, type SessionSignalSubsystem } from '../../../../src/lib/runtime/mounts/session-signal.ts';
import type { SttSubsystem } from '../../../../src/lib/runtime/mounts/stt.ts';
import type { ResumeActor } from '../../../../src/lib/session/resume/index.ts';
import {
  TeamAdvisor,
  type AccountInventoryPort,
  type CoreAccount,
  type RoutingCatalogPort,
} from '../../../../src/lib/core/index.ts';
import { catalog, inventory } from '../../core/fixtures.ts';
import type { AssigneeObservation, TaskBoardPort, TaskSubsystem } from '../../../../src/lib/runtime/mounts/tasks.ts';
import {
  applyTaskAction,
  createTask,
  emptyTaskSnapshot,
  requireTaskEntry,
  TaskError,
  TaskStateUnavailableError,
  type TaskActor,
  type TaskEntry,
  type TaskParseIssue,
  type TaskSnapshot,
} from '../../../../src/lib/tasks/index.ts';
import type { SocketDownstream, SocketHandler } from '../../../../src/lib/api/socket.ts';
import { TerminalMountError, type TerminalSubsystem } from '../../../../src/lib/runtime/mounts/terminals.ts';
import {
  DEFAULT_TERMINAL_SIZE,
  nextTerminalTitle,
  normalizeTerminalSize,
  normalizeTerminalTitle,
} from '../../../../src/lib/terminal/policy.ts';
import type { UsageFeedPort } from '../../../../src/lib/usage/index.ts';
import type { DaemonHealthSubsystem, ScratchReclamation } from '../../../../src/lib/runtime/mounts/health.ts';
import {
  defaultSessionHealthSettings,
  SelfRestartCoordinator,
  SessionHealthService,
  type IncoherencePass,
  type SelfRestartStamp,
  type SessionHealthEvent,
  type SessionHealthObservation,
} from '../../../../src/lib/session/health/index.ts';

/** Shared fakes for the mounted-surface tests: real domain services over storage the test owns. */

export const AT = '2024-05-01T10:00:00.000Z';
export const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'] as const;
export const CREDENTIALS = { admin: 'admin-secret', warden: 'warden-secret' } as const;

/** The human's CLI. */
export const human = { authorization: `Bearer ${CREDENTIALS.admin}`, 'x-ferretry-client': 'cli' } as const;
/** An agent calling from inside its own pane. */
export const agentIn = (sessionId: string) => ({ ...human, 'x-ferretry-session-id': sessionId });

/** A pin repository under the test's control: the domain rules are real, the storage is not. */
class FakePinRepository implements PinRepository {
  constructor(private pins: readonly Pin[] = []) {}

  async snapshot(sessionId: string): Promise<PinSnapshot> {
    return this.document(sessionId, this.pins);
  }

  async mutate(sessionId: string, transform: (current: readonly Pin[]) => readonly Pin[]): Promise<PinSnapshot> {
    this.pins = transform(this.pins);
    return this.document(sessionId, this.pins);
  }

  private document(sessionId: string, pins: readonly Pin[]): PinSnapshot {
    return { v: PIN_SCHEMA_VERSION, sessionId, pins: [...pins], updatedAt: AT };
  }
}

class FakePinSessions implements PinSessionDirectory {
  constructor(private readonly known: readonly string[]) {}

  async has(sessionId: string): Promise<boolean> {
    return this.known.includes(sessionId);
  }
}

/** A pin service whose ids and instant are fixed, so a response body can be asserted exactly. */
export function pinService(known: readonly string[], instant: string = AT): PinService {
  let minted = -1;
  return new PinService(
    new FakePinSessions(known),
    new FakePinRepository(),
    { now: () => instant },
    {
      next: () => {
        minted += 1;
        return IDS[minted] ?? `unexpected-${minted}`;
      },
    },
  );
}

/** An in-memory attention ledger: the state machine is real, the JSONL file is not. */
class FakeLedgerRepository implements AttentionLedgerRepository {
  constructor(private ledger: AttentionLedger | null = null) {}

  async read(): Promise<AttentionLedger | null> {
    return this.ledger;
  }

  async transact(
    _sessionId: string,
    apply: (current: AttentionLedger | null) => AttentionMutation,
  ): Promise<AttentionMutation> {
    const mutation = apply(this.ledger);
    if (mutation.ok) this.ledger = mutation.ledger;
    return mutation;
  }
}

/** An attention service over an in-memory ledger, with a fixed instant. */
export function attentionService(repository: AttentionLedgerRepository = new FakeLedgerRepository()): AttentionService {
  return new AttentionService(repository, { now: () => AT });
}

/**
 * What the unreadable board refuses with — shaped like the real thing, an absolute path under the
 * operator's state home. Exported so a route test can prove this never reaches the wire.
 */
export const BOARD_UNREADABLE_DETAIL = 'refusing to use a damaged task snapshot at /home/operator/.fy/s1/tasks.json';

/**
 * An in-memory task board.
 *
 * The reducer, the ordering and the authorization rules are the REAL ones — only the JSON file is
 * replaced — so a route test that passes here is exercising the same domain the daemon runs. The
 * board mirrors `TaskRecordService`: the session is fixed at construction, and every mutation sees
 * the whole snapshot.
 */
export class FakeTaskBoard implements TaskBoardPort {
  constructor(
    private readonly sessionId: string,
    private snapshot: TaskSnapshot = emptyTaskSnapshot(),
    private readonly parseErrors: readonly TaskParseIssue[] = [],
    /**
     * Set to make every read fail, standing in for a snapshot the decoder refused. It raises the
     * SAME error the file store raises over a damaged snapshot — a persistence refusal, not a
     * protocol one — so a route test cannot pass here on a classification the daemon never produces.
     */
    private readonly unreadable = false,
  ) {}

  async list(): Promise<{ readonly entries: readonly TaskEntry[]; readonly parseErrors: readonly TaskParseIssue[] }> {
    if (this.unreadable) throw new TaskStateUnavailableError(BOARD_UNREADABLE_DETAIL);
    return { entries: this.snapshot.tasks, parseErrors: this.parseErrors };
  }

  async detail(id: string): Promise<TaskEntry> {
    return requireTaskEntry(this.snapshot, id);
  }

  async create(request: TaskCreateRequestInput, actor: TaskActor): Promise<TaskEntry> {
    return this.mutate(actor, snapshot => createTask(snapshot, request, { actor, sessionId: this.sessionId, at: AT }));
  }

  async act(id: string, action: TaskActionRequest, actor: TaskActor): Promise<TaskEntry> {
    return this.mutate(actor, snapshot =>
      applyTaskAction(snapshot, id, action, { actor, sessionId: this.sessionId, at: AT }),
    );
  }

  private mutate(
    actor: TaskActor,
    reduce: (snapshot: TaskSnapshot) => { snapshot: TaskSnapshot; entry: TaskEntry },
  ): TaskEntry {
    if (actor.kind === 'agent' && actor.sessionId !== this.sessionId)
      throw new TaskError('forbidden', `agent ${actor.id} may only write tasks in its own session`);
    const outcome = reduce(this.snapshot);
    this.snapshot = outcome.snapshot;
    return outcome.entry;
  }
}

/** How a fixture describes the fleet its task subsystem serves. */
export interface TaskWorld {
  /** The boards that exist, by session id. A session absent from here has an empty board. */
  readonly boards?: Readonly<Record<string, FakeTaskBoard>>;
  readonly sessionIds?: readonly string[];
  readonly observations?: Readonly<Record<string, AssigneeObservation>>;
  /** Every batch of assignees the mount asked about, appended in order. Supply an array to observe
   *  the mount's resolution behaviour; leave it out and the calls go unrecorded. */
  readonly observed?: string[][];
  /** Session ids the layout refuses, so the mount's bad-request path can be driven. */
  readonly unusable?: readonly string[];
}

/** A task subsystem over in-memory boards, with a fixed instant so a body can be asserted exactly. */
export function taskSubsystem(world: TaskWorld = {}): TaskSubsystem {
  const boards = new Map(Object.entries(world.boards ?? {}));
  return {
    board: sessionId => {
      if ((world.unusable ?? []).includes(sessionId))
        throw new TaskError('invalid', `${JSON.stringify(sessionId)} is not a usable session id`);
      const existing = boards.get(sessionId);
      if (existing !== undefined) return existing;
      const fresh = new FakeTaskBoard(sessionId);
      boards.set(sessionId, fresh);
      return fresh;
    },
    sessionIds: async () => world.sessionIds ?? [],
    /** Records every batch it was asked for, so a test can assert the mount asks ONCE per response
     *  for the distinct assignees rather than once per row. */
    observe: async assignees => {
      const known = world.observations ?? {};
      (world.observed ?? []).push([...assignees]);
      return new Map(
        assignees
          .map(assignee => [assignee, known[assignee]] as const)
          .filter((pair): pair is readonly [string, AssigneeObservation] => pair[1] !== undefined),
      );
    },
    now: () => AT,
  };
}

/**
 * One finished session, with only the fields a case cares about spelled out.
 *
 * Every default is a REAL value rather than a placeholder — a created instant a query can group by,
 * a finish instant a duration can be measured against — so a record built here is one the production
 * derivation would accept unchanged.
 */
export function finishedSession(
  overrides: Partial<FinishedAnalyticsSession> & { readonly id: string },
): FinishedAnalyticsSession {
  return {
    agent: 'claude-auto',
    selectedModel: 'claude-opus-5',
    contextWindow: 200_000,
    harness: 'claude',
    mode: 'auto',
    status: 'completed',
    label: null,
    cwd: '/work/ferretry',
    parent: null,
    createdAt: '2026-07-30T09:00:00.000Z',
    startedAt: '2026-07-30T09:00:00.000Z',
    finishedAt: '2026-07-30T09:30:00.000Z',
    firstOutputAt: null,
    turns: 4,
    contextEndPercent: 12,
    stalled: false,
    failed: false,
    migrated: false,
    completed: true,
    usage: null,
    ...overrides,
  };
}

/** An analytics subsystem over a fixed finished-session set and rate catalog. The derivation, the
 *  query parser and the aggregator are all the REAL ones — only the session source is the test's. */
export function analyticsSubsystem(
  sessions: readonly FinishedAnalyticsSession[] = [],
  pricing: readonly AnalyticsPricingRate[] = [],
): AnalyticsSubsystem {
  return { finished: async () => sessions, pricing: () => pricing };
}

/**
 * An in-memory terminal lifecycle.
 *
 * The sizing, titling and idle policies it applies are the REAL ones from `src/lib/terminal`, so a
 * route test that passes here exercises the same decisions the daemon makes; only the tmux pane is
 * replaced. Refusals are raised in the mount's own taxonomy, exactly as the composition root
 * translates the service's.
 */
export class FakeTerminals implements TerminalSubsystem {
  private readonly records = new Map<string, TerminalView>();
  private minted = 0;

  constructor(
    /** Session ids that exist. Anything else is `not_found`, as an unresolvable session is. */
    private readonly known: readonly string[] = ['s1'],
    private readonly perSession = TERMINAL_MAX_PER_SESSION,
  ) {}

  async list(sessionId: string): Promise<TerminalListView> {
    const terminals = this.owned(this.session(sessionId));
    return {
      sessionId,
      terminals,
      limits: {
        perSession: this.perSession,
        global: TERMINAL_MAX_GLOBAL,
        runningGlobal: this.records.size,
        idleTimeoutSeconds: 3_600,
        scrollbackLines: 5_000,
      },
    };
  }

  async create(sessionId: string, input: CreateTerminalRequest): Promise<TerminalView> {
    const session = this.session(sessionId);
    const owned = this.owned(session);
    if (owned.length >= this.perSession)
      throw new TerminalMountError('capacity', 'terminal capacity reached for this session');
    this.minted += 1;
    const size = normalizeTerminalSize(
      input.cols ?? DEFAULT_TERMINAL_SIZE.cols,
      input.rows ?? DEFAULT_TERMINAL_SIZE.rows,
    );
    const view: TerminalView = {
      id: `${this.minted}`.padStart(12, '0'),
      sessionId: session,
      title:
        input.title === undefined
          ? nextTerminalTitle(
              owned.map(terminal => terminal.title),
              this.perSession,
            )
          : normalizeTerminalTitle(input.title),
      state: 'running',
      ...size,
      viewers: 0,
      createdAt: AT,
      lastActivityAt: AT,
      idleDeadline: '2024-05-01T11:00:00.000Z',
    };
    this.records.set(view.id, view);
    return view;
  }

  async get(sessionId: string, terminalId: string): Promise<TerminalView> {
    return this.require(this.session(sessionId), terminalId);
  }

  async rename(sessionId: string, terminalId: string, title: string): Promise<TerminalView> {
    const current = this.require(this.session(sessionId), terminalId);
    const renamed = { ...current, title: normalizeTerminalTitle(title) };
    this.records.set(renamed.id, renamed);
    return renamed;
  }

  async close(sessionId: string, terminalId: string): Promise<void> {
    this.records.delete(this.require(this.session(sessionId), terminalId).id);
  }

  /**
   * A handler that records what the socket was handed, instead of driving a pane.
   *
   * The route's whole job is to prove who may stream and which terminal before the switch, so what
   * a case needs to assert is that the attachment it gets back is bound to the terminal it named —
   * not that tmux produced bytes, which `TerminalStreamBridge` has its own integration coverage for.
   */
  async stream(sessionId: string, terminalId: string, downstream: SocketDownstream): Promise<SocketHandler> {
    const target = `${this.session(sessionId)}/${this.require(this.session(sessionId), terminalId).id}`;
    this.streamed.push(target);
    return {
      open: async () => {
        downstream.send(new TextEncoder().encode(`open:${target}`));
      },
      fromClient: frame => {
        this.received.push(typeof frame === 'string' ? frame : 'binary');
      },
      close: () => {
        this.closedStreams.push(target);
      },
    };
  }

  /** Every `session/terminal` a socket was attached to, in order. */
  readonly streamed: string[] = [];
  readonly received: string[] = [];
  readonly closedStreams: string[] = [];

  private session(sessionId: string): string {
    if (!this.known.includes(sessionId)) throw new TerminalMountError('not_found', 'terminal session not found');
    return sessionId;
  }

  private owned(sessionId: string): TerminalView[] {
    return [...this.records.values()].filter(terminal => terminal.sessionId === sessionId);
  }

  private require(sessionId: string, terminalId: string): TerminalView {
    const found = this.owned(sessionId).find(terminal => terminal.id === terminalId);
    if (found === undefined) throw new TerminalMountError('not_found', 'terminal not found');
    return found;
  }
}

/** Wall-clock milliseconds the name fixtures agree on: `AT`, so a claim window is drivable. */
export const AT_MS = Date.parse(AT);

/**
 * A name pool over a fixed set of claims.
 *
 * The pool, the window arithmetic and the ordering are the REAL ones; only the fleet is the test's.
 * The start index is fixed at zero so a case can assert exactly which callsigns come back — the
 * production root randomises it, which is what stops two humans being handed the same first name.
 */
export function nameSubsystem(claims: readonly NameClaim[] = [], nowMs: number = AT_MS): NameSubsystem {
  return { claims: async () => claims, now: () => nowMs, startIndex: () => 0 };
}

/** One held callsign, claimed now and expiring at the end of the pool policy's own window. */
export function nameClaim(callsign: string, ownerId = 's1', claimedAtMs: number = AT_MS): NameClaim {
  return { callsign, ownerId, claimedAtMs, expiresAtMs: claimedAtMs + CALLSIGN_WINDOW_MS };
}

/**
 * An in-memory learning store.
 *
 * Every document the real `FileLearningStore` keeps on disk, kept in a field instead: the mount's
 * whole job is the decisions it makes over these documents, and a route test that passes here
 * exercises the same policy the daemon runs.
 */
export class FakeLearningStore implements LearningStorePort {
  readonly patches: Array<{ readonly id: string; readonly contents: string }> = [];

  constructor(
    public proposals: readonly Proposal[] = [],
    public observations: readonly Observation[] = [],
    public tombstones: readonly Tombstone[] = [],
    public state: LearningState = {},
    /** The manifest `latestRunManifest` answers with; deliberately `unknown` so a case can hand over
     *  a damaged one and prove the status read refuses it. */
    public manifest: unknown = undefined,
  ) {}

  async ensureDirectories(): Promise<void> {}

  async loadState(): Promise<LearningState> {
    return this.state;
  }

  async saveState(state: LearningState): Promise<void> {
    this.state = state;
  }

  async readObservations(): Promise<readonly Observation[]> {
    return this.observations;
  }

  async observationsById(): Promise<ReadonlyMap<string, Observation>> {
    return new Map(this.observations.map(observation => [observation.id, observation]));
  }

  async appendObservations(observations: readonly Observation[]): Promise<readonly Observation[]> {
    this.observations = [...this.observations, ...observations];
    return observations;
  }

  async loadProposals(): Promise<readonly Proposal[]> {
    return this.proposals;
  }

  async saveProposals(proposals: readonly Proposal[]): Promise<void> {
    this.proposals = proposals;
  }

  async loadTombstones(): Promise<readonly Tombstone[]> {
    return this.tombstones;
  }

  async saveTombstones(tombstones: readonly Tombstone[]): Promise<void> {
    this.tombstones = tombstones;
  }

  async writeRunManifest(manifest: RunManifest): Promise<void> {
    this.manifest = manifest;
  }

  async readRunManifest(): Promise<RunManifest | undefined> {
    return this.manifest as RunManifest | undefined;
  }

  async latestRunManifest(): Promise<RunManifest | undefined> {
    return this.manifest as RunManifest | undefined;
  }

  async writePatch(id: string, contents: string): Promise<string> {
    this.patches.push({ id, contents });
    return `/patches/${id}.md`;
  }
}

/** The learning schedule the fixtures report. Mining is off for the same reason production reports
 *  it off: no miner is mounted. */
export const LEARNING_CONFIG: LearningConfig = {
  enabled: false,
  agent: 'claude',
  intervalMinutes: 60,
  batchSize: 20,
  maxMinersPerRun: 2,
  maxSessionsPerRun: 40,
  minSpawnGapMinutes: 30,
};

/** A learning subsystem over an in-memory store. The transaction is real serialization — a promise
 *  chain — so a case can prove two concurrent verdicts do not lose one. */
export function learningSubsystem(store: FakeLearningStore = new FakeLearningStore()): LearningSubsystem {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    store,
    transaction: work => {
      const result = tail.then(work);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    config: () => LEARNING_CONFIG,
    now: () => AT,
  };
}

/** One observation, with only the fields a case cares about spelled out. */
export function observation(overrides: Partial<Observation> & { readonly id: string }): Observation {
  return {
    sessionId: 's1',
    mode: 'auto',
    cwd: '/work/ferretry',
    repo: 'ferretry',
    at: AT,
    kind: 'correction',
    gist: 'prefer the repo task surface',
    quote: 'use task test, not bun test',
    source: 'human',
    verified: true,
    runId: 'run-1',
    ...overrides,
  };
}

/** One proposal, defaulting to a pending rule supported by a single observation. */
export function proposal(overrides: Partial<Proposal> & { readonly id: string }): Proposal {
  return {
    category: 'global',
    state: 'pending',
    title: 'Always run the repo task surface',
    ruleText: 'Run `task test` rather than invoking the test runner directly.',
    target: { kind: 'global-agent-guidance', path: 'guidance.md', anchor: '## Agent rules' },
    observationIds: ['obs_1'],
    occurrences: 1,
    crossRepoCount: 1,
    firstSeen: AT,
    lastSeen: AT,
    identity: 'always-run-the-repo-task-surface',
    history: [{ at: AT, event: 'proposed:run-1', by: 'miner' }],
    ...overrides,
  };
}

/**
 * One session view, with only the fields a case cares about spelled out.
 *
 * Every document goes through the PROTOCOL schemas, so a fixture cannot drift from what the wire
 * demands: a view the schema would reject cannot be handed to a route here and pass.
 */
export function sessionView(
  id: string,
  config: Readonly<Record<string, unknown>> = {},
  state: Readonly<Record<string, unknown>> = {},
): SessionView {
  return {
    config: SessionConfigSchema.parse({
      id,
      incarnation: `${id}-1`,
      runtimeGeneration: 1,
      name: 'Wire Subsystems',
      boardAccess: 'none',
      agent: 'claude-auto',
      harness: 'claude',
      modelHint: 'opus',
      mode: 'auto',
      remoteControl: false,
      harnessFlags: [],
      cwd: '/work/ferretry',
      createdAt: AT,
      updatedAt: AT,
      turn: 1,
      intervalSeconds: 30,
      timeoutSeconds: 0,
      nudgeAfterSeconds: 0,
      killAfterSeconds: 0,
      directSendMaxChars: 4_096,
      resumeMenuChoice: 'full',
      maxSnapshots: 10,
      retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
      ...config,
    }),
    state: SessionStateSchema.parse({ id, status: 'running', turn: 1, lastActivityAt: AT, ...state }),
    directory: `/state/sessions/${id}`,
  };
}

/**
 * A session read over a fixed set of views.
 *
 * The REFUSALS are the part worth faking: an id the layout would reject and a session whose
 * documents will not parse are both states the production reader raises in its own taxonomy, and the
 * mount's whole job is restating them as answers a caller can act on.
 */
export function sessionDirectory(
  views: readonly SessionView[] = [],
  refusals: { readonly invalid?: readonly string[]; readonly unusable?: readonly string[] } = {},
): SessionDirectorySubsystem {
  return {
    list: async () => views,
    get: async reference => {
      if ((refusals.invalid ?? []).includes(reference))
        throw new SessionReadError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
      if ((refusals.unusable ?? []).includes(reference))
        throw new SessionReadError('unusable', `the documents for session ${reference} do not satisfy the protocol`);
      return views.find(view => view.config.id === reference);
    },
  };
}

/**
 * Starting and stopping sessions, in memory.
 *
 * The IDEMPOTENCY is real, because it is the contract the mount exists to serve: the same request id
 * returns the session it already started, and a different payload under a spent id is a conflict. What
 * is faked is only the launch — spawning an agent is not something a route test may do — and every
 * refusal is raised in the production taxonomy the mount restates.
 */
export class FakeSessionControl implements SessionControlSubsystem {
  /** Every start that reached the subsystem, as `requestId` and the agent it named. */
  readonly starts: Array<readonly [string, string]> = [];
  /** Every stop that reached it, as the session and the reason given. */
  readonly stops: Array<readonly [string, string | undefined]> = [];
  /** Every callsign a start asked for, with whether a taken one could be substituted. */
  readonly requested: Array<readonly [string, boolean]> = [];
  /** The inline attachments each start carried, so a mount that dropped them is visible. */
  readonly attached: Array<StartSessionRequest['initialAttachments']> = [];
  /** The board access each start asked for and the capability it presented, as the mount passed
   *  them down. A mount that read the capability from the body instead of the header, or dropped it,
   *  is visible here. */
  readonly boardAsks: Array<readonly [StartSessionRequest['boardAccess'], string | undefined]> = [];
  /** Board access the fake refuses, as the domain would: the role that is refused, and why. */
  boardRefusal: { readonly role: string; readonly error: TaskBoardError } | undefined;
  private readonly spent = new Map<string, { readonly id: string; readonly payload: string }>();
  private minted = 0;

  constructor(
    /** Sessions that already exist, so a stop has something to stop. */
    private readonly known: readonly string[] = ['s1'],
    /** Agents no account is published under, so the unknown-agent refusal is drivable. */
    private readonly unknownAgents: readonly string[] = [],
  ) {}

  async start(
    request: StartSessionRequest,
    requestId: string,
    payload: string,
    boardCapability?: string,
  ): Promise<SessionView> {
    this.starts.push([requestId, request.agent]);
    this.attached.push(request.initialAttachments);
    this.boardAsks.push([request.boardAccess, boardCapability]);
    if (this.boardRefusal !== undefined && this.boardRefusal.role === request.boardAccess)
      throw this.boardRefusal.error;
    if (request.teammate !== undefined) this.requested.push([request.teammate, request.teammateFallback === true]);
    const already = this.spent.get(requestId);
    if (already !== undefined) {
      if (already.payload !== payload)
        throw new SessionControlError('conflict', `request id ${JSON.stringify(requestId)} started another session`);
      return sessionView(already.id, { agent: request.agent }, { status: 'running' });
    }
    if (this.unknownAgents.includes(request.agent))
      throw new SessionControlError('unknown_agent', `no account is published as ${JSON.stringify(request.agent)}`);
    this.minted += 1;
    const id = `started-${this.minted}`;
    this.spent.set(requestId, { id, payload });
    return sessionView(id, { agent: request.agent, mode: request.mode }, { status: 'running' });
  }

  /**
   * The recovery read, over the same ledger the idempotency uses.
   *
   * The digest is the REAL one — `fakePayloadDigest` is the same SHA-256 hex the protocol client
   * computes — because a fake that accepted any digest would let the mount ship without the check
   * that stops one caller reading another's request id.
   */
  async recover(requestId: string, digest: string): Promise<SessionView | undefined> {
    const already = this.spent.get(requestId);
    if (already === undefined) return undefined;
    if (fakePayloadDigest(already.payload) !== digest)
      throw new SessionControlError('conflict', `request id ${JSON.stringify(requestId)} started another session`);
    return sessionView(already.id, {}, { status: 'running' });
  }

  async stop(sessionId: string, reason: string | undefined): Promise<SessionView> {
    this.stops.push([sessionId, reason]);
    if (!this.known.includes(sessionId)) throw new SessionControlError('not_found', `no session ${sessionId}`);
    return sessionView(sessionId, {}, { status: 'stopped', ...(reason === undefined ? {} : { reason }) });
  }
}

/** The digest the protocol client sends when it recovers a start: SHA-256 hex of the body text. */
export function fakePayloadDigest(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * A team recommender over the REAL engine.
 *
 * The classification, the ranking, the floors and the exclusion reasons are all production code —
 * only the manifest and the catalog are the test's — so a case that passes here is asserting the
 * answer the daemon would actually give. `usage` is honoured the way the composition root honours it:
 * a caller who declines the probe gets an advisor whose feed measured nothing.
 */
export function recommendSubsystem(
  options: {
    readonly accounts?: readonly CoreAccount[];
    /** Set to make the catalog read refuse, standing in for an operator who has written none. */
    readonly unconfigured?: boolean;
    /** Recorded per call, so a case can prove which feed the flag selected. */
    readonly probes?: string[];
  } = {},
): RecommendSubsystem {
  const inventoryPort: AccountInventoryPort = { accounts: async () => options.accounts ?? inventory };
  const catalogPort: RoutingCatalogPort = {
    catalog: async () => {
      if (options.unconfigured === true)
        throw new RecommendError('unconfigured', 'no routing catalog at /state/config/routing.json');
      return catalog;
    },
  };
  const feed = (label: string): UsageFeedPort => ({
    accounts: async () => {
      options.probes?.push(label);
      return [];
    },
    snapshotAt: () => undefined,
    hasSnapshot: () => false,
  });
  const withQuota = new TeamAdvisor(inventoryPort, catalogPort, feed('probed'));
  const withoutQuota = new TeamAdvisor(inventoryPort, catalogPort, feed('unread'));
  return {
    recommend: async input => await (input.usage ? withQuota : withoutQuota).recommend({ task: input.task }),
  };
}

/** The daemon version the health fixture reports. Any non-empty string; the wire only demands one. */
export const HEALTH_VERSION = '9.9.9-test';

/** How the health fixture may be pointed at a different fleet, build or supervision posture. */
export interface HealthWorld {
  readonly sessions?: readonly SessionHealthObservation[];
  readonly bootstrapFinished?: boolean;
  readonly bootstrapErrors?: readonly string[];
  /** Whether this daemon runs per-session monitors and a warden sweep timer at all. */
  readonly supervisesMonitors?: boolean;
  readonly supervisesWarden?: boolean;
  readonly lastSweepAt?: string;
  /** Self-check ticks to run before the report is served, so a case can drive a filled ledger. */
  readonly ticks?: number;
  readonly scratch?: ScratchReclamation;
  readonly pid?: number;
}

/**
 * The daemon's health over the REAL `SessionHealthService`.
 *
 * Only the four IO ports are the test's — the fleet inventory, the consistency pass, the event sink
 * and the restart stamp. The ledger, the wedge classifier, the sweep verdict and the report builder
 * are all production, so a case that passes here asserts the answer the daemon would actually give
 * rather than one the fixture composed.
 *
 * The monotonic clock advances by exactly one configured interval per reading, which is what an
 * on-time tick looks like: a fixture whose clock stood still would make the second tick a zero-gap
 * reading and the freshness a fiction.
 */
export function healthSubsystem(world: HealthWorld = {}): DaemonHealthSubsystem {
  const clean: IncoherencePass = { missingFromIndex: [], staleRows: [], zombies: [], repaired: [], unhealable: [] };
  const events: SessionHealthEvent[] = [];
  let stamp: SelfRestartStamp | undefined;
  let elapsedMs = 0;
  const service = new SessionHealthService(
    {
      inventory: {
        observe: async () => ({
          sessions: world.sessions ?? [],
          sweep: {
            timerArmed: world.supervisesWarden ?? false,
            intervalMs: 0,
            ...(world.lastSweepAt === undefined ? {} : { lastSweepAt: world.lastSweepAt }),
          },
          bootstrapFinished: world.bootstrapFinished ?? true,
          bootstrapErrors: world.bootstrapErrors ?? [],
          supervisesMonitors: world.supervisesMonitors ?? false,
          supervisesWarden: world.supervisesWarden ?? false,
        }),
      },
      consistency: { run: async () => clean },
      repair: { startMonitor: async () => {}, rearmWarden: async () => {} },
      events: {
        emit: async event => {
          events.push(event);
        },
      },
      clock: { now: () => AT },
      wallClock: { nowMs: () => AT_MS },
      monotonic: {
        elapsedMs: () => {
          elapsedMs += defaultSessionHealthSettings.selfCheckIntervalMs;
          return elapsedMs;
        },
      },
      restarts: new SelfRestartCoordinator(
        {
          read: async () => stamp,
          write: async written => {
            stamp = written;
          },
          clear: async () => {
            stamp = undefined;
          },
        },
        { restart: async () => false },
        defaultSessionHealthSettings,
      ),
      version: HEALTH_VERSION,
    },
    defaultSessionHealthSettings,
  );
  return {
    report: async () => {
      for (let tick = 0; tick < (world.ticks ?? 0); tick += 1) await service.selfCheck();
      return await service.report();
    },
    pid: world.pid ?? 4321,
    scratch: world.scratch ?? { enabled: false, reclaimedSessions: 0, reclaimedBytes: 0 },
  };
}

/** One session as the self-check observes it. */
export function healthObservation(
  id: string,
  overrides: Partial<SessionHealthObservation> = {},
): SessionHealthObservation {
  return { id, terminal: false, monitored: false, ...overrides };
}

/** A feed that never collected: enough to build the base surface without a transport. */
export const emptyFeed: UsageFeedPort = {
  accounts: async () => [],
  snapshotAt: () => undefined,
  hasSnapshot: () => false,
};

/**
 * A reviver that records instead of replacing a pane.
 *
 * The ACTOR is what this fake exists to capture. The whole reason the resume mount reads the actor
 * from the authorization boundary rather than the body is that an operator and an automated reviver
 * get different privileges, and the only way to prove the mount passes the right one through is to
 * record what the subsystem was handed.
 *
 * Its refusals are the four the domain raises, each drivable by the session it is asked about, so
 * every HTTP answer the mount can give is reachable without a real service behind it.
 */
export class FakeSessionResume implements SessionResumeSubsystem {
  /** Every revive that reached the subsystem, as the session, the actor and the message. */
  readonly resumes: Array<readonly [string, ResumeActor, string | undefined]> = [];

  constructor(
    /** Sessions that exist, so a revive has something to revive. */
    private readonly known: readonly string[] = ['s1'],
    /** Session ids mapped to the refusal asking about them raises. */
    private readonly refusals: Readonly<Record<string, SessionResumeError>> = {},
  ) {}

  async resume(sessionId: string, actor: ResumeActor, message: string | undefined): Promise<SessionView> {
    this.resumes.push([sessionId, actor, message]);
    const refusal = this.refusals[sessionId];
    if (refusal !== undefined) throw refusal;
    if (!this.known.includes(sessionId)) throw new SessionResumeError('not_found', `no session ${sessionId}`);
    // Turn two, because a revive that handed the agent a new turn moved the counter: a view still
    // reporting turn one would not distinguish a revive from a read.
    return sessionView(sessionId, {}, { status: 'running', turn: 2 });
  }
}

/**
 * A session's own voice, recorded instead of acted on.
 *
 * The REQUEST is what this fake exists to capture. A signal is entirely decided by its `kind` plus
 * the three wait fields, and the mount's only job is to hand all four through untouched — so proving
 * `until`, `condition` and `peer` arrive is the difference between a park with a deadline and an
 * open-ended one nothing will wake on time.
 *
 * Its refusals are keyed by session, so every HTTP answer the mount can give is reachable without a
 * pane, a marker file or a state document behind it.
 */
export class FakeSessionSignal implements SessionSignalSubsystem {
  /** Every signal that reached the subsystem, as the session and the request it carried. */
  readonly signals: Array<readonly [string, SignalSessionRequest]> = [];

  constructor(
    /** Sessions that exist, so a signal has something to speak for. */
    private readonly known: readonly string[] = ['s1'],
    /** Session ids mapped to the refusal asking about them raises. */
    private readonly refusals: Readonly<Record<string, SessionSignalError>> = {},
  ) {}

  async signal(sessionId: string, request: SignalSessionRequest): Promise<SessionView> {
    this.signals.push([sessionId, request]);
    const refusal = this.refusals[sessionId];
    if (refusal !== undefined) throw refusal;
    if (!this.known.includes(sessionId)) throw new SessionSignalError('not_found', `no session ${sessionId}`);
    // The status each kind produces, because a view still reporting `running` would not distinguish a
    // completion from a read.
    const status = request.kind === 'done' ? 'completed' : request.kind === 'working' ? 'running' : 'waiting';
    return sessionView(sessionId, {}, { status });
  }
}

/**
 * A send surface that records instead of typing into a terminal.
 *
 * The REQUEST is what this fake exists to capture. Two of its fields never appear in the body — the
 * idempotency key comes from a header and the SENDER comes from the caller's own credential — so
 * proving they arrive is the only way to know a retry cannot become a second message and a caller
 * cannot claim to be somebody else.
 */
export class FakeSessionSend implements SessionSendSubsystem {
  readonly sends: Array<readonly [string, SendInput]> = [];
  readonly interrupts: string[] = [];

  constructor(
    private readonly known: readonly string[] = ['s1'],
    private readonly refusals: Readonly<Record<string, SessionSendError>> = {},
  ) {}

  async send(sessionId: string, request: SendInput): Promise<SendResult> {
    this.sends.push([sessionId, request]);
    this.refuse(sessionId);
    return { ...sessionView(sessionId, {}, { status: 'running' }), disposition: 'delivered' };
  }

  async interrupt(sessionId: string): Promise<SessionView> {
    this.interrupts.push(sessionId);
    this.refuse(sessionId);
    return sessionView(sessionId, {}, { status: 'interrupted' });
  }

  private refuse(sessionId: string): void {
    const refusal = this.refusals[sessionId];
    if (refusal !== undefined) throw refusal;
    if (!this.known.includes(sessionId)) throw new SessionSendError('not_found', `no session ${sessionId}`);
  }
}

/**
 * A migrator that records instead of moving a session.
 *
 * The REQUEST is what this fake exists to capture. A migration is decided from three fields the
 * mount must pass through untouched — the target agent, the model, and whether the caller accepted a
 * smaller context window — and the last of those is a `z.default(false)`, so proving it arrives as
 * `false` rather than `undefined` is the difference between a truncation the caller accepted and one
 * the daemon inferred.
 *
 * Its refusals are keyed by session, so every HTTP answer the mount can give is reachable without a
 * preflight, a pane or a fleet manifest behind it.
 */
export class FakeSessionMigrate implements SessionMigrateSubsystem {
  /** Every migration that reached the subsystem, as the session and the request it carried. */
  readonly migrations: Array<
    readonly [string, { readonly agent: string; readonly model?: string; readonly allowContextDowngrade: boolean }]
  > = [];

  constructor(
    /** Sessions that exist, so a migration has something to move. */
    private readonly known: readonly string[] = ['s1'],
    /** Session ids mapped to the refusal asking about them raises. */
    private readonly refusals: Readonly<Record<string, SessionMigrateError>> = {},
  ) {}

  async migrate(
    sessionId: string,
    request: { readonly agent: string; readonly model?: string; readonly allowContextDowngrade: boolean },
  ): Promise<SessionView> {
    this.migrations.push([sessionId, request]);
    const refusal = this.refusals[sessionId];
    if (refusal !== undefined) throw refusal;
    if (!this.known.includes(sessionId)) throw new SessionMigrateError('not_found', `no session ${sessionId}`);
    // The agent the caller asked for, in the view: a migration that answered with the old account
    // would be indistinguishable from a read.
    return sessionView(sessionId, { agent: request.agent }, { status: 'running', turn: 2 });
  }
}

/**
 * A task-board world held entirely in memory.
 *
 * The REDUCERS are production code — this fake supplies only the four ports they were written against
 * — so a board built through these routes is authorized by the same policy a real one is. What is
 * faked is the document (a variable rather than a file), the clock, the randomness, and the delivery
 * channel, which is recorded so a test can assert that a minted capability was handed to the session
 * it was minted for rather than merely produced.
 */
export class FakeTaskBoards implements TaskBoardSubsystem {
  /** The authoritative state, exactly as a committed document would hold it. */
  state: TaskBoardRepositoryState = EMPTY_TASK_BOARD_REPOSITORY_STATE;
  /** Every delivery, in order: `[sessionId, variables]`. */
  readonly delivered: [string, Readonly<Record<string, string>>][] = [];
  /** Ids are sequential so an assertion can name one. */
  private minted = 0;
  /** Raised by `deliver` when set, so the failure of a delivery is drivable. */
  deliveryFailure?: Error;

  constructor(
    private readonly directory: readonly TaskBoardSession[] = [],
    /** The operator's capability. A test presenting anything else must be refused. */
    readonly operatorCapability = 'operator-secret',
  ) {}

  readonly issuer: TaskBoardCredentialIssuer = {
    id: kind => {
      this.minted += 1;
      return `${kind}-${this.minted}`;
    },
    capability: () => {
      this.minted += 1;
      const value = `capability-${this.minted}`;
      return { value, hash: this.issuer.hash(value) };
    },
    // A prefix rather than a digest, so a failing assertion names the secret it was derived from.
    hash: value => `hash:${value}`,
  };

  readonly repository: TaskBoardRepository = {
    snapshot: async () => this.state,
    transaction: async operation => {
      const mutation = await operation(this.state);
      this.state = mutation.state;
      return mutation.result;
    },
  };

  readonly sessions: TaskBoardSessionDirectory = { snapshot: async () => this.directory };

  /** The instant every mutation is stamped with. Settable so a test can let an invitation expire. */
  instant: string = AT;

  now(): string {
    return this.instant;
  }

  async operatorCapabilityHash(): Promise<string> {
    return this.issuer.hash(this.operatorCapability);
  }

  async deliver(sessionId: string, variables: Readonly<Record<string, string>>): Promise<void> {
    if (this.deliveryFailure !== undefined) throw this.deliveryFailure;
    this.delivered.push([sessionId, variables]);
  }

  /** The plaintext capability the board issued to one session, as its binding holds it. */
  capabilityFor(sessionId: string): string | undefined {
    return this.state.bindings.find(binding => binding.sessionId === sessionId)?.capability;
  }
}

/** A session the board domain can address: it carries a credential hash, so a grant can bind to it. */
export function boardSession(input: Partial<TaskBoardSession> & Pick<TaskBoardSession, 'id'>): TaskBoardSession {
  return {
    id: input.id,
    incarnation: input.incarnation ?? `${input.id}-1`,
    runtimeGeneration: input.runtimeGeneration ?? 1,
    parentSessionId: input.parentSessionId ?? null,
    mode: input.mode ?? 'interactive',
    active: input.active ?? true,
    name: input.name ?? null,
    teammate: input.teammate ?? null,
    sessionCapabilityHash: input.sessionCapabilityHash ?? `hash:session:${input.id}`,
  };
}

/**
 * A login window with no host behind it.
 *
 * The real one owns an X server, a Chrome and a VNC listener, so the mount is proved against this
 * instead: the routes, the action schema, the scope and the refusal mapping are all exercised without
 * anything being spawned. `BrowserLoginWindowService` itself is proved separately, against a fake
 * runtime, in the integration tier.
 */
export class FakeBrowserLogin implements BrowserLoginLifecycle {
  readonly calls: string[] = [];
  private state: BrowserLoginStatus = { state: 'closed', profilePrimed: false };

  constructor(
    /** What the next lifecycle call refuses with, if anything. */
    private readonly refusal?: BrowserControlError,
  ) {}

  async status(): Promise<BrowserLoginStatus> {
    this.calls.push('status');
    // A READ refuses for the same reasons an action does — the real window's `status` asks the profile
    // store whether it is primed — so the fake refuses on every call rather than only on the writes.
    if (this.refusal) throw this.refusal;
    return this.state;
  }

  async start(options: { readonly minutes?: number } = {}): Promise<BrowserLoginStatus> {
    this.calls.push(`start:${options.minutes ?? 'default'}`);
    if (this.refusal) throw this.refusal;
    this.state = {
      state: 'open',
      profilePrimed: false,
      openedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:15:00.000Z',
      connection: {
        host: '127.0.0.1',
        port: 5_901,
        password: 'abcd2345',
        sshTunnel: 'ssh -N -L 5901:127.0.0.1:5901 operator@host',
      },
    };
    return this.state;
  }

  async stop(options: { readonly primed?: boolean } = {}): Promise<BrowserLoginStatus> {
    this.calls.push(`stop:${options.primed ?? 'unstated'}`);
    if (this.refusal) throw this.refusal;
    this.state = { state: 'closed', profilePrimed: options.primed === true };
    return this.state;
  }

  async confirm(): Promise<BrowserLoginStatus> {
    this.calls.push('confirm');
    if (this.refusal) throw this.refusal;
    this.state = { ...this.state, profilePrimed: true };
    return this.state;
  }
}

/** A window whose every call fails the way an unexpected defect does, so the mount can be shown to
 *  let it through as a 500 rather than dressing it up as a refusal. */
export class BrokenBrowserLogin implements BrowserLoginLifecycle {
  async status(): Promise<BrowserLoginStatus> {
    throw new Error('/home/operator/.fy/browser/profile.lock is unreadable');
  }

  async start(): Promise<BrowserLoginStatus> {
    throw new Error('/home/operator/.fy/browser/profile.lock is unreadable');
  }

  async stop(): Promise<BrowserLoginStatus> {
    throw new Error('/home/operator/.fy/browser/profile.lock is unreadable');
  }

  async confirm(): Promise<BrowserLoginStatus> {
    throw new Error('/home/operator/.fy/browser/profile.lock is unreadable');
  }
}

/**
 * A dictation surface that records what it was handed and answers whatever it was told to.
 *
 * The real one spawns a Whisper worker and downloads model files, so nothing about the mount can be
 * exercised against it. This keeps the route table, the credentials and the dispatcher exactly as
 * production builds them and substitutes only the process-spawning half.
 */
export class FakeStt implements SttSubsystem {
  readonly seen: string[] = [];
  closed = 0;

  constructor(
    /** `undefined` means "this surface does not own that path", which is what the real service
     *  answers for a model id that decodes to something with a separator in it. */
    private readonly answer: (request: Request) => Response | undefined = () => Response.json({ ok: true }),
  ) {}

  async handle(request: Request): Promise<Response | undefined> {
    this.seen.push(`${request.method} ${new URL(request.url).pathname}`);
    return this.answer(request);
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}
