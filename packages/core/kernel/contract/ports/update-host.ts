/** What the running daemon executable is (today's update install facts seams). */
export interface ExecutableFacts {
  /** `process.argv0`: the path the daemon was launched as (a link the install made, often). */
  readonly argv0: string;
  /** `process.execPath`: the executable itself. */
  readonly execPath: string;
  /** `execPath` with every link resolved; `execPath` itself when it cannot be resolved. */
  readonly resolvedExecPath: string;
  /** `Bun.main`: `/$bunfs/…` inside a compiled binary, a source file otherwise. */
  readonly main: string;
  readonly workingDirectory: string;
  readonly platform: string;
}

export type UpdateLaunchOutcome = { readonly kind: 'started' } | { readonly kind: 'failed'; readonly reason: string };

/**
 * The daemon's own update seam (today's `DaemonUpdateService` host parts): the release this build carries, what the
 * running executable is, and one launch: `<fy> update --run --to <target> --report <report>` (the verb is the host's
 * `UPDATE_LAUNCH_VERB`), detached in its own process group so it survives the daemon's restart. The plugin's declared
 * state files `report` and `log` (its manifest `data.state`) say where the report is written and the output is
 * appended; the host spells neither path. No other command.
 */
export interface UpdateHostPort {
  /** The release number this build carries. */
  readonly release: string;
  /** Whether this is a compiled release (a source run has no release to compare with). */
  readonly compiled: boolean;
  /**
   * Whether the daemon asks GitHub for a newer release: a compiled build AND `FY_UPDATE_CHECK` not `off` (the
   * operator / CI switch). The kernel reads the switch, so the plugin never reads the environment.
   */
  readonly checks: boolean;
  executable(): Promise<ExecutableFacts>;
  /** `target` is a release number (`5.1.0`, `v5.1.0-rc.1`); anything else is refused without a launch. */
  launchUpdate(target: string): Promise<UpdateLaunchOutcome>;
}
