/**
 * Every tunable the lifecycle owns, injected rather than hard-coded, so a deployment can move the
 * tmux namespace or the retry budget without a code change and a test can pin them.
 */
export interface SessionLifecycleSettings {
  /** Namespace for managed tmux sessions. Keeps our panes distinguishable from every other server. */
  readonly tmuxSessionPrefix: string;
  /** tmux refuses long session names; a valid session id must never yield an unlaunchable pane. */
  readonly maxTmuxSessionNameLength: number;
  /** How many times a launch may be attempted before the session is recorded as failed. */
  readonly launchAttempts: number;
  /** Reason recorded when a client stops a session without giving one. */
  readonly defaultStopReason: string;
  /**
   * How long a stop waits for a launch THIS process has in flight before it answers "pending".
   *
   * A launch holds the session's queue until it settles, and a stop queued behind one that never does
   * would never answer. Short enough to answer inside a client's request timeout; a stop with no launch
   * in flight waits for nothing.
   */
  readonly stopLaunchWaitMs: number;
  /**
   * A version-1 fleet auto-wrapper basename (`claude-auto-<name>`). Without a launcher rule the
   * lifecycle is a remote shell — `agent: '/bin/sh'` would be accepted verbatim.
   */
  readonly agentWrapperPattern: RegExp;
  /**
   * A version-2 runtime launcher: the ABSOLUTE path of a wrapper the fleet generated, which always
   * lives directly in a fleet's `bin` directory and is named by the runtime-name grammar (R1). A
   * runtime's name is free text, so its basename alone cannot say it is a launcher; where it lives
   * can. `/bin/sh` and a relative `sh` both fail it.
   */
  readonly runtimeLauncherPattern: RegExp;
}

export const defaultSessionLifecycleSettings: SessionLifecycleSettings = {
  tmuxSessionPrefix: 'fy-',
  maxTmuxSessionNameLength: 80,
  launchAttempts: 3,
  defaultStopReason: 'stopped by client',
  stopLaunchWaitMs: 45_000,
  agentWrapperPattern: /^(?:claude|codex)-auto-[a-z0-9][a-z0-9-]*$/u,
  runtimeLauncherPattern: /^\/(?:(?!\.\.?\/)[^/\0]+\/)*fleet\/bin\/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u,
};
