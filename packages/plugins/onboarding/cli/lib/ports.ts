import type { OnboardingView, StepAnswerRequest, StepView } from '../../contract/index.ts';

/** What `onboard` needs from the daemon: this plugin's own routes, and a read of any step's live check. */
export interface OnboardClient {
  view(): Promise<OnboardingView>;
  /** Records how a step stands; `undefined` when the daemon does not know the step. */
  record(plugin: string, id: string, answer: StepAnswerRequest): Promise<StepView | undefined>;
  reset(): Promise<void>;
  /** Calls a route the owning plugin declares (a step's live check). Throws when it cannot be called. */
  check(route: string): Promise<unknown>;
}

/** Where the person answers a question. Absent off a terminal: nothing is ever asked there. */
export interface OnboardPrompt {
  ask(message: string): Promise<string>;
}

/** The terminal's two streams: a report is the command's answer, a warning is everything else. */
export interface OnboardOutput {
  report(text: string): void;
  warn(text: string): void;
}
