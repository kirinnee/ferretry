import type { Instant } from '@ferretry/std';
import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import {
  DEFAULT_PACK_CONFIG,
  type FerretResult,
  type PackAttempt,
  type PackCleanUpJobResult,
  type PackCleanUpStart,
  type PackCleanUpSuggestion,
  type PackInventory,
  type PackModelOption,
  type PackNewOutcome,
  type PackRecommendation,
  type PackRoutingWriteResult,
  type PackTable,
  type PackView,
} from '../../../contract/index.ts';
import type { IPackIo } from '../../../cli/lib/controller.ts';
import type { IPackGateway } from '../../../cli/lib/gateway.ts';

/** A literal instant, branded the way the contract's schemas brand one. */
export const at = (iso: string): Instant => iso as Instant;

export const PROMPT = 'Plan and review on claude-opus-5-5 at max; chores on claude-haiku-5-5 low.';

export const option = (overrides: Partial<PackModelOption> = {}): PackModelOption => ({
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  modelLabel: 'Haiku 5.5',
  harness: 'claude-code',
  tier: 'fast',
  efforts: ['low'],
  runtime: 'claude-work',
  runtimes: 1,
  ready: true,
  quota: { state: 'plenty', windows: [], summary: '5h 2% · week 46%' },
  named: 2,
  effort: 'low',
  command: 'fy new --runtime claude-work --model claude-haiku-5-5 --effort low "<brief>"',
  ...overrides,
});

export const recommendation = (overrides: Partial<PackRecommendation> = {}): PackRecommendation => ({
  routing: { text: PROMPT, source: 'file' },
  available: [option()],
  next: 'fy new --runtime claude-work --model claude-haiku-5-5 --effort low "<brief>"',
  ...overrides,
});

export const packView = (overrides: Partial<PackView> = {}): PackView => ({
  config: DEFAULT_PACK_CONFIG,
  routing: { text: PROMPT, source: 'file' },
  models: [],
  available: [option()],
  cleanUp: { available: true, runtimes: ['claude-work'] },
  ...overrides,
});

export const startedFerret = (overrides: { name?: string; runtime?: string } = {}): FerretSummary =>
  ({
    id: 'child-1',
    name: overrides.name ?? 'child-1',
    role: 'helper',
    harness: 'claude-code',
    runner: 'tmux',
    runtime: overrides.runtime ?? 'claude-work',
    folder: '/work',
    state: 'working',
    createdAt: at('2026-10-22T12:00:00.000Z'),
    stateAt: at('2026-10-22T12:00:00.000Z'),
  }) as unknown as FerretSummary;

export const started = (overrides: Partial<Extract<PackNewOutcome, { outcome: 'started' }>> = {}): PackNewOutcome => ({
  outcome: 'started',
  ferret: startedFerret(),
  decidedBy: 'agent',
  attempts: [],
  ...overrides,
});

export const refused = (overrides: Partial<Extract<PackNewOutcome, { outcome: 'refused' }>> = {}): PackNewOutcome => ({
  outcome: 'refused',
  refusal: { code: 'limit_reached', message: 'you have 4 running helpers' },
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
  readonly reported: string[] = [];
  exitCode: number | undefined;

  constructor(private readonly terminal = false) {}

  success(message: string): void {
    this.out.push(message);
  }

  report(message: string): void {
    this.reported.push(message);
  }

  interactive(): boolean {
    return this.terminal;
  }

  error(message: string): void {
    this.err.push(message);
  }

  setExitCode(code: number): void {
    this.exitCode = code;
  }
}

export const INVENTORY: PackInventory = {
  at: at('2026-10-22T12:00:00.000Z'),
  models: [
    {
      provider: 'anthropic',
      harness: 'claude-code',
      id: 'claude-opus-5-5',
      label: 'Claude Opus 5.5',
      tier: 'best',
      context: 200000,
      efforts: ['max'],
      runtimes: [{ name: 'claude-work', ready: true }],
    },
    {
      provider: 'openai',
      harness: 'codex',
      id: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      tier: 'best',
      efforts: [],
      runtimes: [{ name: 'codex-off', ready: false }],
    },
    {
      provider: 'zai',
      harness: 'claude-code',
      id: 'glm-5',
      label: 'GLM 5',
      tier: 'fast',
      efforts: [],
      runtimes: [],
    },
  ],
  runtimes: [
    {
      name: 'claude-work',
      harness: 'claude-code',
      provider: 'anthropic',
      login: 'claude-work',
      ready: true,
      quota: { state: 'plenty', windows: [], summary: '5h 2% · wk 46%' },
      models: ['claude-opus-5-5', 'claude-haiku-5-5'],
    },
    {
      name: 'codex-off',
      harness: 'codex',
      login: 'codex-off',
      ready: false,
      refusal: { code: 'not_logged_in', message: 'codex-off needs signing in.' },
      quota: { state: 'unknown', windows: [], summary: 'not measured' },
      models: [],
    },
  ],
  routing: { text: PROMPT, source: 'default' },
};

export const SUGGESTION: PackCleanUpSuggestion = {
  suggested: { by: 'claude-opus-5-5', via: 'claude-work', at: at('2026-10-22T12:05:00.000Z') },
  before: 'Use opus for plans. Use glm for chores.',
  after: 'Use claude-opus-5-5 for plans. Use claude-haiku-5-5 for chores.',
  notes: [
    { kind: 'absent_model', message: 'glm-5 is not run by any runtime here', model: 'glm-5' },
    { kind: 'suggestion', message: 'Add a Codex login for a second family.' },
  ],
};

export const JOB = {
  id: 'run-1',
  ferret: 's9',
  name: 'gonzalo',
  runtime: 'claude-work',
  startedAt: at('2026-10-22T12:00:00.000Z'),
  status: 'running',
} as const;

export class FakePackGateway implements IPackGateway {
  readonly recommendCalls: Array<Parameters<IPackGateway['recommend']>[0]> = [];
  readonly newCalls: Array<Parameters<IPackGateway['newChild']>[0]> = [];
  readonly cleanUpCalls: Array<Parameters<IPackGateway['cleanUp']>[0]> = [];
  readonly acceptCalls: Array<Parameters<IPackGateway['accept']>[0]> = [];
  readonly jobCalls: string[] = [];
  undoCalls = 0;
  /** What `cleanUp` answers. */
  started: PackCleanUpStart = { outcome: 'started', job: JOB };
  /** What each look at a run answers, in turn; the last repeats. */
  runs: PackCleanUpJobResult[] = [{ job: { ...JOB, status: 'suggested' }, suggestion: SUGGESTION }];
  written: PackRoutingWriteResult = { outcome: 'applied', message: 'Accepted.' };

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

  async cleanUp(request: Parameters<IPackGateway['cleanUp']>[0]): Promise<PackCleanUpStart> {
    this.cleanUpCalls.push(request);
    return this.started;
  }

  async job(id: string): Promise<PackCleanUpJobResult> {
    this.jobCalls.push(id);
    return (this.runs.length > 1 ? this.runs.shift() : this.runs[0]) as PackCleanUpJobResult;
  }

  async accept(request: Parameters<IPackGateway['accept']>[0]): Promise<PackRoutingWriteResult> {
    this.acceptCalls.push(request);
    return this.written;
  }

  async undo(): Promise<PackRoutingWriteResult> {
    this.undoCalls += 1;
    return { outcome: 'nothing', message: 'There is no accepted clean-up to undo.' };
  }

  async result(): Promise<FerretResult> {
    throw new Error('not used by the Pack controller');
  }

  async table(): Promise<PackTable> {
    throw new Error('not used by the Pack controller');
  }

  async stop(): Promise<void> {}
}
