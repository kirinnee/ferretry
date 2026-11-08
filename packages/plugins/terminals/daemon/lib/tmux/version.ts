/**
 * Which tmux release a host runs, and whether it has the subscription crash.
 *
 * THE CRASH. tmux before 3.7 dereferences a NULL session in `control_check_subs_timer` when a control
 * client holding a `refresh-client -B` subscription outlives its session — and that ends the WHOLE
 * server, every pane on it. Every session worker holds such a subscription, so on 3.6a the end of any
 * one session could end every other. This daemon releases the subscriptions before every kill
 * (`releasedKillArguments`), which closes the window it controls; 3.7 removes the bug itself.
 */

/** A tmux release as `tmux -V` or `#{version}` prints it. */
export interface TmuxVersion {
  /** The release as printed, `3.6a` or `next-3.7`. */
  readonly label: string;
  readonly major: number;
  readonly minor: number;
}

/** The first release without the subscription crash. */
const SUBSCRIPTION_CRASH_FIXED_IN = { major: 3, minor: 7 } as const;

const VERSION = /^(?:tmux\s+)?((?:next-|openbsd-)?(\d+)\.(\d+)[a-z]?(?:-rc\d*)?)$/u;

/** `tmux 3.6a`, `3.8`, `next-3.7` → its release; anything else → `undefined`, never a guess. */
export function parseTmuxVersion(text: string): TmuxVersion | undefined {
  const match = VERSION.exec(text.trim());
  if (match === null) return undefined;
  return { label: match[1] ?? text.trim(), major: Number(match[2]), minor: Number(match[3]) };
}

/** Whether `version` is a release that can crash its whole server when a watched session ends. */
export function hasSubscriptionCrash(version: TmuxVersion): boolean {
  if (version.major !== SUBSCRIPTION_CRASH_FIXED_IN.major) return version.major < SUBSCRIPTION_CRASH_FIXED_IN.major;
  return version.minor < SUBSCRIPTION_CRASH_FIXED_IN.minor;
}

/**
 * What a host said about its tmux, as printed: the INSTALLED program (`tmux -V`) and the RUNNING
 * server of this daemon (`#{version}`). They differ after an upgrade until the server next starts —
 * a running server keeps the binary it was started from — and the server is the one that crashes.
 * Absent means it could not be asked: no program, or no server running.
 */
export interface TmuxReleaseReading {
  readonly program?: string;
  readonly server?: string;
}

/** What the doctor says about a reading: ok, a warning that names the fix, or a failure when tmux cannot be asked at all. */
export interface TmuxReleaseVerdict {
  readonly state: 'ok' | 'warn' | 'fail';
  readonly detail: string;
  readonly fix?: string;
}

/**
 * Judges what tmux said about itself. Only release NAMES appear in the words (`3.6a`), never a path or a value. An
 * absent server is not a problem (none is running until a ferret starts one); an absent program is.
 */
export function judgeTmuxRelease(reading: TmuxReleaseReading): TmuxReleaseVerdict {
  const program = reading.program === undefined ? undefined : parseTmuxVersion(reading.program);
  const server = reading.server === undefined ? undefined : parseTmuxVersion(reading.server);
  if (reading.program === undefined || program === undefined)
    return {
      state: 'fail',
      detail: 'tmux did not answer `tmux -V`',
      fix: 'install tmux and put it on the daemon PATH',
    };
  const crashing = [program, server].filter(
    (version): version is TmuxVersion => version !== undefined && hasSubscriptionCrash(version),
  );
  if (crashing.length > 0)
    return {
      state: 'warn',
      detail: `tmux ${crashing.map(version => version.label).join(' / ')} can end every pane when one session ends; the daemon releases subscriptions first`,
      fix: 'upgrade tmux to 3.7 or later',
    };
  if (server !== undefined && server.label !== program.label)
    return {
      state: 'warn',
      detail: `the running tmux server is ${server.label}, the installed tmux is ${program.label}`,
      fix: 'the server picks up the installed release the next time it starts',
    };
  return {
    state: 'ok',
    detail: `tmux ${program.label}${server === undefined ? ', no server running' : ', server current'}`,
  };
}
