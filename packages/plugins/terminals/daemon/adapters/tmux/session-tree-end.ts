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
  /** Exact recorded scope membership, when this target came from a scope enumeration. */
  readonly scope?: string;
  /** The pane tree this process belonged to; ancestor checks stop at that boundary. */
  readonly root?: number;
}

export interface ProcessSnapshot extends DoomedProcess {
  readonly ppid: number;
  readonly scope: string;
}

export interface TreeEndTimes {
  /** How long a process is given to leave after the session was killed, then after SIGTERM, then after SIGKILL. */
  readonly stepMs: number;
  readonly pollMs: number;
}

export const DEFAULT_TREE_END_TIMES: TreeEndTimes = Object.freeze({ stepMs: 2_000, pollMs: 50 });

/**
 * The recorded launch scope's identities, restricted to that exact membership, minus every pruned subtree. Trees only
 * provide pruning/provenance when a scope was recorded; without a scope they are the source (including on macOS).
 * An orphan can be found without any roots at all. A live root PID never selects the scope.
 */
export async function nameDoomed(
  host: PaneProcessHost,
  roots: readonly number[],
  scope?: string,
): Promise<readonly DoomedProcess[]> {
  const protectedPids = new Set(await host.protectedPids());
  const pruned = new Set(protectedPids);
  const named = new Map<number, DoomedProcess>();
  for (const root of roots) {
    if (!Number.isSafeInteger(root) || root <= 1 || protectedPids.has(root)) continue;
    const start = await host.startOf(root).catch(() => undefined);
    if (start === undefined) continue;
    named.set(root, { pid: root, start, root });
    const tree = await host.tree(root).catch(() => undefined);
    if (tree !== undefined && tree.kind === 'read') {
      // Rows are parents before children, so one pass prunes a whole subtree under a protected (or pruned) node.
      for (const row of tree.rows) {
        if (pruned.has(row.pid) || pruned.has(row.ppid)) pruned.add(row.pid);
        else if (row.pid > 1) named.set(row.pid, { pid: row.pid, start: row.start, root });
      }
    }
  }
  if (scope === undefined) return [...named.values()].filter(row => !pruned.has(row.pid));
  // Scope ownership is an independent launch fact. Never infer it from a root, even when that PID still exists.
  const members = (await host.scopeMembers?.(scope)) ?? [];
  if (members.some(row => protectedPids.has(row.pid))) return [];
  return members
    .filter(row => !pruned.has(row.pid))
    .map(row => {
      const tree = named.get(row.pid);
      return tree?.start === row.start ? { ...row, root: tree.root } : row;
    });
}

/** Fresh protection and ancestor proof, followed by ONE last identity/membership read immediately before use. */
async function eligible(host: PaneProcessHost, target: DoomedProcess): Promise<boolean> {
  if (!Number.isSafeInteger(target.pid) || target.pid <= 1) return false;
  const protectedChain = await host.protectedPids();
  const protectedPids = new Set(protectedChain);
  if (protectedPids.has(target.pid)) return false;
  if (target.root !== undefined && target.root !== target.pid) {
    const tree = await host.tree(target.root);
    const pruned = new Set(protectedPids);
    if (tree.kind === 'read')
      for (const row of tree.rows) if (pruned.has(row.pid) || pruned.has(row.ppid)) pruned.add(row.pid);
    if (pruned.has(target.pid)) return false;
  }
  if (host.processOf !== undefined) {
    let current = await host.processOf(target.pid);
    if (current?.ppid === protectedChain[0]) return false;
    for (let depth = 0; current !== undefined && current.pid !== target.root && current.ppid > 1; depth++) {
      if (depth >= 64 || current.ppid === protectedChain[0]) return false;
      // An orphan can be adopted by our shared user manager/subreaper. That ancestor is never a signal target, but
      // its whole subtree is not protected: that would include every ferret. The daemon itself IS a subtree boundary.
      if (protectedPids.has(current.ppid)) break;
      current = await host.processOf(current.ppid);
      if (current === undefined) return false;
    }
    const fresh = await host.processOf(target.pid);
    return fresh?.start === target.start && (target.scope === undefined || fresh.scope === target.scope);
  }
  return (await host.startOf(target.pid)) === target.start;
}

async function stillRunning(
  host: PaneProcessHost,
  doomed: readonly DoomedProcess[],
): Promise<readonly DoomedProcess[]> {
  const left: DoomedProcess[] = [];
  for (const process of doomed) {
    if (await eligible(host, process)) left.push(process);
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

async function send(
  host: PaneProcessHost,
  targets: readonly DoomedProcess[],
  signal: 'SIGTERM' | 'SIGKILL',
): Promise<void> {
  for (const target of targets) {
    if (!(await eligible(host, target))) continue;
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
    await send(host, left, 'SIGTERM');
    left = await untilGone(host, left, sleep, times);
  }
  if (left.length > 0) {
    await send(host, left, 'SIGKILL');
    left = await untilGone(host, left, sleep, times);
  }
  if (left.length > 0)
    throw new Error(
      `could not end every process of ${session} (pid ${left.map(process => process.pid).join(', ')} still runs), so it was not stopped; it may still be running`,
    );
}
