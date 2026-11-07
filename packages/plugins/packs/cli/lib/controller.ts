import type {
  PackBuilderMode,
  PackCleanUpJobResult,
  PackCleanUpRequest,
  PackCleanUpSuggestion,
  PackRecommendRequest,
} from '../../contract/index.ts';
import type { IPackGateway } from './gateway.ts';
import { renderCleanUp, renderInventory } from './guide-render.ts';
import { renderGuide, renderPackRecommendation } from './render.ts';

/** Terminal output for the Pack commands. `success` is stdout; `error` is stderr. */
export interface IPackIo {
  success(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
  /** stdout exactly as given, for text that carries its own colour; `success` paints a whole message. */
  report?(message: string): void;
  /** Whether a person is at a terminal: colour is added only then. */
  interactive?(): boolean;
}

/** The exit status of a refused clean-up start: distinct from a failure. */
export const PACK_REFUSED_EXIT_CODE = 2;

export interface PackRecommendOptions {
  readonly json?: boolean;
}

export interface PackGuideShowOptions {
  readonly json?: boolean;
}

export interface PackCleanUpOptions {
  /** The rough prompt to clean up; absent: the one in effect. */
  readonly prompt?: string;
  readonly promptFile?: string;
  readonly runtime?: string;
  readonly model?: string;
  readonly json?: boolean;
  /** Accept the rewrite as soon as it is checked (`--apply`, `-y`). */
  readonly apply?: boolean;
}

export interface PackWriteOptions {
  /** What the owner wants, in a line; absent: a sensible default from what is available here. */
  readonly idea?: string;
  readonly runtime?: string;
  readonly model?: string;
  readonly json?: boolean;
  /** Accept the prompt as soon as it is checked (`--apply`, `-y`). */
  readonly apply?: boolean;
}

/** How long `guide clean-up` waits on its ferret: a check every few seconds, for up to twenty minutes. */
export const GUIDE_POLL = { intervalMs: 3_000, attempts: 400 } as const;

export interface PackControllerDeps {
  readonly gateway: IPackGateway;
  readonly out: IPackIo;
  readonly readFile: (path: string) => Promise<string>;
  readonly binaryName: string;
  /**
   * Waits between two looks at a clean-up run. Absent when the terminal gives the verb no sleep (`CliContext` has none
   * on this base): the run is looked at once, and a run still working says how to look again.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

const joined = (words: readonly string[]): string => words.join(' ').replaceAll(/\s+/gu, ' ').trim();

/** Drives `fy recommend` and `fy guide` (docs/pack-mode.md): the daemon decides, this asks and prints. */
export class PackController {
  constructor(private readonly deps: PackControllerDeps) {}

  /** `recommend [task]`: the routing prompt in effect and every model usable here now. */
  async recommend(words: readonly string[], options: PackRecommendOptions): Promise<void> {
    const task = joined(words);
    const request: PackRecommendRequest = task === '' ? {} : { task };
    const recommendation = await this.deps.gateway.recommend(request);
    this.deps.out.success(
      options.json === true ? JSON.stringify(recommendation, null, 2) : renderPackRecommendation(recommendation),
    );
  }

  /** `guide show`: the routing prompt in effect, where it came from, and whether a clean-up can be undone. */
  async showGuide(options: PackGuideShowOptions): Promise<void> {
    const view = await this.deps.gateway.view();
    this.deps.out.success(
      options.json === true
        ? JSON.stringify({ routing: view.routing, ...(view.undo === undefined ? {} : { undo: view.undo }) }, null, 2)
        : renderGuide(view, this.deps.binaryName),
    );
  }

  /** `guide inventory`: what Clean up is shown. */
  async showInventory(options: PackGuideShowOptions): Promise<void> {
    const inventory = await this.deps.gateway.inventory();
    this.deps.out.success(options.json === true ? JSON.stringify(inventory, null, 2) : renderInventory(inventory));
  }

  /**
   * `guide clean-up`: start the builder ferret (a person's ask, one model run), wait for its rewrite, and show
   * it as a word diff with its notes — or, with `--apply`, accept it at once.
   */
  async cleanUp(options: PackCleanUpOptions): Promise<void> {
    const prompt = await this.roughPrompt(options);
    await this.build('clean-up', options, {
      ...(prompt === undefined ? {} : { prompt }),
      ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
      ...(options.model === undefined ? {} : { model: options.model }),
    });
  }

  /**
   * `guide write`: the same builder in its other mode — it writes a whole prompt from a short idea (or from
   * nothing) and what is available here; the result is reviewed and accepted exactly like a clean-up's.
   */
  async write(options: PackWriteOptions): Promise<void> {
    const idea = options.idea?.trim();
    await this.build('generate', options, {
      mode: 'generate',
      ...(idea === undefined || idea === '' ? {} : { idea }),
      ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
      ...(options.model === undefined ? {} : { model: options.model }),
    });
  }

  /** Starts the builder in a mode, waits for its checked result, and prints it (or accepts it). */
  private async build(mode: PackBuilderMode, options: PackWriteOptions, request: PackCleanUpRequest): Promise<void> {
    const bin = this.deps.binaryName;
    const verb = mode === 'generate' ? 'write' : 'clean-up';
    const started = await this.deps.gateway.cleanUp(request);
    if (started.outcome === 'refused') {
      this.deps.out.error(`${bin} guide ${verb}: ${started.message}`);
      this.deps.out.setExitCode(PACK_REFUSED_EXIT_CODE);
      return;
    }
    const job = started.job;
    const result = await this.settled(job.id);
    if (result.job.status !== 'suggested' || result.suggestion === undefined) {
      const why =
        result.job.status === 'running'
          ? `it is still working; look again with \`${bin} guide accept ${job.id}\` once it is done`
          : (result.job.message ?? `the ${verb} failed`);
      this.deps.out.error(`${bin} guide ${verb}: ${why}`);
      this.deps.out.setExitCode(1);
      return;
    }
    const suggestion = result.suggestion;
    if (options.json === true) this.deps.out.success(JSON.stringify(result, null, 2));
    else this.review(color => renderCleanUp(result.job, suggestion, bin, color));
    if (options.apply === true) await this.acceptSuggestion(suggestion);
  }

  /** `guide accept <run>`: write a checked rewrite as the routing prompt. */
  async accept(jobId: string): Promise<void> {
    const result = await this.deps.gateway.job(jobId);
    if (result.suggestion === undefined) {
      this.deps.out.error(
        `${this.deps.binaryName} guide accept: run ${jobId} is ${result.job.status}${result.job.message === undefined ? '' : ` (${result.job.message})`}, with no rewrite to accept`,
      );
      this.deps.out.setExitCode(1);
      return;
    }
    await this.acceptSuggestion(result.suggestion);
  }

  /** `guide undo`: put back the prompt the last accept replaced. */
  async undo(): Promise<void> {
    this.deps.out.success((await this.deps.gateway.undo()).message);
  }

  /** The rough prompt typed or filed; absent when neither was given, so the daemon uses the one in effect. */
  private async roughPrompt(options: PackCleanUpOptions): Promise<string | undefined> {
    if (options.prompt !== undefined && options.promptFile !== undefined)
      throw new Error('give the rough prompt with --prompt or --prompt-file, not both');
    const text = options.promptFile === undefined ? options.prompt : await this.deps.readFile(options.promptFile);
    if (text === undefined) return undefined;
    if (text.trim() === '') throw new Error('the rough prompt is empty; leave it out to clean up the one in effect');
    return text.trim();
  }

  /** Prints a review: tinted through `report` at a terminal, plain through `success` anywhere else. */
  private review(render: (color: boolean) => string): void {
    const { out } = this.deps;
    if (out.interactive?.() === true && out.report !== undefined) out.report(render(true));
    else out.success(render(false));
  }

  /** Looks at a run until it is no longer running, or the wait is up. */
  private async settled(jobId: string): Promise<PackCleanUpJobResult> {
    let result = await this.deps.gateway.job(jobId);
    const sleep = this.deps.sleep;
    // No sleep, no loop: asking again at once would only hammer the daemon.
    if (sleep === undefined) return result;
    for (let attempt = 1; result.job.status === 'running' && attempt < GUIDE_POLL.attempts; attempt += 1) {
      await sleep(GUIDE_POLL.intervalMs);
      result = await this.deps.gateway.job(jobId);
    }
    return result;
  }

  private async acceptSuggestion(suggestion: PackCleanUpSuggestion): Promise<void> {
    const written = await this.deps.gateway.accept({ prompt: suggestion.after, suggested: suggestion.suggested });
    this.deps.out.success(written.message);
  }
}
