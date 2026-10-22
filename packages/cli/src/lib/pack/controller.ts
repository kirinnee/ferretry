import {
  changingIds,
  diffGuide,
  mergeGuide,
  type PackGuideJobResult,
  type PackGuideSuggestion,
  type PackNewRequest,
  PackNewRequestSchema,
} from '@ferretry/protocol';
import { type IProgress, NO_PROGRESS, withStep } from '../progress/index.ts';
import { titleFromReferencedBrief } from '../tasks/task-title.ts';
import type { IPackGateway } from './gateway.ts';
import { renderInventory, renderSuggestion } from './guide-render.ts';
import { renderGuide, renderPackNewOutcome, renderPackRecommendation } from './render.ts';

/** Terminal output for the Pack commands. `success` is stdout; `error` is stderr. */
export interface IPackIo {
  success(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/** The exit status of a refused `new`: distinct from a failure, so a ferret knows to try its next candidate. */
export const PACK_REFUSED_EXIT_CODE = 2;

export interface PackRecommendOptions {
  readonly json?: boolean;
  readonly useCase?: string;
}

export interface PackGuideShowOptions {
  readonly json?: boolean;
}

export interface PackGuideSuggestOptions {
  readonly runtime?: string;
  readonly model?: string;
  readonly prefs?: string;
  readonly json?: boolean;
  /** Accept the whole draft as soon as it is checked (`--apply`, `-y`). */
  readonly apply?: boolean;
}

export interface PackGuideAcceptOptions {
  /** Accept only these use cases, by id; absent: every one that changes. */
  readonly only?: string;
  /** Leave the routing guidance in effect as it is. */
  readonly keepRouting?: boolean;
}

export interface PackGuideDescribeOptions {
  readonly provider?: string;
  /** Use the catalog's description again. */
  readonly clear?: boolean;
}

/** How long `guide suggest` waits on its builder: a check every few seconds, for up to twenty minutes. */
export const GUIDE_POLL = { intervalMs: 3_000, attempts: 400 } as const;

export interface PackNewOptions {
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly auto?: boolean;
  readonly useCase?: string;
  readonly cwd?: string;
  readonly name?: string;
  readonly mode?: 'auto' | 'interactive';
  readonly promptFile?: string;
  readonly json?: boolean;
  /** Run in a temporary or scratch folder anyway; the daemon refuses one `scratch_cwd` otherwise. */
  readonly allowScratch?: boolean;
}

export interface PackControllerDeps {
  readonly gateway: IPackGateway;
  readonly out: IPackIo;
  /**
   * The ferret this runs inside (`FY_SESSION_ID`, or its tmux session's copy — `./ambient.ts`), which becomes
   * the parent; `undefined` for a person's shell. Read only when a start is made.
   */
  readonly parent: () => Promise<string | undefined>;
  /** A folder the caller typed, made absolute against where `fy` was run. */
  readonly absolute: (path: string) => string;
  /** Where `fy` was run, the folder a top-level start runs in. */
  readonly cwd: string;
  readonly readFile: (path: string) => Promise<string>;
  readonly binaryName: string;
  /** What the daemon's probing shows while `new` waits for it. Absent, nothing is shown. */
  readonly progress?: IProgress;
  /** Waits between two looks at a guide builder's run. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const joined = (words: readonly string[]): string => words.join(' ').replaceAll(/\s+/gu, ' ').trim();

/** Drives `fy recommend` and `fy new` (docs/pack-mode.md): the daemon decides, this asks and prints. */
export class PackController {
  constructor(private readonly deps: PackControllerDeps) {}

  async recommend(words: readonly string[], options: PackRecommendOptions): Promise<void> {
    const task = joined(words);
    if (task === '') throw new Error(`describe the part: ${this.deps.binaryName} recommend "<what needs doing>"`);
    const recommendation = await this.deps.gateway.recommend({
      task,
      ...(options.useCase === undefined ? {} : { useCase: options.useCase }),
    });
    this.deps.out.success(
      options.json === true ? JSON.stringify(recommendation, null, 2) : renderPackRecommendation(recommendation),
    );
  }

  /** `guide show`: the models guide in effect — where it came from, its routing guidance, its use cases. */
  async showGuide(options: PackGuideShowOptions): Promise<void> {
    const view = await this.deps.gateway.view();
    this.deps.out.success(options.json === true ? JSON.stringify(view.guide, null, 2) : renderGuide(view));
  }

  /** `guide inventory`: what the guide builder is shown. */
  async showInventory(options: PackGuideShowOptions): Promise<void> {
    const inventory = await this.deps.gateway.inventory();
    this.deps.out.success(options.json === true ? JSON.stringify(inventory, null, 2) : renderInventory(inventory));
  }

  /**
   * `guide suggest`: start the builder ferret (a person's ask, one model run), wait for its draft, and show it
   * as a diff — or, with `--apply`, accept it whole.
   */
  async suggest(options: PackGuideSuggestOptions): Promise<void> {
    const bin = this.deps.binaryName;
    const started = await withStep(
      this.deps.progress ?? NO_PROGRESS,
      options.runtime === undefined ? 'Checking the best ready runtime' : `Checking ${options.runtime}`,
      async () =>
        await this.deps.gateway.suggest({
          ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.prefs === undefined ? {} : { preferences: options.prefs }),
        }),
    );
    if (started.outcome === 'refused') {
      this.deps.out.error(`${bin} guide suggest: ${started.message}`);
      this.deps.out.setExitCode(PACK_REFUSED_EXIT_CODE);
      return;
    }
    const job = started.job;
    const result = await withStep(
      this.deps.progress ?? NO_PROGRESS,
      `${job.name} is drafting a guide on ${job.runtime}`,
      async () => await this.settled(job.id),
    );
    if (result.job.status !== 'suggested' || result.suggestion === undefined) {
      const why =
        result.job.status === 'running'
          ? `it is still drafting; look again with \`${bin} guide accept ${job.id}\` once it is done`
          : (result.job.message ?? 'the builder failed');
      this.deps.out.error(`${bin} guide suggest: ${why}`);
      this.deps.out.setExitCode(1);
      return;
    }
    if (options.json === true) this.deps.out.success(JSON.stringify(result, null, 2));
    else this.deps.out.success(renderSuggestion(result.job, result.suggestion, bin));
    if (options.apply === true) await this.acceptSuggestion(result.suggestion, {});
  }

  /** `guide accept <run>`: write a checked draft, whole or in part. */
  async accept(jobId: string, options: PackGuideAcceptOptions): Promise<void> {
    const result = await this.deps.gateway.job(jobId);
    if (result.suggestion === undefined) {
      this.deps.out.error(
        `${this.deps.binaryName} guide accept: run ${jobId} is ${result.job.status}${result.job.message === undefined ? '' : ` (${result.job.message})`}, with no draft to accept`,
      );
      this.deps.out.setExitCode(1);
      return;
    }
    await this.acceptSuggestion(result.suggestion, options);
  }

  /** `guide undo`: put back the guide the last accept replaced. */
  async undo(): Promise<void> {
    this.deps.out.success((await this.deps.gateway.undo()).message);
  }

  /** `guide describe <model> "<text>"`: the owner's description of a model, which the builder reads. */
  async describe(model: string, words: readonly string[], options: PackGuideDescribeOptions): Promise<void> {
    const text = joined(words);
    if (options.clear !== true && text === '')
      throw new Error(
        `say what ${model} is good for: ${this.deps.binaryName} guide describe ${model} "<text>" (or --clear)`,
      );
    const written = await this.deps.gateway.describe({
      model,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      description: options.clear === true ? null : text,
    });
    this.deps.out.success(written.message);
  }

  /** Looks at a run until it is no longer running, or the wait is up. */
  private async settled(jobId: string): Promise<PackGuideJobResult> {
    let result = await this.deps.gateway.job(jobId);
    for (let attempt = 1; result.job.status === 'running' && attempt < GUIDE_POLL.attempts; attempt += 1) {
      await (this.deps.sleep ?? (async () => undefined))(GUIDE_POLL.intervalMs);
      result = await this.deps.gateway.job(jobId);
    }
    return result;
  }

  /** Accepts the chosen use cases of a draft against the guide in effect NOW, so a later edit is not lost. */
  private async acceptSuggestion(suggestion: PackGuideSuggestion, options: PackGuideAcceptOptions): Promise<void> {
    const current = (await this.deps.gateway.view()).guide.useCases;
    const changing = changingIds(diffGuide(current, suggestion.useCases));
    const only = options.only
      ?.split(',')
      .map(id => id.trim())
      .filter(id => id !== '');
    const unknown = (only ?? []).filter(id => !changing.includes(id));
    if (unknown.length > 0)
      throw new Error(
        `no change to accept for ${unknown.join(', ')}; the draft changes ${changing.join(', ') || 'no use case'}`,
      );
    const accepted = new Set(only ?? changing);
    const written = await this.deps.gateway.accept({
      useCases: [...mergeGuide(current, suggestion.useCases, accepted)],
      ...(options.keepRouting === true ? {} : { routing: suggestion.routing }),
      suggested: suggestion.suggested,
      ...(accepted.size < changing.length || options.keepRouting === true ? { partial: true } : {}),
    });
    this.deps.out.success(written.message);
  }

  async newChild(words: readonly string[], options: PackNewOptions): Promise<void> {
    const typed = joined(words);
    const task = options.promptFile === undefined ? typed : (await this.deps.readFile(options.promptFile)).trim();
    if (task === '')
      throw new Error(`give the brief: ${this.deps.binaryName} new --runtime <runtime> "<complete brief>"`);
    const parent = await this.deps.parent();
    const name =
      options.name ?? (await titleFromReferencedBrief(task, path => this.deps.readFile(this.deps.absolute(path))));
    const request: PackNewRequest = PackNewRequestSchema.parse({
      task,
      ...(parent === undefined ? {} : { parent }),
      ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
      ...(options.auto === true ? { auto: true } : {}),
      ...(options.useCase === undefined ? {} : { useCase: options.useCase }),
      // A sub-ferret runs in its PARENT'S folder — never where the agent's shell happens to be — unless told
      // otherwise; a person's start runs here. The daemon refuses a named temporary folder (`--allow-scratch`).
      ...(options.cwd !== undefined
        ? { cwd: this.deps.absolute(options.cwd) }
        : parent === undefined
          ? { cwd: this.deps.cwd }
          : {}),
      ...(options.allowScratch === true ? { allowScratch: true } : {}),
      ...(name === undefined ? {} : { name }),
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    const outcome = await withStep(
      this.deps.progress ?? NO_PROGRESS,
      options.runtime === undefined ? 'Choosing the best runtime' : `Checking ${options.runtime}`,
      async () => await this.deps.gateway.newChild(request),
    );
    if (options.json === true) this.deps.out.success(JSON.stringify(outcome, null, 2));
    else if (outcome.outcome === 'started') this.deps.out.success(renderPackNewOutcome(outcome, this.deps.binaryName));
    else this.deps.out.error(`${this.deps.binaryName} new: ${renderPackNewOutcome(outcome, this.deps.binaryName)}`);
    if (outcome.outcome === 'refused') this.deps.out.setExitCode(PACK_REFUSED_EXIT_CODE);
  }
}
