import { shellCommandFlags, shellHeads } from './command-tables.ts';
import type { ProcessInfo } from './inflight-report.ts';

/**
 * THE CALL THAT ASKED FOR THE MOVE IS NOT A JOB THE MOVE INTERRUPTS.
 *
 * An agent that moves ITSELF (`fy migrate me --agent …` from its own tool shell) is, to the process table, a
 * long-running unclassified command: the tool shell around the call and the `fy` process inside it. Refusing on
 * those would make a self-move impossible, and they are not lost work — the move is what ends that call, and the
 * agent is told on the other side what it asked for.
 *
 * The CLI sends its own pid, and the daemon honours it only from the session moving itself (see the move module); it
 * does not take the pid on trust either, it PROVES the call from the process tree it already walked. The pid is
 * excluded — with the shells between it and the tool shell — only when ALL of these hold:
 *
 * 1. the pid is one of the observed descendants of THIS session's pane (a pid elsewhere on the machine, or one that
 *    has exited, excludes nothing);
 * 2. walking parent by parent from it never meets a process recognised as the harness's own (`known`) — the
 *    requester is not the harness or one of its helpers;
 * 3. the walk ends at a tool shell the agent's harness started (`toolShell === pid`), so the call is demonstrably the
 *    agent's own tool call, not a human typing in the pane or a detached program that reparented;
 * 4. every process BETWEEN the `fy` process and that tool shell is a shell or a pipeline subshell of it: a `sh`/`bash`/
 *    `zsh` handed `-c`, or a process carrying the tool shell's own command line (what a pipeline forks). Anything else
 *    — a script, an interpreter, `watch`, a `while` loop's program — is real work the call was running inside, so the
 *    walk stops there and nothing is excluded: the gate sees all of it and decides.
 *
 * Only that ancestor CHAIN is excluded, never the tool shell's other children: a `sleep 900 &` the same shell
 * started is a sibling, still counted. A pipeline's other stages (`| grep …`) are not excluded either; each is
 * recognised as safe by what it is (`classifyProcessArgv`), not by being near the call.
 *
 * This grants no power a caller lacked: the same request body can already say `forceInflight`.
 */
export function requesterCall(processes: readonly ProcessInfo[], requesterPid: number | undefined): readonly number[] {
  if (requesterPid === undefined) return [];
  const byPid = new Map(processes.map(entry => [entry.pid, entry] as const));
  const walked: ProcessInfo[] = [];
  let current = byPid.get(requesterPid);
  while (current !== undefined && walked.length <= processes.length) {
    if (current.known !== undefined) return [];
    walked.push(current);
    if (current.toolShell === current.pid)
      return withShellsBetween(walked, current) ? walked.map(entry => entry.pid) : [];
    current = current.ppid === undefined ? undefined : byPid.get(current.ppid);
  }
  return [];
}

/** `walked` runs from the `fy` process up to the tool shell; everything strictly between them must be a shell. */
function withShellsBetween(walked: readonly ProcessInfo[], toolShell: ProcessInfo): boolean {
  return walked.slice(1, -1).every(entry => entry.argv === toolShell.argv || isShellWithCommand(entry.argv));
}

/** `sh`/`bash`/`zsh`/… handed a command with `-c` (or `-lc`): a shell running a one-line program, not a script file. */
function isShellWithCommand(argv: string): boolean {
  const words = argv.trim().split(/\s+/u);
  const head = (words[0] ?? '').split('/').at(-1) ?? '';
  return shellHeads.has(head) && words.slice(1).some(word => shellCommandFlags.has(word));
}
