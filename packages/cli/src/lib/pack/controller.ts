import { type PackNewRequest, PackNewRequestSchema } from '@ferretry/protocol';
import { type IProgress, NO_PROGRESS, withStep } from '../progress/index.ts';
import { titleFromReferencedBrief } from '../tasks/task-title.ts';
import type { IPackGateway } from './gateway.ts';
import { renderPackNewOutcome, renderPackRecommendation } from './render.ts';

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
