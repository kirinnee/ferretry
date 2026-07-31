import {
  grantedConfirmations,
  grantedOverrides,
  type RemovalConsentFlags,
  type UnclearedBlocker,
  unclearedBlockers,
} from './overrides.ts';
import type { IWorktreeGateway, IWorktreeOutput } from './ports.ts';
import { renderBlocker, renderRemovalDecision, renderRemoved, renderWorktreeList } from './render.ts';
import type { WorktreeRemovalDecision } from './wire.ts';

/** Typed-confirmation input, injected so a test never blocks on a terminal. */
export interface IWorktreePrompt {
  ask(message: string): Promise<string>;
}

/** Options every worktree command accepts. */
export interface WorktreeCommandOptions {
  readonly json?: boolean;
}

/** Flags that remove a worktree. */
export interface WorktreeRemoveOptions extends WorktreeCommandOptions, RemovalConsentFlags {
  /** Skip the typed confirmation; required for a non-interactive removal. */
  readonly yes?: boolean;
}

/** What the caller must type to confirm a removal by hand. */
export const CONFIRMATION_WORD = 'remove';

/**
 * Drives `fy worktree …`.
 *
 * A managed worktree is a checkout the daemon created for a session. Removing one destroys work
 * unless nothing is left in it, so this group's whole job is to say what would be lost before
 * anything is, and to make each class of loss opt-in by name.
 */
export class WorktreeController {
  constructor(
    private readonly gateway: IWorktreeGateway,
    private readonly out: IWorktreeOutput,
    private readonly prompt: IWorktreePrompt,
    private readonly interactive: boolean,
  ) {}

  async list(options: WorktreeCommandOptions): Promise<void> {
    const response = await this.gateway.list();
    this.#report(response, options, () => renderWorktreeList(response));
  }

  async check(path: string, options: WorktreeCommandOptions): Promise<void> {
    const decision = await this.gateway.check(location(path));
    const uncleared = unclearedBlockers(decision, []);
    this.#report(decision, options, () => renderRemovalDecision(decision, uncleared));
  }

  /**
   * Removes a worktree, but only once every blocker is accounted for.
   *
   * The check happens first and its verdict is printed, so the caller sees exactly what they are
   * authorizing. kteam removed first and reported afterwards, which is the wrong order for an
   * irreversible operation.
   */
  async remove(path: string, options: WorktreeRemoveOptions): Promise<void> {
    const target = location(path);
    const overrides = grantedOverrides(options);
    const decision = await this.gateway.check(target);
    const uncleared = unclearedBlockers(decision, overrides);
    if (uncleared.length > 0) throw new Error(blockedMessage(decision, uncleared));

    await this.#confirm(decision, options);
    const removed = await this.gateway.remove({
      path: target,
      overrides: [...overrides],
      deleteBranch: options.deleteBranch === true,
      confirmations: [...grantedConfirmations(options)],
    });
    this.#report(removed, options, () => renderRemoved(removed));
  }

  /**
   * A typed confirmation, unless `--yes` waived it.
   *
   * Off a TTY there is nobody to type it, so an unattended run must pass `--yes` explicitly rather
   * than have the guard silently skipped — the failure mode that makes a safety prompt decorative.
   */
  async #confirm(decision: WorktreeRemovalDecision, options: WorktreeRemoveOptions): Promise<void> {
    if (options.yes === true) return;
    if (!this.interactive) {
      throw new Error(`refusing to remove ${decision.path} without a confirmation — pass --yes to authorize it`);
    }
    this.out.warn(`About to remove ${decision.path} (branch ${decision.branch}). This cannot be undone.`);
    const answer = await this.prompt.ask(`Type ${JSON.stringify(CONFIRMATION_WORD)} to confirm:`);
    if (answer.trim() !== CONFIRMATION_WORD) throw new Error('removal cancelled');
  }

  #report(payload: unknown, options: WorktreeCommandOptions, human: () => string): void {
    this.out.success(options.json === true ? JSON.stringify(payload, null, 2) : human());
  }
}

/** The message a refused removal fails with: every blocker, and the flag that clears each. */
function blockedMessage(decision: WorktreeRemovalDecision, uncleared: readonly UnclearedBlocker[]): string {
  return [`refusing to remove ${decision.path}:`, ...uncleared.map(renderBlocker)].join('\n');
}

/** A worktree path, refused rather than sent as an empty query parameter. */
function location(value: string): string {
  const path = value.trim();
  if (path === '') throw new Error('a worktree path is required');
  return path;
}
