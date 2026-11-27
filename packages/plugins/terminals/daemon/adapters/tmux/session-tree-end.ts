import type { PaneProcessHost } from './tmux-runner.ts';

/**
 * Ending a ferret's pane is not the same as ending its tmux session. `kill-session` sends the pane's process a SIGHUP and
 * says nothing more: an agent that ignores it (or a helper such as `fy mcp serve` that was reparented) keeps running, and
 * so does the `systemd-run` scope around it, for as long as one process is left in it. A stop therefore NAMES every
 * process under the session's panes BEFORE the kill (afterwards the survivors are children of init and no tree leads to
 * them), and after the kill ends every one of them still running (SIGTERM, then SIGKILL), or says it could not.
 */

/** One process of a session, by pid AND start: a reused pid is not the process that was named. */
export interface DoomedProcess {
  readonly pid: number;
  readonly start: number;
}

export interface TreeEndTimes {
  /** How long a process is given to leave after the session was killed, then after SIGTERM, then after SIGKILL. */
  readonly stepMs: number;
  readonly pollMs: number;
}

export const DEFAULT_TREE_END_TIMES: TreeEndTimes = Object.freeze({ stepMs: 2_000, pollMs: 50 });

/**
 * Every process in the trees of `roots`, the roots included, and every other process of the Linux scope a root sits in (a
 * helper reparented to init is in no tree but still in the scope), minus this daemon and its parents AND everything that
 * runs beneath them: a daemon started from inside a pane is a descendant of that pane, and so are its own children.
 */
export async function nameDoomed(host: PaneProcessHost, roots: readonly number[]): Promise<readonly DoomedProcess[]> {
  const protectedPids = new Set(await host.protectedPids().catch(() => []));
  const named = new Map<number, number>();
  for (const root of roots) {
    if (!Number.isSafeInteger(root) || root <= 1 || protectedPids.has(root)) continue;
    const start = await host.startOf(root).catch(() => undefined);
    if (start === undefined) continue;
    named.set(root, start);
    const tree = await host.tree(root).catch(() => undefined);
    if (tree !== undefined && tree.kind === 'read') {
      // Rows are parents before children, so one pass prunes a whole subtree under a protected (or pruned) node.
      const pruned = new Set(protectedPids);
      for (const row of tree.rows) {
        if (pruned.has(row.pid) || pruned.has(row.ppid)) pruned.add(row.pid);
        else if (row.pid > 1) named.set(row.pid, row.start);
      }
    }
    // The scope cannot tell this daemon's own children from a helper's, so a scope the daemon sits in is not swept.
    const members = (await host.scopeMembers?.(root).catch(() => undefined)) ?? [];
    if (members.some(pid => protectedPids.has(pid))) continue;
    for (const pid of members) {
      if (!Number.isSafeInteger(pid) || pid <= 1 || named.has(pid)) continue;
      const memberStart = await host.startOf(pid).catch(() => undefined);
      if (memberStart !== undefined) named.set(pid, memberStart);
    }
  }
  return [...named].map(([pid, start]) => ({ pid, start }));
}

async function stillRunning(
  host: PaneProcessHost,
  doomed: readonly DoomedProcess[],
): Promise<readonly DoomedProcess[]> {
  const left: DoomedProcess[] = [];
  for (const process of doomed) {
    const start = await host.startOf(process.pid).catch(() => undefined);
    if (start === process.start) left.push(process);
  }
  return left;
}

async function untilGone(
  host: PaneProcessHost,
  doomed: readonly DoomedProcess[],
  sleep: (ms: number) => Promise<void>,
  times: TreeEndTimes,
): Promise<readonly DoomedProcess[]> {
  let left = await stillRunning(host, doomed);
  for (let waited = 0; left.length > 0 && waited < times.stepMs; waited += times.pollMs) {
    await sleep(times.pollMs);
    left = await stillRunning(host, left);
  }
  return left;
}

function send(host: PaneProcessHost, targets: readonly DoomedProcess[], signal: 'SIGTERM' | 'SIGKILL'): void {
  for (const target of targets) {
    try {
      host.signal(target.pid, signal);
    } catch (error) {
      // Gone already is what was wanted; a refusal (EPERM) shows as a survivor below, and is said.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && (error as NodeJS.ErrnoException).code !== 'EPERM')
        throw error;
    }
  }
}

/**
 * Ends every process of `doomed` that is still running, and returns only once none is. Throws, naming the session and the
 * pids, when one survives SIGKILL: the caller must then NOT report the ferret stopped.
 */
export async function endDoomed(
  host: PaneProcessHost,
  doomed: readonly DoomedProcess[],
  session: string,
  sleep: (ms: number) => Promise<void>,
  times: TreeEndTimes = DEFAULT_TREE_END_TIMES,
): Promise<void> {
  let left = await untilGone(host, doomed, sleep, times);
  if (left.length > 0) {
    send(host, left, 'SIGTERM');
    left = await untilGone(host, left, sleep, times);
  }
  if (left.length > 0) {
    send(host, left, 'SIGKILL');
    left = await untilGone(host, left, sleep, times);
  }
  if (left.length > 0)
    throw new Error(
      `could not end every process of ${session} (pid ${left.map(process => process.pid).join(', ')} still runs), so it was not stopped; it may still be running`,
    );
}
