import { type ProposalState, ProposalStateSchema, type ProposalView } from '@ferretry/protocol';
import type { ILearningGateway, ILearningOutput } from './ports.ts';
import {
  renderLearningConfig,
  renderLearningPatch,
  renderLearningStatus,
  renderProposalAction,
  renderProposalDetail,
  renderProposalList,
  renderRunManifest,
} from './render.ts';

/** Options every learning command accepts. */
export interface LearningCommandOptions {
  /** Emit the protocol payload verbatim instead of the human rendering. */
  readonly json?: boolean;
}

/** Flags that narrow the proposal board. */
export interface LearningListOptions extends LearningCommandOptions {
  readonly state?: string;
  /** Show every state, not just the pending ones a human still has to judge. */
  readonly all?: boolean;
}

/** Flags that reject a proposal. */
export interface LearningRejectOptions extends LearningCommandOptions {
  readonly note?: string;
}

/** Flags that trigger a mining run. */
export interface LearningRunOptions extends LearningCommandOptions {
  readonly spawn?: boolean;
}

/**
 * Drives `fy learning …`.
 *
 * The subsystem mines finished sessions for corrections the human made and turns the recurring ones
 * into proposed guidance. Every verb here is about judging those proposals; the mining itself is the
 * daemon's job.
 */
export class LearningController {
  constructor(
    private readonly gateway: ILearningGateway,
    private readonly out: ILearningOutput,
  ) {}

  async status(options: LearningCommandOptions): Promise<void> {
    const status = await this.gateway.status();
    this.#report(status, options, () => renderLearningStatus(status));
  }

  async config(options: LearningCommandOptions): Promise<void> {
    const config = await this.gateway.config();
    this.#report(config, options, () => renderLearningConfig(config));
  }

  /**
   * Lists proposals, pending by default.
   *
   * Pending is the default because it is the only state that asks anything of the human; `--all`
   * widens to the audit. kteam passed `--state` through unchecked, so a typo produced an empty board
   * that was indistinguishable from a genuinely empty one.
   */
  async list(options: LearningListOptions): Promise<void> {
    const state = this.#state(options);
    const proposals = await this.gateway.proposals(state);
    this.#report(proposals, options, () => renderProposalList(proposals, state));
  }

  async show(id: string, options: LearningCommandOptions): Promise<void> {
    const proposal = await this.#find(identifier(id));
    this.#report(proposal, options, () => renderProposalDetail(proposal));
  }

  async accept(id: string, options: LearningCommandOptions): Promise<void> {
    const proposal = await this.gateway.act(identifier(id), { action: 'accept' });
    this.#report(proposal, options, () => renderProposalAction('accepted', proposal));
  }

  async reject(id: string, options: LearningRejectOptions): Promise<void> {
    const note = text(options.note);
    const proposal = await this.gateway.act(identifier(id), {
      action: 'reject',
      ...(note === undefined ? {} : { note }),
    });
    this.#report(proposal, options, () => renderProposalAction('rejected', proposal));
  }

  async edit(id: string, words: readonly string[], options: LearningCommandOptions): Promise<void> {
    const ruleText = words.join(' ').trim();
    if (ruleText === '') throw new Error('edit needs the replacement rule text');
    const proposal = await this.gateway.act(identifier(id), { action: 'edit', ruleText });
    this.#report(proposal, options, () => renderProposalAction('reworded', proposal));
  }

  async run(options: LearningRunOptions): Promise<void> {
    const manifest = await this.gateway.run(options.spawn === true);
    this.#report(manifest, options, () => renderRunManifest(manifest));
  }

  async patch(id: string, options: LearningCommandOptions): Promise<void> {
    const patch = await this.gateway.patch(identifier(id));
    this.#report(patch, options, () => renderLearningPatch(patch));
  }

  /**
   * The proposal detail comes from the board rather than a per-proposal read: the daemon only serves
   * evidence in the list projection, and `show` without evidence would be the summary again.
   */
  async #find(id: string): Promise<ProposalView> {
    const proposals = await this.gateway.proposals();
    const found = proposals.find(proposal => proposal.id === id);
    if (found === undefined) throw new Error(`no learning proposal "${id}"`);
    return found;
  }

  /** Which lifecycle state the listing is narrowed to, validated before it reaches the daemon. */
  #state(options: LearningListOptions): ProposalState | undefined {
    const requested = text(options.state);
    if (requested === undefined) return options.all === true ? undefined : 'pending';
    if (options.all === true) throw new Error('--all and --state contradict each other; pass one');
    const parsed = ProposalStateSchema.safeParse(requested);
    if (!parsed.success) {
      throw new Error(`--state must be one of ${ProposalStateSchema.options.join(', ')}, not "${requested}"`);
    }
    return parsed.data;
  }

  #report(payload: unknown, options: LearningCommandOptions, human: () => string): void {
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
