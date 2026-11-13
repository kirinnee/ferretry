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

/** Today's `TMUX_CRASH` (`R/packages/daemon/src/lib/core/doctor.ts`), word for word. */
const TMUX_CRASH =
  'tmux before 3.7 can crash its whole server — ending every session at once — when a session ends while Ferretry is watching it. Ferretry works around it, but only a newer tmux removes it.';

/** How to move without ending anything: the running server keeps its binary until it next starts (today's `TMUX_MOVE`). */
const TMUX_MOVE =
  'Do not kill the tmux server to switch: the new release is used the next time the server starts — once the last session has ended, or the machine restarts.';

/**
 * The `tmux release` row as today's doctor judged it: `present` or `missing`, its summary and its impact. A
 * `capability` row, never `required`: tmux 3.6a starts and manages sessions, so the row never makes a host not ready.
 */
export interface TmuxReleaseRow {
  readonly status: 'present' | 'missing';
  readonly summary: string;
  readonly impact: string;
}

/**
 * WHICH TMUX, AND WHETHER IT HAS THE SUBSCRIPTION CRASH (today's `tmuxRelease`, copied).
 *
 * The RUNNING server is judged as well as the installed program, because they differ after an
 * upgrade: a server keeps the binary it was started from, and the server is what crashes. So a host
 * that installed 3.7 is still told the truth while its 3.6a server is up — and told that nothing has
 * to be stopped for the new release to take over.
 *
 * NO ROW (`undefined`) when neither answer came back: tmux could not be asked, and the doctor says nothing it did
 * not hear. Only release NAMES appear in the words (`3.6a`), never a path or a value.
 */
export function tmuxReleaseRow(reading: TmuxReleaseReading | undefined): TmuxReleaseRow | undefined {
  const read = (text: string | undefined): TmuxVersion | undefined =>
    text === undefined ? undefined : parseTmuxVersion(text);
  const program = read(reading?.program);
  const server = read(reading?.server);
  if (program === undefined && server === undefined) return undefined;
  const parts = [
    ...(program === undefined ? [] : [`installed ${program.label}`]),
    ...(server === undefined ? [] : [`running server ${server.label}`]),
  ];
  const summary = parts.join(', ');
  const programCrashes = program !== undefined && hasSubscriptionCrash(program);
  const serverCrashes = server !== undefined && hasSubscriptionCrash(server);
  if (!programCrashes && !serverCrashes)
    return { status: 'present', summary, impact: 'tmux 3.7 or newer: no known whole-server crash.' };
  if (!programCrashes)
    return {
      status: 'missing',
      summary: `${summary} — the server still runs the old release`,
      impact: `${TMUX_CRASH} ${program === undefined ? '' : `${program.label} is installed already. `}${TMUX_MOVE}`,
    };
  return {
    status: 'missing',
    summary: `${summary} — 3.7 or newer is needed`,
    impact: `${TMUX_CRASH} Install tmux 3.7 or newer. ${TMUX_MOVE}`,
  };
}

/** The row's text as today's `renderDoctorReport` printed it after the label: a missing row adds its impact. */
export function renderTmuxReleaseRow(row: TmuxReleaseRow): string {
  return row.status === 'missing' ? `${row.summary} — ${row.impact}` : row.summary;
}
