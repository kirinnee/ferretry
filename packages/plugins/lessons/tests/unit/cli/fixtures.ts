import { GLOBAL_LESSONS_DOCUMENT } from '../../../contract/index.ts';
import type {
  AgentLessonToolResult,
  EvidenceView,
  LessonsActionRequest,
  LessonsApplyPreview,
  LessonsConfig,
  LessonsGlobalDocument,
  LessonsPatchResponse,
  LessonsScanEstimate,
  LessonsScanProgress,
  LessonsScanRequest,
  LessonsStatus,
  ProposalState,
  ProposalView,
  RunManifest,
} from '../../../contract/index.ts';
import type { ILessonsGateway, ILessonsOutput } from '../../../cli/lib/ports.ts';

/** Captures what a controller printed, so tests read the rendering rather than a mock call. */
export class CapturingOutput implements ILessonsOutput {
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
    ferretId: 'ms8kkfyd-95b7037e',
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
    source: 'passive',
    count: 3,
    evidence: [evidence()],
    ...overrides,
  };
}

export function runManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: 'run-7',
    startedAt: '2026-07-31T09:00:00.000Z',
    finishedAt: '2026-07-31T09:04:00.000Z',
    ferretsScanned: 12,
    ferretsWithSignal: 4,
    minerFerrets: ['miner-1'],
    observationsProposed: 9,
    observationsVerified: 7,
    rejectedQuotes: 2,
    malformedFiles: 0,
    proposalsCreated: 2,
    proposalsStrengthened: 1,
    proposalsSuppressedByTombstone: 0,
    perHarness: { 'claude-code': 3, codex: 1 },
    ...overrides,
  };
}

export function learningStatus(overrides: Partial<LessonsStatus> = {}): LessonsStatus {
  return {
    enabled: true,
    intervalMinutes: 60,
    watermarkAt: '2026-07-31T08:00:00.000Z',
    lastRunAt: '2026-07-31T09:04:00.000Z',
    pending: { total: 3, strong: 1, weak: 2 },
    totals: { observations: 40, proposals: 6, tombstones: 1 },
    running: false,
    passiveDefault: true,
    ...overrides,
  };
}

export function learningConfig(overrides: Partial<LessonsConfig> = {}): LessonsConfig {
  return {
    enabled: true,
    agent: 'miner',
    intervalMinutes: 60,
    batchSize: 20,
    maxMinersPerRun: 2,
    maxFerretsPerRun: 30,
    minSpawnGapMinutes: 15,
    passiveDefault: true,
    ...overrides,
  };
}

export function patchResponse(overrides: Partial<LessonsPatchResponse> = {}): LessonsPatchResponse {
  return { path: 'guidance.md', contents: '- install from the package directory\n', ...overrides };
}

export function applyPreview(overrides: Partial<LessonsApplyPreview> = {}): LessonsApplyPreview {
  return {
    proposalId: 'p1',
    category: 'global',
    path: 'guidance.md',
    exists: true,
    etag: 'etag-1',
    diff: '+ install from the package directory',
    capability: 'fleet',
    notes: [],
    ...overrides,
  };
}

export function scanEstimate(overrides: Partial<LessonsScanEstimate> = {}): LessonsScanEstimate {
  return {
    ferrets: 4,
    ferretIds: ['s1', 's2', 's3', 's4'],
    skipped: 1,
    tokens: 12_000,
    usd: 0.42,
    beyondLimit: 0,
    miners: 1,
    agent: 'miner',
    ...overrides,
  };
}

export function scanProgress(overrides: Partial<LessonsScanProgress> = {}): LessonsScanProgress {
  return {
    runId: 'scan-1',
    state: 'running',
    total: 4,
    done: 0,
    startedAt: '2026-07-31T09:00:00.000Z',
    added: 0,
    merged: 0,
    ...overrides,
  };
}

/** What one gateway call recorded. */
export interface ActCall {
  readonly id: string;
  readonly request: LessonsActionRequest;
}

/**
 * A gateway that answers from a fixed board and records what was asked of it.
 *
 * It is a fake, not a mock: the controller's decisions are asserted through the payload it produced
 * and the text it printed, never through "was this called".
 */
/** What one `apply` recorded. */
export interface ApplyCall {
  readonly id: string;
  readonly etag: string;
}

export class RecordingLessonsGateway implements ILessonsGateway {
  readonly listed: Array<ProposalState | undefined> = [];
  readonly acted: ActCall[] = [];
  readonly ran: boolean[] = [];
  readonly patched: string[] = [];
  readonly previewed: string[] = [];
  readonly applied: ApplyCall[] = [];
  readonly estimated: LessonsScanRequest[] = [];
  readonly scanned: LessonsScanRequest[] = [];
  readonly suggested: Array<{ readonly rule: string; readonly scope: string }> = [];
  suggestion: AgentLessonToolResult = { summary: 'filed as a new lesson', outcome: 'filed' };

  constructor(
    private readonly board: readonly ProposalView[] = [proposal('p1')],
    private readonly result: ProposalView = proposal('p1', { state: 'accepted' }),
    private readonly manifest: RunManifest = runManifest(),
    private readonly statusView: LessonsStatus = learningStatus(),
    private readonly configView: LessonsConfig = learningConfig(),
    private readonly patchView: LessonsPatchResponse = patchResponse(),
    private readonly previewView: LessonsApplyPreview = applyPreview(),
    private readonly appliedView: ProposalView = proposal('p1', { state: 'applied' }),
    private readonly estimateView: LessonsScanEstimate = scanEstimate(),
    private readonly scanView: LessonsScanProgress = scanProgress(),
  ) {}

  suggest(rule: string, scope: string): Promise<AgentLessonToolResult> {
    this.suggested.push({ rule, scope });
    return Promise.resolve(this.suggestion);
  }

  status(): Promise<LessonsStatus> {
    return Promise.resolve(this.statusView);
  }

  proposals(state?: ProposalState): Promise<readonly ProposalView[]> {
    this.listed.push(state);
    return Promise.resolve(state === undefined ? this.board : this.board.filter(item => item.state === state));
  }

  act(id: string, request: LessonsActionRequest): Promise<ProposalView> {
    this.acted.push({ id, request });
    return Promise.resolve(this.result);
  }

  run(spawn: boolean): Promise<RunManifest> {
    this.ran.push(spawn);
    return Promise.resolve(this.manifest);
  }

  config(): Promise<LessonsConfig> {
    return Promise.resolve(this.configView);
  }

  patch(id: string): Promise<LessonsPatchResponse> {
    this.patched.push(id);
    return Promise.resolve(this.patchView);
  }

  applyPreview(id: string): Promise<LessonsApplyPreview> {
    this.previewed.push(id);
    return Promise.resolve(this.previewView);
  }

  apply(id: string, etag: string): Promise<ProposalView> {
    this.applied.push({ id, etag });
    return Promise.resolve(this.appliedView);
  }

  scanEstimate(request: LessonsScanRequest): Promise<LessonsScanEstimate> {
    this.estimated.push(request);
    return Promise.resolve(this.estimateView);
  }

  scan(request: LessonsScanRequest): Promise<LessonsScanProgress> {
    this.scanned.push(request);
    return Promise.resolve(this.scanView);
  }

  /** The Global document this fake holds; `writeGlobalDocument` replaces it when the etag matches. */
  globalView: LessonsGlobalDocument = {
    name: GLOBAL_LESSONS_DOCUMENT,
    text: '## Lessons\n\n- Use bun, not Python.\n- Run commands through direnv exec.\n',
    etag: 'etag-1',
    notes: [],
  };
  readonly globalWrites: Array<{ readonly text: string; readonly etag: string }> = [];

  globalDocument(): Promise<LessonsGlobalDocument> {
    return Promise.resolve(this.globalView);
  }

  writeGlobalDocument(text: string, etag: string): Promise<LessonsGlobalDocument> {
    this.globalWrites.push({ text, etag });
    if (etag !== this.globalView.etag) return Promise.reject(new Error('the Global lessons document changed'));
    this.globalView = { ...this.globalView, text, etag: `etag-${String(this.globalWrites.length + 1)}` };
    return Promise.resolve(this.globalView);
  }
}
