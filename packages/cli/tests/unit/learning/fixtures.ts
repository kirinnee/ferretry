import type {
  EvidenceView,
  LearningActionRequest,
  LearningConfig,
  LearningPatchResponse,
  LearningStatus,
  ProposalState,
  ProposalView,
  RunManifest,
} from '@ferretry/protocol';
import type { ILearningGateway, ILearningOutput } from '../../../src/lib/learning/ports';

/** Captures what a controller printed, so tests read the rendering rather than a mock call. */
export class CapturingOutput implements ILearningOutput {
  readonly lines: string[] = [];

  success(message: string): void {
    this.lines.push(message);
  }

  /** Everything printed, joined the way a terminal would show it. */
  get text(): string {
    return this.lines.join('\n');
  }
}

export function evidence(overrides: Partial<EvidenceView> = {}): EvidenceView {
  return {
    observationId: 'obs-1',
    sessionId: 'ms8kkfyd-95b7037e',
    repo: 'ferretry',
    at: '2026-07-20T09:00:00.000Z',
    quote: 'never run bun install at the repository root',
    source: 'human',
    kind: 'correction',
    ...overrides,
  };
}

export function proposal(id: string, overrides: Partial<ProposalView> = {}): ProposalView {
  return {
    id,
    category: 'global',
    state: 'pending',
    title: 'install from the package directory',
    ruleText: 'Run bun install inside the target package, never at the repository root.',
    target: { kind: 'global-agent-guidance', path: 'guidance.md' },
    observationIds: ['obs-1'],
    occurrences: 3,
    crossRepoCount: 2,
    firstSeen: '2026-07-10T09:00:00.000Z',
    lastSeen: '2026-07-20T09:00:00.000Z',
    identity: 'install-from-package-dir',
    history: [{ at: '2026-07-10T09:00:00.000Z', event: 'created', by: 'miner' }],
    evidence: [evidence()],
    ...overrides,
  };
}

export function runManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: 'run-7',
    startedAt: '2026-07-31T09:00:00.000Z',
    finishedAt: '2026-07-31T09:04:00.000Z',
    sessionsScanned: 12,
    sessionsWithSignal: 4,
    minerSessions: ['miner-1'],
    observationsProposed: 9,
    observationsVerified: 7,
    rejectedQuotes: 2,
    malformedFiles: 0,
    proposalsCreated: 2,
    proposalsStrengthened: 1,
    proposalsSuppressedByTombstone: 0,
    perHarness: { claude: 3, codex: 1 },
    ...overrides,
  };
}

export function learningStatus(overrides: Partial<LearningStatus> = {}): LearningStatus {
  return {
    enabled: true,
    intervalMinutes: 60,
    watermarkAt: '2026-07-31T08:00:00.000Z',
    lastRunAt: '2026-07-31T09:04:00.000Z',
    pending: { total: 3, strong: 1, weak: 2 },
    totals: { observations: 40, proposals: 6, tombstones: 1 },
    running: false,
    ...overrides,
  };
}

export function learningConfig(overrides: Partial<LearningConfig> = {}): LearningConfig {
  return {
    enabled: true,
    agent: 'miner',
    intervalMinutes: 60,
    batchSize: 20,
    maxMinersPerRun: 2,
    maxSessionsPerRun: 30,
    minSpawnGapMinutes: 15,
    ...overrides,
  };
}

export function patchResponse(overrides: Partial<LearningPatchResponse> = {}): LearningPatchResponse {
  return { path: 'guidance.md', contents: '- install from the package directory\n', ...overrides };
}

/** What one gateway call recorded. */
export interface ActCall {
  readonly id: string;
  readonly request: LearningActionRequest;
}

/**
 * A gateway that answers from a fixed board and records what was asked of it.
 *
 * It is a fake, not a mock: the controller's decisions are asserted through the payload it produced
 * and the text it printed, never through "was this called".
 */
export class RecordingLearningGateway implements ILearningGateway {
  readonly listed: Array<ProposalState | undefined> = [];
  readonly acted: ActCall[] = [];
  readonly ran: boolean[] = [];
  readonly patched: string[] = [];

  constructor(
    private readonly board: readonly ProposalView[] = [proposal('p1')],
    private readonly result: ProposalView = proposal('p1', { state: 'accepted' }),
    private readonly manifest: RunManifest = runManifest(),
    private readonly statusView: LearningStatus = learningStatus(),
    private readonly configView: LearningConfig = learningConfig(),
    private readonly patchView: LearningPatchResponse = patchResponse(),
  ) {}

  status(): Promise<LearningStatus> {
    return Promise.resolve(this.statusView);
  }

  proposals(state?: ProposalState): Promise<readonly ProposalView[]> {
    this.listed.push(state);
    return Promise.resolve(state === undefined ? this.board : this.board.filter(item => item.state === state));
  }

  act(id: string, request: LearningActionRequest): Promise<ProposalView> {
    this.acted.push({ id, request });
    return Promise.resolve(this.result);
  }

  run(spawn: boolean): Promise<RunManifest> {
    this.ran.push(spawn);
    return Promise.resolve(this.manifest);
  }

  config(): Promise<LearningConfig> {
    return Promise.resolve(this.configView);
  }

  patch(id: string): Promise<LearningPatchResponse> {
    this.patched.push(id);
    return Promise.resolve(this.patchView);
  }
}
