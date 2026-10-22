import {
  DEFAULT_PACK_CONFIG,
  type PackAttempt,
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

export class FakePackGateway implements IPackGateway {
  readonly recommendCalls: Array<Parameters<IPackGateway['recommend']>[0]> = [];
  readonly newCalls: Array<Parameters<IPackGateway['newChild']>[0]> = [];

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

  async result(): Promise<never> {
    throw new Error('not used by the Pack controller');
  }

  async stop(): Promise<void> {}
}
