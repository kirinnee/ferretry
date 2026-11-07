import type {
  HarnessLoginFlow,
  HarnessLoginSubmission,
  LoginList,
  LoginTestResult,
  LoginView,
  ModelCatalogRefreshResult,
  ModelCatalogsView,
  ProviderPresetCatalog,
} from '../../../contract/index.ts';
import type { ILoginsGateway, LoginsCommandDeps } from '../../../cli/lib/ports.ts';

export const AT = '2026-11-01T10:00:00.000Z';
export const LATER = '2026-11-01T10:15:00.000Z';

/** A flow as the daemon serves it; the default is a Claude flow that has only just started. */
export const flow = (overrides: Record<string, unknown> = {}): HarnessLoginFlow =>
  ({
    harness: 'claude-code',
    flowId: 'flow-1',
    loginId: 'claude-you',
    identity: 'claude:you',
    startedAt: AT,
    expiresAt: LATER,
    state: 'starting',
    ...overrides,
  }) as unknown as HarnessLoginFlow;

/** One login row, ready unless overridden. */
export const login = (overrides: Record<string, unknown> = {}): LoginView =>
  ({
    id: 'claude-you',
    harness: 'claude-code',
    harnesses: ['claude-code'],
    store: 'ferretry',
    email: 'you@example.com',
    needsLabel: false,
    sharedWithTerminal: false,
    status: {
      word: 'ready',
      label: 'Ready',
      reason: 'access_current',
      explanation: 'Signed in and working.',
      lastCheckInconclusive: false,
    },
    usage: { fiveHour: { usedPercent: 12.4 }, weekly: {} },
    usedBy: ['main'],
    signIn: { available: true },
    checkNow: { available: true },
    signOut: { available: true, sentence: 'Sign out?', runtimesAffected: 1, signsOutTerminal: false },
    ...overrides,
  }) as unknown as LoginView;

export const loginList = (...logins: LoginView[]): LoginList => ({ format: 1, machine: 'box', logins });

/** Answers for every gateway call, each overridable per test; every call is recorded. */
export interface FakeAnswers {
  logins: () => LoginList;
  check: () => LoginView;
  test: () => LoginTestResult;
  presets: () => ProviderPresetCatalog;
  models: () => ModelCatalogsView;
  refreshModels: () => ModelCatalogRefreshResult;
  startSignIn: () => HarnessLoginFlow;
  signInStatus: () => HarnessLoginFlow;
  submitSignInCode: () => HarnessLoginSubmission;
  recheckSignIn: () => HarnessLoginSubmission;
  cancelSignIn: () => HarnessLoginFlow;
}

export interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

export class FakeGateway implements ILoginsGateway {
  readonly calls: Call[] = [];
  readonly #answers: Partial<FakeAnswers>;

  constructor(answers: Partial<FakeAnswers> = {}) {
    this.#answers = { recheckSignIn: () => ({ outcome: 'accepted', flow: flow({ state: 'complete' }) }), ...answers };
  }

  called(name: string): Call[] {
    return this.calls.filter(call => call.name === name);
  }

  #answer<K extends keyof FakeAnswers>(name: K, args: readonly unknown[]): ReturnType<FakeAnswers[K]> {
    this.calls.push({ name, args });
    const answer = this.#answers[name];
    if (answer === undefined) throw new Error(`no answer for ${name}`);
    return (answer as () => ReturnType<FakeAnswers[K]>)();
  }

  async logins() {
    return this.#answer('logins', []);
  }
  async check(id: string) {
    return this.#answer('check', [id]);
  }
  async test(id: string, allowInference: boolean) {
    return this.#answer('test', [id, allowInference]);
  }
  async presets() {
    return this.#answer('presets', []);
  }
  async models() {
    return this.#answer('models', []);
  }
  async refreshModels() {
    return this.#answer('refreshModels', []);
  }
  async startSignIn(id: string, method?: string, restart?: boolean) {
    return this.#answer('startSignIn', [id, restart === true ? 'restart' : method]);
  }
  async signInStatus(flowId: string) {
    return this.#answer('signInStatus', [flowId]);
  }
  async submitSignInCode(flowId: string, code: string) {
    return this.#answer('submitSignInCode', [flowId, code]);
  }
  async recheckSignIn(flowId: string) {
    return this.#answer('recheckSignIn', [flowId]);
  }
  async cancelSignIn(flowId: string) {
    return this.#answer('cancelSignIn', [flowId]);
  }
}

type Channel = 'success' | 'report' | 'warn' | 'error';

export class FakeOutput {
  readonly lines: { channel: Channel; text: string }[] = [];
  exitCode = 0;
  success = (text: string) => void this.lines.push({ channel: 'success', text });
  report = (text: string) => void this.lines.push({ channel: 'report', text });
  warn = (text: string) => void this.lines.push({ channel: 'warn', text });
  error = (text: string) => void this.lines.push({ channel: 'error', text });
  setExitCode = (code: number) => {
    this.exitCode = code;
  };
  text(channel: Channel): string {
    return this.lines
      .filter(line => line.channel === channel)
      .map(line => line.text)
      .join('\n');
  }
}

export class FakePrompt {
  readonly questions: string[] = [];
  readonly #answers: string[];
  constructor(answers: string[] = []) {
    this.#answers = [...answers];
  }
  async ask(message: string): Promise<string> {
    this.questions.push(message);
    return this.#answers.shift() ?? '';
  }
}

export interface FakeWorld {
  readonly deps: LoginsCommandDeps;
  readonly gateway: FakeGateway;
  readonly out: FakeOutput;
  readonly prompt: FakePrompt;
  readonly slept: number[];
}

/** A whole set of collaborators, every one a recording fake. */
export function fakeWorld(
  options: { gateway?: Partial<FakeAnswers>; answers?: string[]; interactive?: boolean; now?: () => number } = {},
): FakeWorld {
  const gateway = new FakeGateway(options.gateway);
  const out = new FakeOutput();
  const prompt = new FakePrompt(options.answers);
  const slept: number[] = [];
  const deps: LoginsCommandDeps = {
    gateway,
    out,
    ...(options.interactive === false ? {} : { prompt }),
    binaryName: 'fz',
    sleep: async milliseconds => {
      slept.push(milliseconds);
    },
    now: options.now ?? (() => Date.parse(AT)),
  };
  return { deps, gateway, out, prompt, slept };
}
