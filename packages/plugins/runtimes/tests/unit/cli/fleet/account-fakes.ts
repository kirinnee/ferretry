import type { VerbInvocation } from '@ferretry/kernel/manifest';
import type {
  AccountChange,
  AccountChangeOutcome,
  AccountChangeView,
  ComponentCatalog,
  ComponentView,
  LayeredProfileCatalog,
  LayeredProfileView,
  MachineAuthority,
  MachineView,
  Recommendation,
  RecommendationRequest,
  RuntimeCatalog,
  RuntimeView,
  SetupScan,
  StackView,
} from '../../../../contract/index.ts';
import type { AccountCommandDeps, IRuntimesGateway } from '../../../../cli/lib/fleet/account-ports.ts';
import { VERB_BODIES } from '../../../../cli/lib/verbs.ts';

/** One call the fake gateway saw. */
interface GatewayCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export const CHANGE_ID = 'fy_fprop_AAAAAAAAAAAAAAAAAAAAAA';
const AT = '2026-10-13T00:00:00.000Z';
export const LATER = '2026-10-13T00:10:00.000Z';

export const authorityOf = (overrides: Partial<MachineAuthority> = {}): MachineAuthority => ({
  mayApply: true,
  applyRefusal: 'granted',
  ...overrides,
});

export const machine = (overrides: Partial<MachineView> = {}): MachineView => ({
  name: 'studio',
  format: 'present',
  setUp: true,
  agentPermissions: 'auto',
  defaultRuntime: 'claude-default',
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
  browserMode: 'headless',
  browserProxy: null,
  browserPorts: 'random',
  browserFirewallFailure: 'warn',
  autoResume: true,
  agendaMode: false,
  publicUsageFeed: false,
  lastAutoResume: null,
  tools: [
    { harness: 'claude-code', label: 'Claude Code', installed: true, command: '/usr/bin/claude' },
    { harness: 'codex', label: 'Codex', installed: false },
  ],
  runtimeCount: 2,
  runningSessions: 1,
  authority: authorityOf(),
  ...overrides,
});

export const changeView = (change: AccountChange, overrides: Partial<AccountChangeView> = {}): AccountChangeView =>
  ({
    id: CHANGE_ID,
    revision: 'r1',
    change,
    summary: 'Add runtime claude-work',
    consequences: ['claude-work uses claude-you'],
    expiresAt: LATER,
    state: 'pending',
    preview: {
      kind: 'apply',
      operations: [{ kind: 'directory', path: '/fy/fleet/homes/x' }],
      documents: [{ path: 'config.yaml', bytes: 120 }],
      runtimes: [{ name: 'claude-work', harness: 'claude-code', agent: true, launch: { available: true } }],
    },
    ...overrides,
  }) as AccountChangeView;

export const committed = (): AccountChangeOutcome =>
  ({
    outcome: 'applied',
    apply: {
      outcome: 'committed',
      result: { accountCount: 1, operationCount: 3, manifestPath: '/fy/m.json', prunedWrappers: [], sharedHistory: [] },
    },
  }) as AccountChangeOutcome;

export const stack = (overrides: Partial<StackView> = {}): StackView => ({
  harness: 'claude-code',
  available: { available: true },
  applied: ['instructions/main'],
  skipped: [],
  conflicts: [],
  partial: [],
  ...overrides,
});

export const runtime = (overrides: Partial<RuntimeView> = {}): RuntimeView => ({
  id: 'claude-default',
  name: 'claude-default',
  wrapper: 'claude-default',
  harness: 'claude-code',
  credential: { id: 'claude-you', store: 'host', status: 'needs_sign_in' },
  profile: 'default',
  agent: false,
  stack: stack(),
  modelSet: { source: 'harness-default' },
  launch: { available: true },
  sameAs: [],
  ...overrides,
});

export const profile = (overrides: Partial<LayeredProfileView> = {}): LayeredProfileView => ({
  name: 'default',
  layers: ['instructions/main'],
  usedBy: ['claude-default'],
  baseFor: [],
  wouldIncludeItself: [],
  scope: { kind: 'scoped', scope: 'generic' },
  harnesses: [stack()],
  remove: { available: true },
  ...overrides,
});

export const component = (overrides: Partial<ComponentView> = {}): ComponentView => ({
  reference: 'instructions/main',
  kind: 'instructions',
  name: 'main',
  scope: 'generic',
  detail: { kind: 'instructions', file: 'components/instructions/main.md' },
  partial: [],
  warnings: [],
  usedBy: { profiles: ['default'], runtimes: ['claude-default'] },
  editNote: 'Editing this changes 1 profile.',
  remove: { available: true },
  ...overrides,
});

/** A model set as the catalogue reports it. */
export const modelSet = (overrides: Partial<ComponentView> = {}): ComponentView =>
  component({
    reference: 'modelSets/heavy',
    kind: 'modelSets',
    name: 'heavy',
    detail: { kind: 'modelSets', models: ['opus', 'sonnet'], default: 'opus' },
    usedBy: { profiles: ['default'], runtimes: ['claude-default'] },
    editNote: 'Editing this changes 1 profile and 1 runtime.',
    ...overrides,
  });

export const scan = (overrides: Partial<SetupScan> = {}): SetupScan => ({
  machine: 'studio',
  format: 'none',
  tools: [
    { harness: 'claude-code', label: 'Claude Code', installed: true },
    {
      harness: 'codex',
      label: 'Codex',
      installed: false,
      install: { kind: 'runnable', command: 'npm i -g @openai/codex' },
    },
  ],
  harnesses: [
    {
      harness: 'claude-code',
      installed: true,
      account: { state: 'signed-in', email: 'you@example.com' },
      mcpServers: [],
      skills: [],
      secretKeys: [],
      missingCommands: [],
      problems: [],
    },
    {
      harness: 'codex',
      installed: false,
      account: { state: 'not-signed-in' },
      mcpServers: [],
      skills: [],
      secretKeys: [],
      missingCommands: [],
      problems: [],
    },
  ],
  runtimes: [{ harness: 'claude-code', name: 'claude-default', profile: 'default' }],
  updates: [],
  duplicates: [],
  notes: [],
  importing: { available: true },
  ...overrides,
});

export const ACCOUNT_ID = 'claude-you';

export function recommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    task: 'port the remaining CLI command groups',
    classification: 'implementation',
    reasoning: 'a long, many-checkpoint port benefits from a high-context implementer',
    roles: [
      {
        role: 'implementer',
        why: 'the work is mostly writing modules with tests',
        primary: {
          agent: 'codex',
          accountId: ACCOUNT_ID,
          model: 'gpt-5.6',
          tradeoff: 'expensive, but holds the whole unit',
          score: 0.91,
        },
        alternatives: [
          {
            agent: 'claude-code',
            accountId: ACCOUNT_ID,
            model: 'opus',
            tradeoff: 'cheaper, shorter context',
            score: 0.7,
          },
        ],
      },
    ],
    exclusions: [],
    warnings: [],
    ...overrides,
  };
}

/** Answers for every gateway call, each overridable per test; every call is recorded. */
export interface FakeAnswers {
  machine: () => MachineView;
  components: () => ComponentCatalog;
  profiles: () => LayeredProfileCatalog;
  runtimes: () => RuntimeCatalog;
  stage: (change: AccountChange) => AccountChangeView;
  apply: () => AccountChangeOutcome;
  scan: () => SetupScan;
  recommend: (request: RecommendationRequest) => Recommendation;
}

class FakeGateway implements IRuntimesGateway {
  readonly calls: GatewayCall[] = [];
  readonly answers: FakeAnswers;

  constructor(overrides: Partial<FakeAnswers> = {}) {
    this.answers = {
      machine: () => machine(),
      components: () => ({ format: 'present', kinds: [] }),
      profiles: () => ({ format: 'present', profiles: [] }),
      runtimes: () => ({ format: 'present', runtimes: [] }),
      stage: change => changeView(change),
      apply: () => committed(),
      scan: () => scan(),
      recommend: () => recommendation(),
      ...overrides,
    };
  }

  #record<T>(method: string, args: unknown[], answer: () => T): Promise<T> {
    this.calls.push({ method, args });
    try {
      return Promise.resolve(answer());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  called(method: string): GatewayCall[] {
    return this.calls.filter(call => call.method === method);
  }

  machine() {
    return this.#record('machine', [], this.answers.machine);
  }
  components() {
    return this.#record('components', [], this.answers.components);
  }
  profiles() {
    return this.#record('profiles', [], this.answers.profiles);
  }
  runtimes() {
    return this.#record('runtimes', [], this.answers.runtimes);
  }
  stage(change: AccountChange) {
    return this.#record('stage', [change], () => this.answers.stage(change));
  }
  apply(id: string) {
    return this.#record('apply', [id], this.answers.apply);
  }
  scan() {
    return this.#record('scan', [], this.answers.scan);
  }
  recommend(request: RecommendationRequest) {
    return this.#record('recommend', [request], () => this.answers.recommend(request));
  }
}

/** What the commands printed, by channel, and the exit code they set. */
class FakeOutput {
  readonly lines: { channel: 'success' | 'report' | 'warn' | 'error'; text: string }[] = [];
  exitCode: number | undefined;

  success(text: string): void {
    this.lines.push({ channel: 'success', text });
  }
  report(text: string): void {
    this.lines.push({ channel: 'report', text });
  }
  warn(text: string): void {
    this.lines.push({ channel: 'warn', text });
  }
  error(text: string): void {
    this.lines.push({ channel: 'error', text });
  }
  setExitCode(code: number): void {
    this.exitCode = code;
  }

  text(channel?: 'success' | 'report' | 'warn' | 'error'): string {
    return this.lines
      .filter(line => channel === undefined || line.channel === channel)
      .map(line => line.text)
      .join('\n');
  }
}

/** Scripted answers, in order; every question is recorded. */
class FakePrompt {
  readonly questions: string[] = [];

  constructor(private readonly answers: string[] = []) {}

  async ask(message: string): Promise<string> {
    this.questions.push(message);
    return this.answers.shift() ?? '';
  }
}

export interface FakeWorld {
  readonly deps: AccountCommandDeps;
  readonly gateway: FakeGateway;
  readonly out: FakeOutput;
  readonly prompt: FakePrompt;
}

/** A whole set of collaborators, every one a recording fake. `interactive: false` leaves nobody to ask. */
export function fakeWorld(
  options: { gateway?: Partial<FakeAnswers>; answers?: string[]; interactive?: boolean; now?: () => number } = {},
): FakeWorld {
  const gateway = new FakeGateway(options.gateway);
  const out = new FakeOutput();
  const prompt = new FakePrompt(options.answers);
  const deps: AccountCommandDeps = {
    gateway,
    out,
    ...(options.interactive === false ? {} : { prompt }),
    binaryName: 'fz',
    now: options.now ?? (() => Date.parse(AT)),
  };
  return { deps, gateway, out, prompt };
}

type Verb = keyof typeof VERB_BODIES;

/** Run one verb the way the shell calls it: positionals first, then the parsed options. */
export async function runVerb(
  world: FakeWorld,
  verb: Verb,
  args: readonly string[] = [],
  options: VerbInvocation['options'] = {},
): Promise<void> {
  await VERB_BODIES[verb](world.deps, { args, options });
}
