import type {
  FleetAccountChange,
  FleetAccountChangeOutcome,
  FleetAccountChangeView,
  FleetCloneBundle,
  FleetComponentCatalog,
  FleetComponentView,
  FleetCredentialList,
  FleetCredentialView,
  FleetLayeredProfileCatalog,
  FleetLayeredProfileView,
  FleetMachineAuthority,
  FleetMachineView,
  FleetRuntimeCatalog,
  FleetRuntimeView,
  FleetSetupScan,
  FleetStackView,
  FleetToolInstallResult,
  HarnessLoginFlow,
  HarnessLoginSubmission,
} from '@ferretry/protocol';
import { Command } from 'commander';
import type {
  AccountAuthority,
  AccountCommandDeps,
  AccountHarness,
  IAccountGateway,
} from '../../../src/lib/fleet/account-ports.ts';

/** One call the fake gateway saw. */
interface GatewayCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export const CHANGE_ID = 'fy_fprop_AAAAAAAAAAAAAAAAAAAAAA';
const AT = '2026-10-13T00:00:00.000Z';
export const LATER = '2026-10-13T00:10:00.000Z';

export const authorityOf = (overrides: Partial<FleetMachineAuthority> = {}): FleetMachineAuthority => ({
  mayApply: true,
  applyRefusal: 'ungated',
  confirmation: 'none',
  ...overrides,
});

export const machine = (overrides: Partial<FleetMachineView> = {}): FleetMachineView => ({
  name: 'studio',
  format: 'version-2',
  setUp: true,
  agentPermissions: 'auto',
  tools: [
    { harness: 'claude', label: 'Claude Code', installed: true, command: '/usr/bin/claude' },
    { harness: 'codex', label: 'Codex', installed: false },
  ],
  runtimeCount: 2,
  runningSessions: 1,
  authority: authorityOf(),
  ...overrides,
});

export const changeView = (
  change: FleetAccountChange,
  overrides: Partial<FleetAccountChangeView> = {},
): FleetAccountChangeView => ({
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
    runtimes: [{ name: 'claude-work', harness: 'claude', agent: true, launch: { available: true } }],
  },
  ...overrides,
});

export const committed = (): FleetAccountChangeOutcome => ({
  outcome: 'applied',
  apply: {
    outcome: 'committed',
    result: { accountCount: 1, operationCount: 3, manifestPath: '/fy/m.json', prunedWrappers: [], sharedHistory: [] },
  },
});

export const credential = (overrides: Partial<FleetCredentialView> = {}): FleetCredentialView => ({
  id: 'claude-you',
  harness: 'claude',
  store: 'host',
  email: 'you@example.com',
  needsLabel: false,
  sharedWithTerminal: true,
  status: {
    word: 'ready',
    label: 'Ready',
    reason: 'provider_accepted',
    explanation: 'The provider accepted this login.',
    lastCheckInconclusive: false,
  },
  usage: { fiveHour: { usedPercent: 12.4 }, weekly: {} },
  usedBy: ['claude-default'],
  signIn: { available: true },
  checkNow: { available: true },
  signOut: { available: true, sentence: 'Sign out?', runtimesAffected: 1, signsOutTerminal: true },
  ...overrides,
});

export const stack = (overrides: Partial<FleetStackView> = {}): FleetStackView => ({
  harness: 'claude',
  available: { available: true },
  applied: ['instructions/main'],
  skipped: [],
  conflicts: [],
  partial: [],
  ...overrides,
});

export const runtime = (overrides: Partial<FleetRuntimeView> = {}): FleetRuntimeView => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  name: 'claude-default',
  wrapper: 'claude-default',
  harness: 'claude',
  credential: { id: 'claude-you', store: 'host', status: 'needs_sign_in' },
  profile: 'default',
  agent: false,
  stack: stack(),
  modelSet: { source: 'harness-default' },
  launch: { available: true },
  sameAs: [],
  ...overrides,
});

export const profile = (overrides: Partial<FleetLayeredProfileView> = {}): FleetLayeredProfileView => ({
  name: 'default',
  layers: ['instructions/main'],
  usedBy: ['claude-default'],
  baseFor: [],
  wouldIncludeItself: [],
  harnesses: [stack()],
  remove: { available: true },
  ...overrides,
});

export const component = (overrides: Partial<FleetComponentView> = {}): FleetComponentView => ({
  reference: 'instructions/main',
  kind: 'instructions',
  name: 'main',
  detail: { kind: 'instructions', file: 'components/instructions/main.md' },
  partial: [],
  warnings: [],
  usedBy: { profiles: ['default'], runtimes: ['claude-default'] },
  editNote: 'Editing this changes 1 profile.',
  remove: { available: true },
  ...overrides,
});

export const scan = (overrides: Partial<FleetSetupScan> = {}): FleetSetupScan => ({
  machine: 'studio',
  format: 'none',
  tools: [
    { harness: 'claude', label: 'Claude Code', installed: true },
    {
      harness: 'codex',
      label: 'Codex',
      installed: false,
      install: { kind: 'runnable', command: 'npm i -g @openai/codex' },
    },
  ],
  harnesses: [
    {
      harness: 'claude',
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
  runtimes: [{ harness: 'claude', name: 'claude-default', profile: 'default' }],
  updates: [],
  duplicates: [],
  notes: [],
  importing: { available: true },
  ...overrides,
});

export const bundle = (): FleetCloneBundle => ({
  format: 'ferretry-clone',
  version: 1,
  machine: 'laptop',
  exportedAt: AT,
  credentials: [],
  components: {},
  profiles: {},
  runtimes: {},
  files: [],
  notCopied: [],
});

export const flow = (overrides: Record<string, unknown> = {}): HarnessLoginFlow =>
  ({
    harness: 'claude',
    flowId: 'flow-1',
    credentialId: 'claude-you',
    identity: 'claude:you',
    startedAt: AT,
    expiresAt: LATER,
    state: 'starting',
    ...overrides,
  }) as HarnessLoginFlow;

/** Answers for every gateway call, each overridable per test; every call is recorded. */
export interface FakeAnswers {
  machine: () => FleetMachineView;
  components: () => FleetComponentCatalog;
  profiles: () => FleetLayeredProfileCatalog;
  runtimes: () => FleetRuntimeCatalog;
  credentials: () => FleetCredentialList;
  unlock: () => string;
  check: () => FleetCredentialView;
  stage: (change: FleetAccountChange) => FleetAccountChangeView;
  apply: () => FleetAccountChangeOutcome;
  scan: () => FleetSetupScan;
  installTools: () => FleetToolInstallResult;
  exportBundle: () => FleetCloneBundle;
  startSignIn: () => HarnessLoginFlow;
  signInStatus: () => HarnessLoginFlow;
  submitSignInCode: () => HarnessLoginSubmission;
  cancelSignIn: () => HarnessLoginFlow;
}

class FakeGateway implements IAccountGateway {
  readonly calls: GatewayCall[] = [];
  readonly answers: FakeAnswers;

  constructor(overrides: Partial<FakeAnswers> = {}) {
    this.answers = {
      machine: () => machine(),
      components: () => ({ format: 'version-2', kinds: [] }),
      profiles: () => ({ format: 'version-2', profiles: [] }),
      runtimes: () => ({ format: 'version-2', runtimes: [] }),
      credentials: () => ({ format: 2, machine: 'studio', credentials: [] }),
      unlock: () => 'unlock-token',
      check: () => credential(),
      stage: change => changeView(change),
      apply: () => committed(),
      scan: () => scan(),
      installTools: () => ({ outcomes: [] }),
      exportBundle: () => bundle(),
      startSignIn: () => flow({ state: 'complete' }),
      signInStatus: () => flow({ state: 'complete' }),
      submitSignInCode: () => ({ outcome: 'accepted', flow: flow({ state: 'complete' }) }),
      cancelSignIn: () => flow({ state: 'failed', reason: 'cancelled', remedy: 'retry' }),
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
  credentials() {
    return this.#record('credentials', [], this.answers.credentials);
  }
  unlock(password: string) {
    return this.#record('unlock', [password], this.answers.unlock);
  }
  check(id: string, authority: AccountAuthority) {
    return this.#record('check', [id, authority], this.answers.check);
  }
  stage(change: FleetAccountChange, authority: AccountAuthority) {
    return this.#record('stage', [change, authority], () => this.answers.stage(change));
  }
  apply(id: string, authority: AccountAuthority) {
    return this.#record('apply', [id, authority], this.answers.apply);
  }
  scan(authority: AccountAuthority) {
    return this.#record('scan', [authority], this.answers.scan);
  }
  installTools(harnesses: readonly AccountHarness[], authority: AccountAuthority) {
    return this.#record('installTools', [harnesses, authority], this.answers.installTools);
  }
  exportBundle(authority: AccountAuthority) {
    return this.#record('exportBundle', [authority], this.answers.exportBundle);
  }
  startSignIn(id: string, authority: AccountAuthority) {
    return this.#record('startSignIn', [id, authority], this.answers.startSignIn);
  }
  signInStatus(id: string, authority: AccountAuthority) {
    return this.#record('signInStatus', [id, authority], this.answers.signInStatus);
  }
  submitSignInCode(id: string, code: string, authority: AccountAuthority) {
    return this.#record('submitSignInCode', [id, code, authority], this.answers.submitSignInCode);
  }
  cancelSignIn(id: string, authority: AccountAuthority) {
    return this.#record('cancelSignIn', [id, authority], this.answers.cancelSignIn);
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
  readonly secrets: string[] = [];

  constructor(
    private readonly answers: string[] = [],
    private readonly secret = 'operator-password-1',
  ) {}

  async ask(message: string): Promise<string> {
    this.questions.push(message);
    return this.answers.shift() ?? '';
  }

  async askSecret(message: string): Promise<string> {
    this.secrets.push(message);
    return this.secret;
  }
}

export interface FakeWorld {
  readonly deps: AccountCommandDeps;
  readonly gateway: FakeGateway;
  readonly out: FakeOutput;
  readonly prompt: FakePrompt;
  readonly files: Map<string, string>;
  readonly slept: number[];
}

/** A whole set of collaborators, every one a recording fake. */
export function fakeWorld(
  options: {
    gateway?: Partial<FakeAnswers>;
    answers?: string[];
    interactive?: boolean;
    stdinPassword?: string;
    files?: Record<string, string>;
    now?: () => number;
  } = {},
): FakeWorld {
  const gateway = new FakeGateway(options.gateway);
  const out = new FakeOutput();
  const prompt = new FakePrompt(options.answers);
  const files = new Map(Object.entries(options.files ?? {}));
  const slept: number[] = [];
  const deps: AccountCommandDeps = {
    gateway,
    out,
    prompt,
    interactive: options.interactive ?? true,
    binaryName: 'fz',
    readPasswordFromStdin: async () => {
      if (options.stdinPassword === undefined) throw new Error('no password on stdin');
      return options.stdinPassword;
    },
    readText: async path => {
      const text = files.get(path);
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    },
    sleep: async milliseconds => {
      slept.push(milliseconds);
    },
    now: options.now ?? (() => Date.parse(AT)),
  };
  return { deps, gateway, out, prompt, files, slept };
}

/** Run argv against a program with one register function mounted. */
export async function runCommand(
  register: (program: Command, deps: AccountCommandDeps) => void,
  world: FakeWorld,
  argv: readonly string[],
  prepare?: (program: Command) => void,
): Promise<void> {
  const program = new Command().name('fz').exitOverride();
  prepare?.(program);
  register(program, world.deps);
  await program.parseAsync(['node', 'fz', ...argv]);
}
