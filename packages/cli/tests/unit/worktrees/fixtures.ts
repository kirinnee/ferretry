import type {
  CreatedWorktree,
  CreateWorktreeRequest,
  ManagedWorktreeView,
  RemovedWorktree,
  WorktreeListResponse,
  WorktreeLiveState,
  WorktreeRemovalBlocker,
  WorktreeRemovalDecision,
  WorktreeRemovalRequest,
} from '@ferretry/protocol';
import type { IWorktreePrompt } from '../../../src/lib/worktrees/controller';
import type { IWorktreeGateway, IWorktreeOutput } from '../../../src/lib/worktrees/ports';

export const WORKTREE_PATH = '/managed/ferretry-wt-cli6';
export const CALLER_CWD = '/repos/ferretry';

/** Captures what a controller printed, keeping stdout and warnings apart. */
export class CapturingOutput implements IWorktreeOutput {
  readonly lines: string[] = [];
  readonly warnings: string[] = [];
  readonly diagnostics: string[] = [];

  success(message: string): void {
    this.lines.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  diagnostic(message: string): void {
    this.diagnostics.push(message);
  }

  get text(): string {
    return this.lines.join('\n');
  }
}

export function live(overrides: Partial<WorktreeLiveState> = {}): WorktreeLiveState {
  return {
    head: 'b'.repeat(40),
    branch: 'port/cli-remaining',
    detached: false,
    status: {
      staged: false,
      unstaged: false,
      untracked: false,
      ignored: false,
      conflicted: false,
      dirtySubmodule: false,
      truncated: false,
    },
    upstream: 'origin/port/cli-remaining',
    ahead: 2,
    behind: 1,
    integrated: false,
    undetermined: [],
    ...overrides,
  };
}

export function worktree(overrides: Partial<ManagedWorktreeView> = {}): ManagedWorktreeView {
  return {
    path: WORKTREE_PATH,
    branch: 'port/cli-remaining',
    repositoryRoot: '/repos/ferretry',
    commonDirectory: '/repos/ferretry/.git',
    relativeCwd: '',
    createdAt: '2026-07-31T09:00:00.000Z',
    initialHead: 'a'.repeat(40),
    branchPreexisted: false,
    ownerSessionId: 'ms8ucu18-1eb5331d',
    ownerActive: true,
    sharedWith: [],
    live: live(),
    removal: decision(),
    ...overrides,
  };
}

/** `null` omits the managed root, which is how a daemon with none configured answers. */
export function listResponse(
  worktrees: readonly ManagedWorktreeView[] = [worktree()],
  managedRoot: string | null = '/managed',
): WorktreeListResponse {
  return { worktrees: [...worktrees], ...(managedRoot === null ? {} : { managedRoot }) };
}

export function blocker(overrides: Partial<WorktreeRemovalBlocker> = {}): WorktreeRemovalBlocker {
  return {
    code: 'unstaged_changes',
    message: 'the worktree has uncommitted edits',
    override: 'discard_worktree_changes',
    ...overrides,
  };
}

export function decision(overrides: Partial<WorktreeRemovalDecision> = {}): WorktreeRemovalDecision {
  return {
    removable: true,
    path: WORKTREE_PATH,
    branch: 'port/cli-remaining',
    head: 'b'.repeat(40),
    upstream: 'origin/port/cli-remaining',
    blockers: [],
    branchDeletion: { deletable: true, blockers: [] },
    ...overrides,
  };
}

export function removed(overrides: Partial<RemovedWorktree> = {}): RemovedWorktree {
  return {
    path: WORKTREE_PATH,
    branch: 'port/cli-remaining',
    branchRetained: true,
    removedAt: '2026-07-31T10:00:00.000Z',
    branchBlockers: [],
    ...overrides,
  };
}

export function created(overrides: Partial<CreatedWorktree> = {}): CreatedWorktree {
  return {
    worktree: worktree({ path: '/managed/ferretry-new', branch: 'feat/new' }),
    cwd: '/managed/ferretry-new/packages/cli',
    ...overrides,
  };
}

/** A prompt that answers with a scripted reply and records what it was asked. */
export class ScriptedPrompt implements IWorktreePrompt {
  readonly asked: string[] = [];

  constructor(private readonly answer = 'remove') {}

  ask(message: string): Promise<string> {
    this.asked.push(message);
    return Promise.resolve(this.answer);
  }
}

/** A gateway answering from fixed views and recording what was asked of it. */
export class RecordingWorktreeGateway implements IWorktreeGateway {
  readonly checked: { path: string; cwd?: string }[] = [];
  readonly removals: WorktreeRemovalRequest[] = [];
  readonly creations: CreateWorktreeRequest[] = [];

  constructor(
    private readonly views: {
      list?: WorktreeListResponse;
      decision?: WorktreeRemovalDecision;
      removed?: RemovedWorktree;
      created?: CreatedWorktree;
    } = {},
  ) {}

  list(): Promise<WorktreeListResponse> {
    return Promise.resolve(this.views.list ?? listResponse());
  }

  check(path: string, cwd?: string): Promise<WorktreeRemovalDecision> {
    this.checked.push({ path, ...(cwd === undefined ? {} : { cwd }) });
    return Promise.resolve(this.views.decision ?? decision());
  }

  remove(request: WorktreeRemovalRequest): Promise<RemovedWorktree> {
    this.removals.push(request);
    return Promise.resolve(this.views.removed ?? removed());
  }

  create(request: CreateWorktreeRequest): Promise<CreatedWorktree> {
    this.creations.push(request);
    return Promise.resolve(this.views.created ?? created());
  }
}
