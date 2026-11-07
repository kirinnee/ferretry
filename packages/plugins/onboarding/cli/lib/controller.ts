import type { StepAnswerRequest, StepView } from '../../contract/index.ts';
import { checkFor, type Reading } from './checks.ts';
import type { OnboardClient, OnboardOutput, OnboardPrompt } from './ports.ts';
import {
  renderClosing,
  renderStatus,
  renderSummaryJson,
  reportLine,
  reportOf,
  row,
  type StepReport,
  summarize,
  titleWidth,
} from './summary.ts';
import { linkCosts, NO_STEPS, WAITING_NO_TERMINAL } from './words.ts';

/** Flags `onboard` accepts. */
export interface OnboardOptions {
  /** Leave every step it cannot find for later without asking; required off a terminal to settle anything. */
  readonly yes?: boolean;
  /** Print the summary as JSON instead of the report. Implies no questions. */
  readonly json?: boolean;
  /** Change nothing: report what each step finds and what is left. */
  readonly check?: boolean;
}

export interface OnboardDeps {
  readonly client: OnboardClient;
  /** Absent when nobody is at a terminal. */
  readonly prompt: OnboardPrompt | undefined;
  readonly out: OnboardOutput;
  readonly bin: string;
}

const EXIT_OK = 0;
const EXIT_FAILURE = 1;

/**
 * Drives `fy onboard`: the first run at a terminal (design §6.1). FIND BEFORE ASKING: for each step still pending, in
 * the order the plugins declared, it runs the owning plugin's live check and records `found` when that sees the step is
 * already done. It asks only about what the check did not find, and the answers are the three the daemon records: later,
 * skipped, or done (which looks again).
 *
 * IDEMPOTENT. A step that is already answered is shown and left alone, so running it twice is the same as running it
 * once; `onboard reset` starts over. A step whose check cannot be called stays pending and is never recorded: nothing
 * is decided about what was not looked at.
 */
export class OnboardController {
  constructor(private readonly deps: OnboardDeps) {}

  async run(options: OnboardOptions): Promise<number> {
    const json = options.json === true;
    const view = await this.#view();
    if (view === undefined) return EXIT_FAILURE;
    if (view.steps.length === 0) {
      this.deps.out.report(NO_STEPS);
      return EXIT_OK;
    }
    const prompt = json || options.check === true || options.yes === true ? undefined : this.deps.prompt;
    const width = titleWidth(view.steps);
    const reports: StepReport[] = [];
    for (const step of view.steps) {
      const report = step.state === 'pending' ? await this.#settle(step, options, prompt) : settled(step);
      reports.push(report);
      if (!json) this.deps.out.report(row(report.step, reportLine(report), width));
    }
    const summary = summarize(reports);
    if (json) this.deps.out.report(renderSummaryJson(summary));
    else {
      this.deps.out.report('');
      if (summary.linkedSignIn) {
        this.deps.out.report(linkCosts(this.deps.bin));
        this.deps.out.report('');
      }
      this.deps.out.report(renderClosing(summary));
    }
    const asked = options.yes !== true && options.check !== true && prompt === undefined && !json;
    if (!summary.complete && asked) this.deps.out.warn(WAITING_NO_TERMINAL(this.deps.bin));
    return summary.exitCode;
  }

  async status(options: { readonly json?: boolean }): Promise<number> {
    const view = await this.#view();
    if (view === undefined) return EXIT_FAILURE;
    this.deps.out.report(options.json === true ? JSON.stringify({ schema: 1, ...view }, null, 2) : renderStatus(view));
    return EXIT_OK;
  }

  async reset(): Promise<number> {
    try {
      await this.deps.client.reset();
    } catch (error: unknown) {
      this.deps.out.warn(sentenceOf(error));
      return EXIT_FAILURE;
    }
    this.deps.out.report(`The first run starts again. Run \`${this.deps.bin} onboard\` to go through it.`);
    return EXIT_OK;
  }

  async #view() {
    try {
      return await this.deps.client.view();
    } catch (error: unknown) {
      this.deps.out.warn(sentenceOf(error));
      return undefined;
    }
  }

  /** Looks, records what it found, and asks about what it did not. */
  async #settle(step: StepView, options: OnboardOptions, prompt: OnboardPrompt | undefined): Promise<StepReport> {
    let report = reportOf(step, await this.#look(step));
    if (report.check === 'found') return options.check === true ? report : this.#record(report, 'found');
    // Not looked at (the route could not be called): decide nothing about it.
    if (report.check === 'unreachable' || options.check === true) return report;
    if (options.yes === true) return this.#record(report, 'later');
    if (prompt === undefined) return report;

    const said = report.remedy === undefined ? report.line : `${report.line} ${report.remedy}`;
    for (;;) {
      const answer = (await prompt.ask(`${said}\n${step.title}: [L]ater, [s]kip, or [d]one (look again)?`))
        .trim()
        .toLowerCase();
      if (answer === '' || answer === 'l' || answer === 'later') return this.#record(report, 'later');
      if (answer === 's' || answer === 'skip') return this.#record(report, 'skipped');
      if (answer === 'd' || answer === 'done') {
        report = reportOf(step, await this.#look(step));
        if (report.check === 'found') return this.#record(report, 'found');
        return this.#record({ ...report, line: `${report.line} Still not found.` }, 'later');
      }
      this.deps.out.warn('Answer l, s or d.');
    }
  }

  async #look(step: StepView): Promise<Reading | undefined> {
    const check = checkFor(step.plugin, step.id);
    if (check === undefined) return undefined;
    try {
      return check.read(await this.deps.client.check(check.route), this.deps.bin);
    } catch (error: unknown) {
      return { kind: 'unreadable', reason: sentenceOf(error) };
    }
  }

  async #record(report: StepReport, state: StepAnswerRequest['state']): Promise<StepReport> {
    const { step } = report;
    try {
      const recorded = await this.deps.client.record(step.plugin, step.id, { state });
      return { ...report, step: recorded ?? { ...step, state } };
    } catch (error: unknown) {
      this.deps.out.warn(sentenceOf(error));
      return { ...report, line: `${report.line} (could not be recorded)`, check: 'unreachable' };
    }
  }
}

function settled(step: StepView): StepReport {
  return { step, line: '', check: 'settled' };
}

const sentenceOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
