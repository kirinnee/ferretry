export interface GitInvocation {
  readonly args: readonly string[];
  /**
   * Working directory for the child.
   *
   * A caller reached from HTTP MUST pass a PINNED path — one that resolves to an already-open descriptor —
   * rather than a configured pathname. A pathname is only a claim about the past: renamed away and
   * replaced with a symlink between validation and spawn, it makes Git operate on a different tree than
   * the one whose paths passed containment and the secrets gates.
   */
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  /** Bytes piped to stdin. Used by the commands that take a NUL-separated batch of paths that way. */
  readonly stdin?: Uint8Array;
  /**
   * Whether pathspecs are forced literal. Defaults to true.
   *
   * Off only for `check-ignore`, which errors on `literal` pathspec magic. A caller that turns it off must
   * defuse the magic itself — `./`-prefixing every path is how this repository does it.
   */
  readonly literalPathspecs?: boolean;
}

export interface GitExecution {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
}

/** The only process capability available to worktree orchestration. */
export interface GitRunner {
  run(invocation: GitInvocation): Promise<GitExecution>;
}

export type WorktreeFileType = 'directory' | 'file' | 'symlink' | 'other' | 'missing';

export interface WorktreeFileSystem {
  makeDirectory(target: string, mode: number): Promise<void>;
  realPath(target: string): Promise<string>;
  type(target: string): Promise<WorktreeFileType>;
  readText(target: string): Promise<string>;
  writeText(target: string, content: string, mode: number): Promise<void>;
}

export interface WorktreeClock {
  nowIso(): string;
}
