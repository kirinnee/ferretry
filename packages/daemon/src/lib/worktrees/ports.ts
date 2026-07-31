export interface GitInvocation {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
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
