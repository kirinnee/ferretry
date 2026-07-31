/** The narrow process seam required by the tmux domain. */
export interface TmuxCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Implemented by the process adapter; every command excludes the executable and socket flags. */
export interface TmuxCommandPort {
  execute(arguments_: readonly string[]): Promise<TmuxCommandResult>;
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
}
