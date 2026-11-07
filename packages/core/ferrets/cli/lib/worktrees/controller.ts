import { resolve } from 'node:path';
import type {
  BranchDeletionConfirmation,
  CreateWorktreeRequest,
  WorktreeBase,
  WorktreeRemovalDecision,
} from '@ferretry/protocol';
import {
  grantedConfirmations,
  grantedOverrides,
  type RemovalConsentFlags,
  type UnclearedBlocker,
  unclearedBlockers,
} from './overrides.ts';
import type { IWorktreeGateway, IWorktreeOutput } from './ports.ts';
import { renderBlocker, renderCreated, renderRemovalDecision, renderRemoved, renderWorktreeList } from './render.ts';

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

/** Flags that fork a worktree. */
export interface WorktreeForkOptions extends WorktreeCommandOptions {
  /** An explicit commit-ish to start from. */
  readonly base?: string;
  /** Start from the repository's default branch, as local Git data records it. */
  readonly fromDefault?: boolean;
  /** Start from the source checkout's current commit. */
  readonly fromHead?: boolean;
  /** The directory to fork from; the caller's own working directory otherwise. */
  readonly from?: string;
  /** The session that will own the new checkout. */
  readonly session?: string;
}

/** What the caller must type to confirm a removal by hand. */
export const CONFIRMATION_WORD = 'remove';

/**
 * Which base the flags asked for, refusing two answers rather than silently preferring one.
 *
 * A caller who passes both `--base` and `--from-default` has said two different things, and picking
 * either would start their work from a commit they did not name.
 */
function requestedBase(options: WorktreeForkOptions): WorktreeBase {
  const named = [
    options.base === undefined ? '' : '--base',
    options.fromDefault === true ? '--from-default' : '',
    options.fromHead === true ? '--from-head' : '',
  ].filter(flag => flag !== '');
  if (named.length > 1) throw new Error(`pass only one of ${named.join(', ')}`);
  if (options.base !== undefined) return { kind: 'commit', reference: options.base };
  if (options.fromDefault === true) return { kind: 'default-branch' };
  if (options.fromHead === true) return { kind: 'head' };
  return { kind: 'auto' };
}

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
    /**
     * Where this invocation is standing.
     *
     * Passed in rather than read here, because the domain may not touch the runtime — and because it
     * is the ONE piece of removal evidence no daemon can collect for itself. It only ever adds a
     * refusal: the daemon reads it to refuse deleting the tree the caller is inside.
     */
    private readonly cwd: string,
  ) {}

  async list(options: WorktreeCommandOptions): Promise<void> {
    const response = await this.gateway.list();
    this.#report(response, options, () => renderWorktreeList(response));
  }

  async check(path: string, options: WorktreeCommandOptions): Promise<void> {
    const decision = await this.gateway.check(location(path), this.cwd);
    const uncleared = unclearedBlockers(decision, []);
    this.#report(decision, options, () => renderRemovalDecision(decision, uncleared));
  }

  /**
   * Removes a worktree, but only once every blocker is accounted for.
   *
   * The check happens first and its verdict is printed, so the caller sees exactly what they are
   * authorizing. Removing first and reporting afterwards is the wrong order for an irreversible
   * operation.
   */
  async remove(path: string, options: WorktreeRemoveOptions): Promise<void> {
    const target = location(path);
    const overrides = grantedOverrides(options);
    const confirmations = grantedConfirmations(options);
    const decision = await this.gateway.check(target, this.cwd);
    const uncleared = unclearedBlockers(decision, overrides);
    this.#reportPreflight(decision, uncleared, confirmations, options);
    if (uncleared.length > 0) throw new Error(blockedMessage(decision, uncleared));

    await this.#confirm(decision, options);
    const removed = await this.gateway.remove({
      path: target,
      overrides: [...overrides],
      deleteBranch: options.deleteBranch === true,
      confirmations: [...confirmations],
      currentWorkingDirectory: this.cwd,
    });
    this.#report(removed, options, () => renderRemoved(removed));
  }

  /** Forks a new checkout from a branch and a base, and says where to start work in it. */
  async fork(branch: string, options: WorktreeForkOptions): Promise<void> {
    const request: CreateWorktreeRequest = {
      sourcePath: options.from === undefined ? this.cwd : resolve(this.cwd, location(options.from)),
      branch: location(branch),
      base: requestedBase(options),
      ...(options.session === undefined ? {} : { sessionId: options.session }),
    };
    const created = await this.gateway.create(request);
    this.#report(created, options, () => renderCreated(created));
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

  /**
   * Emits the authorization evidence before either a prompt or a mutation.
   *
   * JSON stdout remains one final protocol payload. Its preflight is therefore one JSON object on
   * stderr, where it cannot be concatenated with the final `RemovedWorktree` and become invalid
   * JSON. Human mode prints the readable verdict on stdout in the order a person acts on it.
   */
  #reportPreflight(
    decision: WorktreeRemovalDecision,
    uncleared: readonly UnclearedBlocker[],
    confirmations: readonly BranchDeletionConfirmation[],
    options: WorktreeCommandOptions,
  ): void {
    if (options.json === true) {
      this.out.diagnostic(JSON.stringify({ phase: 'preflight', decision }));
      return;
    }
    this.out.success(renderRemovalDecision(decision, uncleared, confirmations));
  }
}

/** The message a refused removal fails with: every blocker, and the flag that clears each. */
function blockedMessage(decision: WorktreeRemovalDecision, uncleared: readonly UnclearedBlocker[]): string {
  return [`refusing to remove ${decision.path}:`, ...uncleared.map(renderBlocker)].join('\n');
}

/** A path or a branch, refused rather than sent as an empty parameter. */
function location(value: string): string {
  const path = value.trim();
  if (path === '') throw new Error('a worktree path is required');
  return path;
}
