/**
 * Finding and stopping a Chrome a dead daemon left behind on the shared agent profile.
 *
 * Ferretry only ever stops a process it can PROVE it started: the lease record names the Chrome's pid AND the
 * start time it had when Ferretry launched it, and the process now running under that pid must show the same start
 * time and a command line naming this exact `--user-data-dir`. A flag alone proves nothing (the owner's own browser
 * may be on the profile), and a pid alone proves nothing (it may have been recycled). The identity is read again
 * immediately before EACH signal, so a process that exited and was replaced between TERM and KILL is never
 * signalled. Anything that cannot be read is refused, never signalled.
 *
 * GAP: without a pidfd (not reachable from Bun) a signal still follows its identity re-check by a few
 * microseconds; the start time moves the window from "any pid reuse ever" to "a replacement inside that gap".
 */

/** What the process table says about one pid, read as one unit. */
export interface ProcessIdentity {
  /** An opaque stamp of when this exact process started; a replacement process under the same pid differs. */
  readonly startedAt: string;
  /** The process's arguments, split exactly as it was started (empty when it cannot be read). */
  readonly args: readonly string[];
}

export type SignalOutcome = 'delivered' | 'gone' | 'denied';

export interface OrphanChromeInspector {
  /** The live process under `pid`, or `undefined` when it is gone, a zombie, or cannot be read. */
  readonly identify: (pid: number) => Promise<ProcessIdentity | undefined>;
  readonly signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => SignalOutcome;
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
  const first = await inspector.identify(chrome.pid);
  if (first === undefined) return 'refused';
  if (chrome.startedAt === undefined) {
    // No launch record: a process on this profile may be the owner's own browser, so it is never signalled.
    // One whose readable command line is elsewhere cannot be a Chrome on this profile at all.
    return first.args.length > 0 && !holdsProfile(first.args, profile) ? 'cleared' : 'refused';
  }
  const launched = chrome.startedAt;
  if (first.startedAt !== launched) return 'cleared';
  const stages = [
    { signal: 'SIGTERM', polls: budget.termPolls },
    { signal: 'SIGKILL', polls: budget.killPolls },
  ] as const;
  for (const stage of stages) {
    const current = await inspector.identify(chrome.pid);
    if (current === undefined || current.startedAt !== launched) return 'cleared';
    if (!holdsProfile(current.args, profile)) return 'refused';
    const sent = inspector.signal(chrome.pid, stage.signal);
    if (sent === 'gone') return 'cleared';
    if (sent === 'denied') return 'refused';
    for (let poll = 0; poll < stage.polls; poll += 1) {
      await inspector.sleep(POLL_MILLISECONDS);
      const after = await inspector.identify(chrome.pid);
      if (after === undefined || after.startedAt !== launched) return 'cleared';
    }
  }
  return 'refused';
}
