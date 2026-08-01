/** The narrow process seam required by the tmux domain. */
export interface TmuxCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Implemented by the process adapter; every command excludes the executable and socket flags. */
export interface TmuxCommandPort {
  /**
   * Run one tmux command.
   *
   * `stdin` exists for `load-buffer -`, the only command here that carries a payload rather than a
   * target: a turn brief is longer than any argv limit and would be world-readable through `/proc`
   * if it were passed as an argument.
   */
  execute(arguments_: readonly string[], stdin?: string): Promise<TmuxCommandResult>;
}

export interface PaneMetadata {
  readonly dead: boolean;
  readonly exitCode?: number;
  readonly cursorX?: number;
  readonly cursorY?: number;
  readonly height?: number;
  readonly width?: number;
}

export interface PaneState extends PaneMetadata {
  readonly alive: boolean;
  readonly promptReady: boolean;
  readonly history: string;
  readonly visible: string;
}

export interface TmuxLaunch {
  readonly session: string;
  readonly cwd: string;
  readonly command: readonly [string, ...string[]];
  readonly width?: number;
  readonly height?: number;
  /**
   * Environment set on the tmux session itself, for values the launched program must read from its
   * ENVIRONMENT rather than its argv.
   *
   * It exists because a per-session secret has nowhere else to travel: argv is world-readable
   * through `/proc`, and the agent wrappers this daemon launches read their board capability from
   * `FY_SESSION_BOARD_CAPABILITY`. Every entry becomes one `-e NAME=VALUE` on `new-session`, so a
   * value never reaches a shell for word-splitting or expansion.
   */
  readonly env?: Readonly<Record<string, string>>;
}
