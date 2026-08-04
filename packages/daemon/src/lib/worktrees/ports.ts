/**
 * A directory a child is to be started in, held OPEN rather than named.
 *
 * `install` puts the already-open directory in place as the working directory of the runtime itself and
 * returns the undo. A child started while it is installed inherits it, so no name is resolved between
 * the walk that proved containment and the tree the child reads — which is the only way to hand a
 * descriptor to Git, a capability that speaks nothing but paths.
 *
 * INSTALLING IT IS GLOBAL, so the contract is narrow and absolute: a caller must install, start the
 * child, and release WITHOUT awaiting in between. A bracket that spans an await is visible to every
 * other request in flight and is a bug in the caller, not a tunable.
 */
export interface PinnedWorkingDirectory {
  /** Where the pin resolves to right now. Diagnostics and messages only — never reopened. */
  readonly describe: string;
  /** Installs the held directory and returns its undo, both synchronous. */
  install(): () => void;
}

/**
 * Where a Git child runs: a NAME, or a directory held open.
 *
 * Worktree orchestration passes names because a name is all it has — it creates and inspects
 * directories rather than confining reads to one. The working-tree viewer passes a pin, because a name
 * is only a claim about the past: renamed away and replaced with a symlink between validation and
 * spawn, it makes Git read a different tree than the one whose paths passed containment and the
 * secrets gates.
 */
export type GitWorkingDirectory = string | PinnedWorkingDirectory;

export interface GitInvocation {
  readonly args: readonly string[];
  /**
   * Working directory for the child.
   *
   * A caller reached from HTTP MUST pass a {@link PinnedWorkingDirectory} rather than a configured
   * pathname, for the reason spelled out there.
   */
  readonly cwd: GitWorkingDirectory;
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
