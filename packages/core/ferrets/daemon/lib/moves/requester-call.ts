import type { ProcessInfo } from './inflight-report.ts';

/**
 * THE CALL THAT ASKED FOR THE MOVE IS NOT A JOB THE MOVE INTERRUPTS.
 *
 * An agent that moves ITSELF (`fy migrate me --agent …` from its own tool shell) is, to the process table, a
 * long-running unclassified command: the tool shell around the call and the `fy` process inside it. Refusing on
 * those would make a self-move impossible, and they are not lost work — the move is what ends that call, and the
 * agent is told on the other side what it asked for.
 *
 * The CLI sends its own pid; the daemon does not take that on trust, it PROVES the call from the process tree it
 * already walked. The pid is excluded — with every process between it and the tool shell — only when ALL of these hold:
 *
 * 1. the pid is one of the observed descendants of THIS session's pane (a pid elsewhere on the machine, or one that
 *    has exited, excludes nothing);
 * 2. walking parent by parent from it never meets a process recognised as the harness's own (`known`) — the
 *    requester is not the harness or one of its helpers;
 * 3. the walk ends at a tool shell the agent's harness started (`toolShell === pid`), so the call is demonstrably the
 *    agent's own tool call, not a human typing in the pane or a detached program that reparented.
 *
 * Anything else excludes nothing and the gate decides as it always did. Only the ancestor CHAIN is excluded, never
 * the tool shell's other children: a `sleep 900 &` the same shell started is a sibling, still counted. Siblings that
 * are a pipeline's read-only consumers (`| grep …`) are recognised as safe by what they are
 * (`classifyProcessArgv`), not by being near the call.
 *
 * This grants no power a caller lacked: the same request body can already say `forceInflight`, and the route admits
 * the same callers for both.
 */
export function requesterCall(processes: readonly ProcessInfo[], requesterPid: number | undefined): readonly number[] {
  if (requesterPid === undefined) return [];
  const byPid = new Map(processes.map(entry => [entry.pid, entry] as const));
  const chain: number[] = [];
  let current = byPid.get(requesterPid);
  while (current !== undefined && chain.length <= processes.length) {
    if (current.known !== undefined) return [];
    chain.push(current.pid);
    if (current.toolShell === current.pid) return chain;
    current = current.ppid === undefined ? undefined : byPid.get(current.ppid);
  }
  return [];
}
