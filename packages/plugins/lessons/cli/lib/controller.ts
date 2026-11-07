import {
  AgentLessonToolCallSchema,
  type LessonsScanRequest,
  type LessonsScanScope,
  ProposalCategorySchema,
  type ProposalState,
  ProposalStateSchema,
  type ProposalView,
} from '../../contract/index.ts';
import type { z } from 'zod';
import type { ILessonsGateway, ILessonsOutput } from './ports.ts';
import {
  renderLessonsApplyPreview,
  renderLessonsConfig,
  renderLessonsPatch,
  renderLessonsScanEstimate,
  renderLessonsScanProgress,
  renderLessonSuggestion,
  renderLessonsStatus,
  renderProposalAction,
  renderProposalDetail,
  renderProposalList,
  renderRunManifest,
} from './render.ts';

/** Options every learning command accepts. */
export interface LessonsCommandOptions {
  /** Emit the protocol payload verbatim instead of the human rendering. */
  readonly json?: boolean;
}

/** Flags that narrow the proposal board. */
export interface LessonsListOptions extends LessonsCommandOptions {
  readonly state?: string;
  /** Show every state, not just the pending ones a human still has to judge. */
  readonly all?: boolean;
}

/** Flags that reject a proposal. */
export interface LessonsRejectOptions extends LessonsCommandOptions {
  readonly note?: string;
}

/** Flags that trigger a mining run. */
export interface LessonsRunOptions extends LessonsCommandOptions {
  readonly spawn?: boolean;
}

/** Flags that apply an accepted lesson. */
export interface LessonsApplyOptions extends LessonsCommandOptions {
  /** Without it, only the preview is shown; the write never happens by itself. */
  readonly yes?: boolean;
}

/** Flags that shape a scan. */
export interface LessonsScanOptions extends LessonsCommandOptions {
  readonly estimate?: boolean;
  readonly start?: boolean;
  readonly ferrets?: string;
  readonly agent?: string;
  readonly model?: string;
}

/**
 * Drives `fy lesson …`.
 *
 * The subsystem mines finished sessions, and a running ferret's own `lesson suggest`, for
 * corrections and durable facts, and turns the recurring ones into proposed guidance. Every verb
 * here is about judging those proposals and, for Apply, about writing one into its target file; the
 * mining itself is the daemon's job.
 */
export class LessonsController {
  constructor(
    private readonly gateway: ILessonsGateway,
    private readonly out: ILessonsOutput,
    /** The binary name, so a re-run hint names the command this install actually has. */
    private readonly bin: string,
  ) {}

  /**
   * Files one lesson as the ferret this runs inside. It dials the same route the `lessons_suggest` tool does, so run
   * outside a ferret the daemon's own refusal is what the human sees.
   */
  async suggest(rule: string, scope: string, options: LessonsCommandOptions): Promise<void> {
    const parsed = AgentLessonToolCallSchema.safeParse({ tool: 'lessons.suggest', rule, scope });
    if (!parsed.success) {
      const [issue] = parsed.error.issues as [z.core.$ZodIssue];
      throw new Error(issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`);
    }
    const result = await this.gateway.suggest(parsed.data.rule, parsed.data.scope);
    this.out.success(options.json === true ? JSON.stringify(result, null, 2) : renderLessonSuggestion(result));
  }

  async status(options: LessonsCommandOptions): Promise<void> {
    const status = await this.gateway.status();
    this.#report(status, options, () => renderLessonsStatus(status));
  }

  async config(options: LessonsCommandOptions): Promise<void> {
    const config = await this.gateway.config();
    this.#report(config, options, () => renderLessonsConfig(config));
  }

  /**
   * Lists proposals, pending by default.
   *
   * Pending is the default because it is the only state that asks anything of the human; `--all`
   * widens to the audit. kteam passed `--state` through unchecked, so a typo produced an empty board
   * that was indistinguishable from a genuinely empty one.
   */
  async list(options: LessonsListOptions): Promise<void> {
    const state = this.#state(options);
    const proposals = await this.gateway.proposals(state);
    this.#report(proposals, options, () => renderProposalList(proposals, state));
  }

  async show(id: string, options: LessonsCommandOptions): Promise<void> {
    const proposal = await this.#find(identifier(id));
    this.#report(proposal, options, () => renderProposalDetail(proposal));
  }

  async accept(id: string, options: LessonsCommandOptions): Promise<void> {
    const proposal = await this.gateway.act(identifier(id), { action: 'accept' });
    this.#report(proposal, options, () => renderProposalAction('accepted', proposal));
  }

  async reject(id: string, options: LessonsRejectOptions): Promise<void> {
    const note = text(options.note);
    const proposal = await this.gateway.act(identifier(id), {
      action: 'reject',
      ...(note === undefined ? {} : { note }),
    });
    this.#report(proposal, options, () => renderProposalAction('rejected', proposal));
  }

  async edit(id: string, words: readonly string[], options: LessonsCommandOptions): Promise<void> {
    const ruleText = words.join(' ').trim();
    if (ruleText === '') throw new Error('edit needs the replacement rule text');
    const proposal = await this.gateway.act(identifier(id), { action: 'edit', ruleText });
    this.#report(proposal, options, () => renderProposalAction('reworded', proposal));
  }

  /** Changes where a lesson goes: `global` (every ferret) or `repo` (this project). */
  async categorize(id: string, category: string, options: LessonsCommandOptions): Promise<void> {
    const parsed = ProposalCategorySchema.safeParse(category);
    if (!parsed.success)
      throw new Error(`category must be one of ${ProposalCategorySchema.options.join(', ')}, not "${category}"`);
    const proposal = await this.gateway.act(identifier(id), { action: 'categorize', category: parsed.data });
    this.#report(proposal, options, () => renderProposalAction('categorized', proposal));
  }

  /** Puts an accepted (or rejected) lesson back in To review. */
  async reopen(id: string, options: LessonsCommandOptions): Promise<void> {
    const proposal = await this.gateway.act(identifier(id), { action: 'reopen' });
    this.#report(proposal, options, () => renderProposalAction('reopened', proposal));
  }

  async run(options: LessonsRunOptions): Promise<void> {
    const manifest = await this.gateway.run(options.spawn === true);
    this.#report(manifest, options, () => renderRunManifest(manifest));
  }

  async patch(id: string, options: LessonsCommandOptions): Promise<void> {
    const patch = await this.gateway.patch(identifier(id));
    this.#report(patch, options, () => renderLessonsPatch(patch));
  }

  /**
   * Shows exactly what Apply would write, and writes it only when the owner said `--yes` to this
   * very preview — the etag the preview carried is what pins the write, so a file that moved between
   * the two calls is refused rather than overwritten.
   */
  async apply(id: string, options: LessonsApplyOptions): Promise<void> {
    const target = identifier(id);
    const preview = await this.gateway.applyPreview(target);
    if (options.yes !== true) {
      this.#report(preview, options, () => renderLessonsApplyPreview(preview, this.bin));
      return;
    }
    const applied = await this.gateway.apply(target, preview.etag);
    this.#report(applied, options, () => renderProposalAction('applied', applied));
  }

  /**
   * `--estimate` (the default) costs nothing and starts nothing; `--start` is the one explicit act
   * that actually reads transcripts. The scope narrows to named ferrets, or — absent one — every
   * ferret not instructed to learn passively.
   */
  async scan(options: LessonsScanOptions): Promise<void> {
    if (options.estimate === true && options.start === true)
      throw new Error('scan once: pass --estimate or --start, not both');
    const request = this.#scanRequest(options);
    if (options.start === true) {
      const progress = await this.gateway.scan(request);
      this.#report(progress, options, () => renderLessonsScanProgress(progress));
      return;
    }
    const estimate = await this.gateway.scanEstimate(request);
    this.#report(estimate, options, () => renderLessonsScanEstimate(estimate));
  }

  /**
   * The proposal detail comes from the board rather than a per-proposal read: the daemon only serves
   * evidence in the list projection, and `show` without evidence would be the summary again.
   */
  async #find(id: string): Promise<ProposalView> {
    const proposals = await this.gateway.proposals();
    const found = proposals.find(proposal => proposal.id === id);
    if (found === undefined) throw new Error(`no lesson proposal "${id}"`);
    return found;
  }

  /** Which lifecycle state the listing is narrowed to, validated before it reaches the daemon. */
  #state(options: LessonsListOptions): ProposalState | undefined {
    const requested = text(options.state);
    if (requested === undefined) return options.all === true ? undefined : 'pending';
    if (options.all === true) throw new Error('--all and --state contradict each other; pass one');
    const parsed = ProposalStateSchema.safeParse(requested);
    if (!parsed.success) {
      throw new Error(`--state must be one of ${ProposalStateSchema.options.join(', ')}, not "${requested}"`);
    }
    return parsed.data;
  }

  /** `--ferrets a,b` names an explicit scope; absent, every ferret not instructed to learn. */
  #scanRequest(options: LessonsScanOptions): LessonsScanRequest {
    const agent = text(options.agent);
    const model = text(options.model);
    return {
      scope: this.#scanScope(options.ferrets),
      ...(agent === undefined ? {} : { agent }),
      ...(model === undefined ? {} : { model }),
    };
  }

  #scanScope(sessions: string | undefined): LessonsScanScope {
    const ids = (sessions ?? '')
      .split(',')
      .map(id => id.trim())
      .filter(id => id !== '');
    return ids.length === 0 ? { kind: 'not-passive' } : { kind: 'ferrets', ferretIds: ids };
  }

  #report(payload: unknown, options: LessonsCommandOptions, human: () => string): void {
    this.out.success(options.json === true ? JSON.stringify(payload, null, 2) : human());
  }
}

/** A trimmed flag value, or nothing when the flag was absent or blank. */
function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? undefined : trimmed;
}

/** A proposal id, refused rather than sent as an empty path segment. */
function identifier(value: string): string {
  const id = value.trim();
  if (id === '') throw new Error('a proposal id is required');
  return id;
}
