import type { TmuxControlNotification } from './control-protocol.ts';

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
   * `stdin` exists for `load-buffer -`: a turn brief is longer than any argv limit and would be
   * world-readable through `/proc` if it were passed as an argument. A command whose ARGUMENTS carry a
   * payload — a pane's environment, typed keys — is moved onto stdin by the adapter itself
   * (`script.ts`), so callers keep passing ordinary argv.
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

/**
 * One question's worth of a pane: its metadata, plus what moves whenever it draws anything.
 *
 * `activityAt` is tmux's `#{window_activity}` — the UNIX second the window last received output,
 * stamped on every write whatever `monitor-activity` says — and `historySize` the scrollback's line
 * count. Together with the cursor and the size they are what lets a reader tell, without capturing,
 * that a frame it already holds is still the frame on screen.
 */
export interface PaneActivity extends PaneMetadata {
  readonly activityAt?: number;
  readonly historySize?: number;
  readonly paneId?: string;
  readonly pid?: number;
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
   * value never reaches a shell for word-splitting or expansion — and because `-e` is itself an
   * argument, the command adapter sends a `new-session` that has one as a script on stdin
   * (`script.ts`), so the values are in no process's argv either, the tmux server's included.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/** Which notifications a subscriber wants: those naming this pane, this session, or (empty) all. */
export interface TmuxEventFilter {
  readonly paneId?: string;
  readonly sessionId?: string;
}

/**
 * tmux's own notifications, as a stream a watcher subscribes to instead of polling.
 *
 * Keyed by tmux's ids (`%n` panes, `$n` sessions) rather than names, so routing a pane's events to
 * whatever owns that pane needs no state beyond the subscription itself.
 */
export interface TmuxEventSource {
  subscribe(listener: (notification: TmuxControlNotification) => void, filter?: TmuxEventFilter): () => void;
}
