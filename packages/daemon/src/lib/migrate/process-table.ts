import { classifyCommand } from './command-classifier.ts';
import type { ProcessInfo } from './inflight-report.ts';

export interface ProcRow {
  readonly pid: number;
  readonly ppid: number;
  readonly startedSecondsAgo: number;
  readonly argv: string;
}

/** Parses `ps -Ao pid=,ppid=,etimes=,args=` output and drops malformed rows. */
export function parseProcessTable(stdout: string): readonly ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const startedSecondsAgo = Number(match[3]);
    const argv = match[4]!.trim();
    if (pid > 1 && Number.isFinite(ppid) && Number.isFinite(startedSecondsAgo))
      rows.push({ pid, ppid, startedSecondsAgo, argv });
  }
  return rows;
}

/** Finds only descendants of the pane process, protecting against unrelated system rows. */
export function descendantsOf(rootPid: number, rows: readonly ProcRow[]): readonly ProcRow[] {
  const children = new Map<number, ProcRow[]>();
  for (const row of rows) children.get(row.ppid)?.push(row) ?? children.set(row.ppid, [row]);
  const output: ProcRow[] = [];
  const queue = [rootPid];
  const seen = new Set(queue);
  for (let index = 0; index < queue.length; index++) {
    for (const child of children.get(queue[index]!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      output.push(child);
      queue.push(child.pid);
    }
  }
  return output;
}

/** Maps observable process rows into migration inventory entries. */
export function inventoryProcesses(
  rows: readonly ProcRow[],
  cwdByPid: ReadonlyMap<number, string | undefined>,
): readonly ProcessInfo[] {
  return rows.map(row => ({
    pid: row.pid,
    argv: row.argv,
    startedSecondsAgo: row.startedSecondsAgo,
    cwd: cwdByPid.get(row.pid),
    verdict: classifyCommand(row.argv),
  }));
}
