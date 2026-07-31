import type { IWorktreePrompt } from '../../../src/lib/worktrees/controller';
import type { IWorktreeGateway, IWorktreeOutput } from '../../../src/lib/worktrees/ports';
import type {
  ManagedWorktreeView,
  RemovedWorktree,
  WorktreeListResponse,
  WorktreeRemovalBlocker,
  WorktreeRemovalDecision,
  WorktreeRemovalRequest,
} from '../../../src/lib/worktrees/wire';

export const WORKTREE_PATH = '/managed/ferretry-wt-cli6';

/** Captures what a controller printed, keeping stdout and warnings apart. */
export class CapturingOutput implements IWorktreeOutput {
  readonly lines: string[] = [];
  readonly warnings: string[] = [];

  success(message: string): void {
    this.lines.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  get text(): string {
    return this.lines.join('\n');
  }
}

export function worktree(overrides: Partial<ManagedWorktreeView> = {}): ManagedWorktreeView {
  return {
    path: WORKTREE_PATH,
    branch: 'port/cli-remaining',
    repositoryRoot: '/repos/ferretry',
    createdAt: '2026-07-31T09:00:00.000Z',
    initialHead: 'a'.repeat(40),
    branchPreexisted: false,
    ownerSessionId: 'ms8ucu18-1eb5331d',
    ownerActive: true,
    sharedWith: [],
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
    ...overrides,
  };
}

export function removed(overrides: Partial<RemovedWorktree> = {}): RemovedWorktree {
  return {
    path: WORKTREE_PATH,
    branch: 'port/cli-remaining',
    branchRetained: true,
    removedAt: '2026-07-31T10:00:00.000Z',
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
  readonly checked: string[] = [];
  readonly removals: WorktreeRemovalRequest[] = [];

  constructor(
    private readonly views: {
      list?: WorktreeListResponse;
      decision?: WorktreeRemovalDecision;
      removed?: RemovedWorktree;
    } = {},
  ) {}

  list(): Promise<WorktreeListResponse> {
    return Promise.resolve(this.views.list ?? listResponse());
  }

  check(path: string): Promise<WorktreeRemovalDecision> {
    this.checked.push(path);
    return Promise.resolve(this.views.decision ?? decision());
  }

  remove(request: WorktreeRemovalRequest): Promise<RemovedWorktree> {
    this.removals.push(request);
    return Promise.resolve(this.views.removed ?? removed());
  }
}
