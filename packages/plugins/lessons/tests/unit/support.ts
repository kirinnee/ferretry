import { LessonsService } from '../../daemon/lib/index.ts';
import {
  type LessonFilesPort,
  type GlobalLessonsPort,
  type LessonSessionFacts,
  type LessonSessionsPort,
  type LessonsStorePort,
  type Observation,
  type OwnerMessage,
  type PassiveChannelPort,
  type PricePort,
  type Proposal,
  type ScanMinerPort,
  type SessionDigest,
  type StoredFerretLessons,
  type Tombstone,
  type LessonsState,
} from '../../daemon/lib/index.ts';
import type { LessonsConfig, RunManifest } from '../../contract/index.ts';

/** The one instant these fixtures live at. */
export const AT = '2024-05-01T10:00:00.000Z';

export class FakeLessonsStore implements LessonsStorePort {
  readonly patches: Array<{ readonly id: string; readonly contents: string }> = [];

  constructor(
    public proposals: readonly Proposal[] = [],
    public observations: readonly Observation[] = [],
    public tombstones: readonly Tombstone[] = [],
    public state: LessonsState = {},
    /** The manifest `latestRunManifest` answers with; deliberately `unknown` so a case can hand over
     *  a damaged one and prove the status read refuses it. */
    public manifest: unknown = undefined,
  ) {}

  async loadState(): Promise<LessonsState> {
    return this.state;
  }

  async saveState(state: LessonsState): Promise<void> {
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

  /** Which ferrets are instructed to learn, as the switch last left them. */
  sessionLessons: readonly StoredFerretLessons[] = [];

  readonly digests = new Map<string, readonly SessionDigest[]>();
  machineDefault: boolean | undefined;
  global: string | undefined;

  async runIds(): Promise<readonly string[]> {
    return this.manifest === undefined ? [] : [(this.manifest as RunManifest).runId];
  }

  async writeDigests(runId: string, digests: readonly SessionDigest[]): Promise<void> {
    this.digests.set(runId, digests);
  }

  async readDigests(runId: string): Promise<readonly SessionDigest[] | undefined> {
    return this.digests.get(runId);
  }

  async passiveDefault(): Promise<boolean | undefined> {
    return this.machineDefault;
  }

  async setPassiveDefault(value: boolean): Promise<void> {
    this.machineDefault = value;
  }

  async readGlobal(): Promise<string | undefined> {
    return this.global;
  }

  async writeGlobal(text: string): Promise<void> {
    this.global = text;
  }

  async loadFerretLessons(): Promise<readonly StoredFerretLessons[]> {
    return this.sessionLessons;
  }

  async saveFerretLessons(records: readonly StoredFerretLessons[]): Promise<void> {
    this.sessionLessons = records;
  }
}

// ── Lessons: in-memory ports for `LessonsService` ─────────────────────────────────────────────────

/** One ferret as lessons see it, with only the fields a case cares about spelled out. */
export function lessonFacts(
  overrides: Partial<LessonSessionFacts> & { readonly ferretId: string },
): LessonSessionFacts {
  return {
    cwd: '/work/ferretry/packages/cli',
    harness: 'claude',
    mode: 'interactive',
    createdAt: AT,
    running: true,
    hasTranscript: true,
    ...overrides,
  };
}

/** The daemon's sessions, and the owner's latest message in each. */
class MemoryLessonSessions implements LessonSessionsPort {
  readonly owner = new Map<string, OwnerMessage>();

  constructor(public sessions: readonly LessonSessionFacts[] = []) {}

  async facts(ferretId: string): Promise<LessonSessionFacts | undefined> {
    return this.sessions.find(entry => entry.ferretId === ferretId);
  }

  async list(): Promise<readonly LessonSessionFacts[]> {
    return this.sessions;
  }

  async latestOwnerMessage(ferretId: string): Promise<OwnerMessage | undefined> {
    return this.owner.get(ferretId);
  }
}

/** Instruction files as a map of path to text; a cwd's project is its entry in `roots`, else itself. */
class MemoryLessonFiles implements LessonFilesPort {
  readonly texts = new Map<string, string>();
  readonly roots = new Map<string, string>();
  readonly writes: Array<{ readonly path: string; readonly text: string }> = [];

  async projectRoot(cwd: string): Promise<string> {
    return this.roots.get(cwd) ?? cwd;
  }

  async read(path: string): Promise<string | undefined> {
    return this.texts.get(path);
  }

  async write(path: string, text: string): Promise<void> {
    this.writes.push({ path, text });
    this.texts.set(path, text);
  }

  join(directory: string, name: string): string {
    return `${directory}/${name}`;
  }
}

/** The fleet's global lessons document. */
class MemoryGlobalLessons implements GlobalLessonsPort {
  ensured = 0;

  constructor(
    readonly path = '/fleet/assets/instructions/lessons.md',
    readonly notes: readonly string[] = ['No profile includes instructions/lessons yet.'],
  ) {}

  async locate(): Promise<{ readonly path: string; readonly notes: readonly string[] }> {
    return { path: this.path, notes: this.notes };
  }

  async ensureComponent(): Promise<void> {
    this.ensured += 1;
  }
}

/** A ferret's launch environment and queue, recorded. */
class MemoryPassiveChannel implements PassiveChannelPort {
  readonly environment: Array<{ readonly ferretId: string; readonly passive: boolean }> = [];
  readonly sends: Array<{ readonly ferretId: string; readonly message: string }> = [];

  async setEnvironment(ferretId: string, passive: boolean): Promise<void> {
    this.environment.push({ ferretId, passive });
  }

  async reinstruct(ferretId: string, message: string): Promise<string> {
    this.sends.push({ ferretId, message });
    return `send-${String(this.sends.length)}`;
  }
}

type Collected = Awaited<ReturnType<ScanMinerPort['collect']>>;

/**
 * A miner. A ferret with an entry in `digests` has something to mine; a batch none of whose ferrets
 * has one starts no miner. `outcomes` answers `collect` per batch index, `pending` when unset.
 */
class MemoryScanMiner implements ScanMinerPort {
  readonly digests = new Map<string, number>();
  readonly outcomes = new Map<number, Collected>();
  readonly starts: Array<{
    readonly runId: string;
    readonly batch: number;
    readonly ferretIds: readonly string[];
    readonly agent: string;
    readonly model: string | undefined;
  }> = [];
  readonly stopped: string[] = [];

  async digestCharacters(ferretId: string): Promise<number | undefined> {
    return this.digests.get(ferretId);
  }

  async start(
    runId: string,
    batch: number,
    ferretIds: readonly string[],
    agent: string,
    model: string | undefined,
  ): Promise<string | undefined> {
    this.starts.push({ runId, batch, ferretIds, agent, model });
    return ferretIds.some(id => this.digests.has(id)) ? `miner-${String(batch)}` : undefined;
  }

  async collect(_runId: string, batch: number): Promise<Collected> {
    return this.outcomes.get(batch) ?? 'pending';
  }

  async stop(minerFerretId: string): Promise<void> {
    this.stopped.push(minerFerretId);
  }
}

/** A price list in USD per million tokens, input and output alike; a model not in it is unpriced. */
class MemoryPrices implements PricePort {
  readonly asked: Array<{ readonly model: string; readonly inputTokens: number; readonly outputTokens: number }> = [];

  constructor(readonly perMillion: ReadonlyMap<string, number> = new Map([['opus', 10]])) {}

  async usd(model: string, inputTokens: number, outputTokens: number): Promise<number | undefined> {
    this.asked.push({ model, inputTokens, outputTokens });
    const rate = this.perMillion.get(model);
    return rate === undefined ? undefined : ((inputTokens + outputTokens) * rate) / 1_000_000;
  }
}

/** Every port `LessonsService` reads, in memory, and the service over them. */
export interface LessonsWorld {
  readonly store: FakeLessonsStore;
  readonly sessions: MemoryLessonSessions;
  readonly files: MemoryLessonFiles;
  readonly global: MemoryGlobalLessons;
  readonly passive: MemoryPassiveChannel;
  readonly miner: MemoryScanMiner;
  readonly prices: MemoryPrices;
  config: LessonsConfig;
  readonly service: LessonsService;
}

/** The miner's own label in these fixtures. */
export const LESSON_MINER_LABEL = 'ferretry-learning';

export function lessonsWorld(store: FakeLessonsStore = new FakeLessonsStore()): LessonsWorld {
  const world = {
    store,
    sessions: new MemoryLessonSessions(),
    files: new MemoryLessonFiles(),
    global: new MemoryGlobalLessons(),
    passive: new MemoryPassiveChannel(),
    miner: new MemoryScanMiner(),
    prices: new MemoryPrices(),
    config: LESSONS_CONFIG,
  } as Omit<LessonsWorld, 'service'> & { service?: LessonsService };
  world.service = new LessonsService({
    store: world.store,
    sessions: world.sessions,
    files: world.files,
    global: world.global,
    passive: world.passive,
    miner: world.miner,
    prices: world.prices,
    config: () => world.config,
    now: () => AT,
    binaryName: 'fy',
    minerLabel: LESSON_MINER_LABEL,
  });
  return world as LessonsWorld;
}

/** The lessons schedule the fixtures report. */
export const LESSONS_CONFIG: LessonsConfig = {
  enabled: false,
  agent: 'claude',
  intervalMinutes: 60,
  batchSize: 20,
  maxMinersPerRun: 2,
  maxFerretsPerRun: 40,
  minSpawnGapMinutes: 30,
  passiveDefault: false,
};

export function observation(overrides: Partial<Observation> & { readonly id: string }): Observation {
  return {
    ferretId: 's1',
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
    source: 'scan',
    count: 1,
    ...overrides,
  };
}

/** The session credential the fixtures' one ferret presents, and the ferret it proves. */
export const LESSON_FERRET = 'ferret-1';
