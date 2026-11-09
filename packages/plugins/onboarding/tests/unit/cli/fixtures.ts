import type { Instant } from '@ferretry/std';
import type { OnboardingView, StepAnswerRequest, StepState, StepView } from '../../../contract/index.ts';
import type { OnboardClient, OnboardOutput, OnboardPrompt } from '../../../cli/lib/ports.ts';
import type { OnboardDeps } from '../../../cli/lib/controller.ts';

const AT = '2026-11-06T09:00:00.000Z' as Instant;

export const step = (
  plugin: string,
  id: string,
  title: string,
  order: number,
  state: StepState = 'pending',
): StepView => ({
  plugin,
  id,
  title,
  order,
  state,
  ...(state === 'pending' ? {} : { at: AT }),
});

export const LOGINS_ROUTE = 'GET /v1/logins';
export const CLAUDE_ROUTE = 'GET /v1/claude-code/update';
export const NIX_ROUTE = 'GET /v1/shells/nix';

export const signedInLogin = (store: 'host' | 'ferretry' | 'environment' = 'ferretry') => ({
  logins: [{ id: 'main', store, sharedWithTerminal: store === 'host', status: { word: 'ready' } }],
});

/** Answers of one route played in order, the last repeating. */
export class Sequence {
  constructor(readonly items: readonly unknown[]) {}
}

/** The daemon, in memory: the steps, what each route answers, and what was asked of it. */
export class FakeDaemon implements OnboardClient {
  readonly calls: string[] = [];
  readonly checked: string[] = [];
  readonly recorded: { plugin: string; id: string; state: StepAnswerRequest['state']; linked?: true }[] = [];
  resets = 0;
  viewFails: Error | undefined;
  recordFails: Error | undefined;

  constructor(
    public steps: StepView[],
    /** Route key to answer; an `Error` is thrown; a `Sequence` plays several in order. */
    private readonly answers: Record<string, unknown | Error> = {},
  ) {}

  async view(): Promise<OnboardingView> {
    this.calls.push('view');
    if (this.viewFails !== undefined) throw this.viewFails;
    return { steps: [...this.steps], complete: this.steps.every(each => each.state !== 'pending'), setUp: false };
  }

  async record(plugin: string, id: string, answer: StepAnswerRequest): Promise<StepView | undefined> {
    this.calls.push('record');
    if (this.recordFails !== undefined) throw this.recordFails;
    this.recorded.push({
      plugin,
      id,
      state: answer.state,
      ...(answer.linked === true ? { linked: true as const } : {}),
    });
    const at = this.steps.findIndex(each => each.plugin === plugin && each.id === id);
    const found = this.steps[at];
    if (found === undefined) return undefined;
    const next = {
      ...found,
      state: answer.state,
      at: AT,
      ...(answer.linked === true ? { linked: true as const } : {}),
    };
    this.steps[at] = next;
    return next;
  }

  async reset(): Promise<void> {
    this.calls.push('reset');
    this.resets += 1;
    this.steps = this.steps.map(({ at: _at, ...rest }) => ({ ...rest, state: 'pending' as const }));
  }

  async check(route: string): Promise<unknown> {
    this.calls.push(`check ${route}`);
    this.checked.push(route);
    const answer = this.answers[route];
    if (answer === undefined) throw new Error(`no plugin declares the route ${route}`);
    const count = this.checked.filter(each => each === route).length;
    const next = answer instanceof Sequence ? answer.items[Math.min(count - 1, answer.items.length - 1)] : answer;
    if (next instanceof Error) throw next;
    return next;
  }
}

export interface Recorded {
  readonly reports: string[];
  readonly warnings: string[];
  readonly questions: string[];
}

export function deps(
  daemon: FakeDaemon,
  input: { answers?: string[]; interactive?: boolean } = {},
): { deps: OnboardDeps; recorded: Recorded } {
  const recorded: Recorded = { reports: [], warnings: [], questions: [] };
  const answers = [...(input.answers ?? [])];
  const prompt: OnboardPrompt = {
    ask: async message => {
      recorded.questions.push(message);
      return answers.shift() ?? '';
    },
  };
  const out: OnboardOutput = {
    report: text => recorded.reports.push(text),
    warn: text => recorded.warnings.push(text),
  };
  return {
    recorded,
    deps: { client: daemon, prompt: input.interactive === true ? prompt : undefined, out, bin: 'fy' },
  };
}

export const printed = (recorded: Recorded): string => recorded.reports.join('\n');

export const installedClaude = { installed: { state: 'ok', version: '2.1.0' } };
export const noClaude = { installed: null };
export const nixPresent = { present: true, version: '2.24.1', path: '/nix/bin/nix' };
export const nixAbsent = {
  present: false,
  consequence: 'nix is not here, so ferrets use the tools on this machine.',
  remedy: 'Install nix to give ferrets their own shells.',
};
