import {
  DEFAULT_PACK_CONFIG,
  type PackAttempt,
  type PackGuideJobResult,
  type PackGuideSuggestion,
  type PackGuideSuggestStart,
  type PackGuideWriteResult,
  type PackInventory,
  type PackNewOutcome,
  type PackRecommendation,
  type PackView,
  type SessionView,
} from '@ferretry/protocol';
import type { IPackIo } from '../../../src/lib/pack/controller.ts';
import type { IPackGateway } from '../../../src/lib/pack/gateway.ts';

export const recommendation = (overrides: Partial<PackRecommendation> = {}): PackRecommendation => ({
  task: 'rename a helper',
  useCase: { id: 'bulk', title: 'Bulk edits', matchedBy: 'words' },
  guideSource: 'derived',
  candidates: [
    {
      rank: 1,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      modelLabel: 'Haiku 4.5',
      effort: 'low',
      why: 'cheap and quick',
      runtime: 'claude-work',
      ready: true,
    },
  ],
  next: 'fy new --runtime claude-work --model claude-haiku-4-5 "<brief>"',
  ...overrides,
});

export const packView = (overrides: Partial<PackView['guide']> = {}): PackView => ({
  config: DEFAULT_PACK_CONFIG,
  guide: {
    source: 'file',
    useCases: [
      {
        id: 'plan-review',
        title: 'Hard planning and review',
        description: 'Designing and reviewing.',
        candidates: [
          { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'max', why: 'The strongest planner.' },
          { provider: 'openai', model: 'gpt-6-astra', harness: 'codex', why: 'A second family.' },
        ],
      },
    ],
    routing: {
      prompt: 'Plan and review on Opus; take Astra when Opus is low.',
      short: 'Routing: plan-review → claude-opus-5-5 max.',
      source: 'file',
    },
    ...overrides,
  },
  models: [],
});

export const startedView = (overrides: { teammate?: string; model?: string } = {}): SessionView =>
  ({
    config: {
      id: 'child-1',
      agent: 'claude-work',
      ...(overrides.teammate === undefined ? {} : { teammate: overrides.teammate }),
      ...(overrides.model === undefined ? {} : { model: overrides.model }),
    },
    state: { status: 'running' },
    directory: '/state/child-1',
  }) as unknown as SessionView;

export const started = (overrides: Partial<Extract<PackNewOutcome, { outcome: 'started' }>> = {}): PackNewOutcome => ({
  outcome: 'started',
  view: startedView(),
  decidedBy: 'agent',
  attempts: [],
  ...overrides,
});

export const refused = (overrides: Partial<Extract<PackNewOutcome, { outcome: 'refused' }>> = {}): PackNewOutcome => ({
  outcome: 'refused',
  refusal: { code: 'limit_reached', message: 'you have 4 running sub-ferrets' },
  attempts: [],
  ...overrides,
});

export const attempt = (overrides: Partial<PackAttempt> = {}): PackAttempt => ({
  runtime: 'claude-work',
  outcome: 'started',
  ...overrides,
});

export class CapturingPackIo implements IPackIo {
  readonly out: string[] = [];
  readonly err: string[] = [];
  exitCode: number | undefined;

  success(message: string): void {
    this.out.push(message);
  }

  error(message: string): void {
    this.err.push(message);
  }

  setExitCode(code: number): void {
    this.exitCode = code;
  }
}

export const INVENTORY: PackInventory = {
  at: '2026-10-22T12:00:00.000Z',
  models: [
    {
      provider: 'anthropic',
      providerLabel: 'Anthropic',
      harness: 'claude',
      id: 'claude-opus-5-5',
      label: 'Claude Opus 5.5',
      tier: 'best',
      efforts: ['max'],
      description: 'Strongest; slow.',
      describedBy: 'owner',
      retires: '2027-06-01',
      runtimes: [{ name: 'claude-work', ready: true }],
      headroom: { runtimes: 1, ready: 1, summary: '1 runtime, 1 ready; most headroom on claude-work: 5h 2% · wk 46%' },
    },
    {
      provider: 'openai',
      providerLabel: 'OpenAI',
      harness: 'codex',
      id: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      tier: 'best',
      efforts: [],
      description: 'GPT-6 Astra: the strongest tier on OpenAI.',
      describedBy: 'catalog',
      runtimes: [],
      headroom: { runtimes: 0, ready: 0, summary: 'no runtime here runs it' },
    },
  ],
  runtimes: [
    {
      name: 'claude-work',
      harness: 'claude',
      provider: 'anthropic',
      login: 'claude-work',
      ready: true,
      quota: { state: 'plenty', windows: [], summary: '5h 2% · wk 46%' },
    },
    {
      name: 'codex-off',
      harness: 'codex',
      login: 'codex-off',
      ready: false,
      refusal: { code: 'not_logged_in', message: 'codex-off needs signing in.' },
      quota: { state: 'unknown', windows: [], summary: 'not measured' },
    },
  ],
  guide: { source: 'derived', useCases: [] },
  preferences: 'Opus for reviews.\nGLM for bulk.',
};

const PLAN = packView().guide.useCases[0] as PackView['guide']['useCases'][number];

export const SUGGESTION: PackGuideSuggestion = {
  suggested: { by: 'claude-opus-5-5', via: 'claude-work', at: '2026-10-22T12:05:00.000Z' },
  routing: { prompt: 'Plan on Opus.\nBulk on GLM.', short: 'Routing: plan-review → opus max.' },
  useCases: [
    { ...PLAN, title: 'Planning and review' },
    {
      id: 'bulk',
      title: 'Bulk edits',
      description: 'Renames.',
      candidates: [{ provider: 'zai', model: 'glm-5', why: 'Cheap: claude-work is at 46% of the week.' }],
    },
  ],
  dropped: [{ useCase: 'bulk', provider: 'x', model: 'ghost', message: 'x ghost is not in any catalog' }],
  flagged: [{ message: 'its routing guidance did not check, so it was rendered from the use cases' }],
  current: packView().guide,
};

export const JOB = {
  id: 'run-1',
  session: 's9',
  name: 'gonzalo',
  runtime: 'claude-work',
  startedAt: '2026-10-22T12:00:00.000Z',
  status: 'running',
} as const;

export class FakePackGateway implements IPackGateway {
  readonly recommendCalls: Array<Parameters<IPackGateway['recommend']>[0]> = [];
  readonly newCalls: Array<Parameters<IPackGateway['newChild']>[0]> = [];
  readonly suggestCalls: Array<Parameters<IPackGateway['suggest']>[0]> = [];
  readonly acceptCalls: Array<Parameters<IPackGateway['accept']>[0]> = [];
  readonly describeCalls: Array<Parameters<IPackGateway['describe']>[0]> = [];
  readonly jobCalls: string[] = [];
  /** What `suggest` answers. */
  started: PackGuideSuggestStart = { outcome: 'started', job: JOB };
  /** What each look at a run answers, in turn; the last repeats. */
  runs: PackGuideJobResult[] = [{ job: { ...JOB, status: 'suggested' }, suggestion: SUGGESTION }];
  written: PackGuideWriteResult = { outcome: 'applied', message: 'Accepted.' };

  constructor(
    private readonly recommended: PackRecommendation = recommendation(),
    private readonly outcome: PackNewOutcome = started(),
    private readonly viewed: PackView = packView(),
  ) {}

  async view(): Promise<PackView> {
    return this.viewed;
  }

  async recommend(request: Parameters<IPackGateway['recommend']>[0]): Promise<PackRecommendation> {
    this.recommendCalls.push(request);
    return this.recommended;
  }

  async newChild(request: Parameters<IPackGateway['newChild']>[0]): Promise<PackNewOutcome> {
    this.newCalls.push(request);
    return this.outcome;
  }

  async inventory(): Promise<PackInventory> {
    return INVENTORY;
  }

  async suggest(request: Parameters<IPackGateway['suggest']>[0]): Promise<PackGuideSuggestStart> {
    this.suggestCalls.push(request);
    return this.started;
  }

  async job(id: string): Promise<PackGuideJobResult> {
    this.jobCalls.push(id);
    return (this.runs.length > 1 ? this.runs.shift() : this.runs[0]) as PackGuideJobResult;
  }

  async accept(request: Parameters<IPackGateway['accept']>[0]): Promise<PackGuideWriteResult> {
    this.acceptCalls.push(request);
    return this.written;
  }

  async undo(): Promise<PackGuideWriteResult> {
    return { outcome: 'nothing', message: 'There is no accepted suggestion to undo.' };
  }

  async describe(request: Parameters<IPackGateway['describe']>[0]): Promise<PackGuideWriteResult> {
    this.describeCalls.push(request);
    return { outcome: 'applied', message: 'Saved.' };
  }

  async result(): Promise<never> {
    throw new Error('not used by the Pack controller');
  }

  async stop(): Promise<void> {}
}
