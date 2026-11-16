import type { FencedPath } from '../bound.ts';
import type { RootHandle } from './roots.ts';

/**
 * A folder of one of THIS plugin's own root handles, named the way every root call names one: the kernel resolves it
 * (links followed, fenced, checked to be an existing folder inside the root) and judges with ITS real path, so a
 * plugin cannot point a {@link ProcessesPort} question at a folder it does not hold.
 */
export interface OwnFolder {
  readonly root: RootHandle;
  readonly path: FencedPath;
}

/** What a process signal came to: sent, the process was already gone, or the kernel would not send it. */
export type ProcessSignalOutcome = 'signalled' | 'gone' | 'refused';

/**
 * This user's live processes, for a plugin that must stop what a child it started left behind (Runtimes: an ended
 * Codex ferret's app-server pair). Only for a manifest with `permissions.processes`; every member of any other
 * plugin's port is refused naming it. Today's Codex stopper's rules, held by the kernel so a plugin cannot widen them:
 *
 * - **Pids and yes/no only.** No member returns a command line, a program name or an environment: the kernel reads
 *   `environ` and `cmdline` itself and answers with pids and booleans, so another process's secrets never cross.
 * - **No guessing oracle.** `usersOf` asks only for a variable the manifest lists in `permissions.processes.environment`,
 *   and its value is never free text: it is the real path of a folder of the plugin's OWN root.
 * - **This user's processes only** (the daemon's uid), and never pid 0 or 1, the daemon itself or its ancestors.
 * - **SIGTERM only**, and only to a process whose command line, read again right before the signal, still starts
 *   with the real path of `under` plus `/`. A pid reused between that check and the signal is the one residual
 *   (declared: no pidfd binding).
 * - A question the host cannot answer is `undefined` or `false`, which a caller reads as "leave it running".
 */
export interface ProcessesPort {
  /**
   * Whether a live process of this user runs from beneath `under`: its command line starts with the folder's real
   * path (or the path as the root names it) plus `/`. `false` for a process that is gone, another user's, unreadable,
   * or one the kernel never signals. The command line itself is never returned.
   */
  runsFrom(pid: number, under: OwnFolder): Promise<boolean>;
  /**
   * The pids of this user's live processes whose environment holds EXACTLY `variable=<the folder's path>`, or
   * `undefined` when the host cannot say (which a caller reads as "somebody might"). Refused (throws) for a variable
   * the manifest does not list, or a folder that is not this plugin's own.
   */
  usersOf(variable: string, value: OwnFolder): Promise<readonly number[] | undefined>;
  /**
   * SIGTERM one process, only if it {@link runsFrom} `under` at the moment of the signal. `refused` for a pid the
   * kernel never signals or one that no longer runs from there (a reused pid); `gone` when it had already exited.
   */
  terminate(pid: number, under: OwnFolder): Promise<ProcessSignalOutcome>;
}
