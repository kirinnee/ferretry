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
   * The only programs the daemon may launch: a fleet auto-wrapper basename. Without this the
   * lifecycle is a remote shell — `agent: '/bin/sh'` would be accepted verbatim.
   */
  readonly agentWrapperPattern: RegExp;
}

export const defaultSessionLifecycleSettings: SessionLifecycleSettings = {
  tmuxSessionPrefix: 'fy-',
  maxTmuxSessionNameLength: 80,
  launchAttempts: 3,
  defaultStopReason: 'stopped by client',
  agentWrapperPattern: /^(?:claude|codex)-auto-[a-z0-9][a-z0-9-]*$/u,
};
