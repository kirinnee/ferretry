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
  type SessionView,
  type TaskActionRequest,
  type TaskCreateRequestInput,
  type TerminalListView,
  type TerminalView,
} from '@ferretry/protocol';
import type { AnalyticsPricingRate } from '../../../../src/lib/analytics/pricing.ts';
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
import { RecommendError, type RecommendSubsystem } from '../../../../src/lib/runtime/mounts/recommend.ts';
import { SessionReadError, type SessionDirectorySubsystem } from '../../../../src/lib/runtime/mounts/sessions.ts';
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
    /** Set to make every read fail, standing in for a snapshot the decoder refused. */
    private readonly unreadable = false,
  ) {}

  async list(): Promise<{ readonly entries: readonly TaskEntry[]; readonly parseErrors: readonly TaskParseIssue[] }> {
    if (this.unreadable) throw new TaskError('invalid', 'the snapshot could not be read');
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
    observe: async assignee => (world.observations ?? {})[assignee],
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

/** A feed that never collected: enough to build the base surface without a transport. */
export const emptyFeed: UsageFeedPort = {
  accounts: async () => [],
  snapshotAt: () => undefined,
  hasSnapshot: () => false,
};
