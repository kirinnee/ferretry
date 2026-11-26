/**
 * Finding and stopping a Chrome a dead daemon left behind on the shared agent profile.
 *
 * Ferretry only ever stops a process it can PROVE it started: the lease record names the Chrome's pid AND the
 * start time it had when Ferretry launched it (read in the same synchronous step as the spawn), and the process now
 * running under that pid must show the same start time and a command line naming this exact `--user-data-dir`. A
 * flag alone proves nothing (the owner's own browser may be on the profile), and a pid alone proves nothing (it may
 * have been recycled). Anything that cannot be read is refused, never signalled.
 *
 * The identity is re-read and compared INSIDE the signal call (`signalIf`), with no `await` between the comparison
 * and the kill, so a process that exited and was replaced between TERM and KILL is never signalled.
 *
 * GAP: Bun exposes no pidfd (`pidfd_open` / `pidfd_send_signal`), so the kernel can still hand the pid to another
 * process between the last `/proc` read and the `kill(2)` that follows it by a few microseconds. That needs the
 * pid space to wrap and one specific pid to be reused inside that gap; with Linux's `pid_max` it is practically
 * unreachable, and it is the only window left.
 */

/** What the process table says about one pid, read as one unit. */
export interface ProcessIdentity {
  /** An opaque stamp of when this exact process started; a replacement process under the same pid differs. */
  readonly startedAt: string;
  /** The process's arguments, split exactly as it was started (empty when it cannot be read). */
  readonly args: readonly string[];
}

/**
 * - `delivered`: the identity was accepted and the signal sent.
 * - `gone`: the process is not there (or is a zombie): nothing to signal.
 * - `denied`: the identity was accepted but the system refused the signal.
 * - `rejected`: the process is there and readable, and `accept` said it is not the one to stop: NOT signalled.
 * - `unreadable`: its identity could not be read, so nothing proves what it is: NOT signalled.
 */
export type SignalOutcome = 'delivered' | 'gone' | 'denied' | 'rejected' | 'unreadable';

export interface OrphanChromeInspector {
  /** The live process under `pid`, or `undefined` when it is gone, a zombie, or cannot be read. Synchronous. */
  readonly identify: (pid: number) => ProcessIdentity | undefined;
  /**
   * Reads the identity of `pid` NOW and signals it only if `accept` approves that identity — one synchronous step,
   * with nothing awaited between the comparison and the signal.
   */
  readonly signalIf: (
    pid: number,
    signal: 'SIGTERM' | 'SIGKILL',
    accept: (identity: ProcessIdentity) => boolean,
  ) => SignalOutcome;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

/** The Chrome a lease names: its pid and the start time recorded when Ferretry launched it. */
export interface RecordedChrome {
  readonly pid: number;
  readonly startedAt?: string;
}

export interface StopBudget {
  /** How many 25 ms polls to wait after SIGTERM before SIGKILL. */
  readonly termPolls: number;
  /** How many 25 ms polls to wait after SIGKILL before giving up. */
  readonly killPolls: number;
}

const POLL_MILLISECONDS = 25;
const DEFAULT_BUDGET: StopBudget = { termPolls: 80, killPolls: 40 };

/** Whether `args` run Chrome on exactly `profile`. */
function holdsProfile(args: readonly string[], profile: string): boolean {
  return args.some(arg => arg === `--user-data-dir=${profile}` || arg === `--user-data-dir=${profile}/`);
}

/**
 * Clears the Chrome a dead lease named: `cleared` when it is gone, was never ours to stop (the pid now belongs to
 * another process, nothing signalled), or has exited; `refused` when it may be live and Ferretry cannot prove it
 * started it.
 */
export async function clearRecordedChrome(
  inspector: OrphanChromeInspector,
  chrome: RecordedChrome,
  profile: string,
  budget: StopBudget = DEFAULT_BUDGET,
): Promise<'cleared' | 'refused'> {
  const first = inspector.identify(chrome.pid);
  if (first === undefined) return 'refused';
  if (chrome.startedAt === undefined) {
    // No launch record: a process on this profile may be the owner's own browser, so it is never signalled.
    // One whose readable command line is elsewhere cannot be a Chrome on this profile at all.
    return first.args.length > 0 && !holdsProfile(first.args, profile) ? 'cleared' : 'refused';
  }
  const launched = chrome.startedAt;
  if (first.startedAt !== launched) return 'cleared';
  const ours = (identity: ProcessIdentity): boolean =>
    identity.startedAt === launched && holdsProfile(identity.args, profile);
  const stages = [
    { signal: 'SIGTERM', polls: budget.termPolls },
    { signal: 'SIGKILL', polls: budget.killPolls },
  ] as const;
  for (const stage of stages) {
    const sent = inspector.signalIf(chrome.pid, stage.signal, ours);
    if (sent === 'gone') return 'cleared';
    if (sent === 'denied' || sent === 'unreadable') return 'refused';
    if (sent === 'rejected') {
      // Another process under the pid is cleared (never signalled); the same process off this profile is refused.
      const now = inspector.identify(chrome.pid);
      return now === undefined || now.startedAt !== launched ? 'cleared' : 'refused';
    }
    for (let poll = 0; poll < stage.polls; poll += 1) {
      await inspector.sleep(POLL_MILLISECONDS);
      const after = inspector.identify(chrome.pid);
      if (after === undefined || after.startedAt !== launched) return 'cleared';
    }
  }
  return 'refused';
}
