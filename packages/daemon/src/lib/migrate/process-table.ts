import { classifyCommand } from './command-classifier.ts';
import type { KnownProcess } from './harness-provenance.ts';
import type { ProcessInfo } from './inflight-report.ts';

export interface ProcRow {
  readonly pid: number;
  readonly ppid: number;
  readonly startedSecondsAgo: number;
  readonly argv: string;
}

const ELAPSED_SECONDS_PER_UNIT = [1, 60, 3600] as const;
const SECONDS_PER_DAY = 86_400;

/**
 * `ps -o etime=` as seconds: `[[dd-]hh:]mm:ss`, or a bare `ss`. It is the one elapsed-time keyword
 * both procps (Linux) and BSD `ps` (macOS) accept — `etimes` is procps-only.
 */
export function parseElapsed(text: string): number | undefined {
  const match = text.match(/^(?:(\d+)-)?(\d+(?::\d+){0,2})$/);
  if (!match) return undefined;
  const fields = match[2]!.split(':').map(Number).reverse();
  const clock = fields.reduce((sum, value, index) => sum + value * ELAPSED_SECONDS_PER_UNIT[index]!, 0);
  return Number(match[1] ?? 0) * SECONDS_PER_DAY + clock;
}

/** Parses `ps -Ao pid=,ppid=,etime=,args=` output and drops malformed rows. */
export function parseProcessTable(stdout: string): readonly ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const startedSecondsAgo = parseElapsed(match[3]!);
    const argv = match[4]!.trim();
    if (pid > 1 && startedSecondsAgo !== undefined) rows.push({ pid, ppid, startedSecondsAgo, argv });
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

/**
 * Maps observable process rows into migration inventory entries. A row {@link identifyKnownProcesses}
 * recognised as the agent's own is safe to stop: the restart relaunches it with the CLI.
 */
export function inventoryProcesses(
  rows: readonly ProcRow[],
  cwdByPid: ReadonlyMap<number, string | undefined>,
  known: ReadonlyMap<number, KnownProcess> = new Map(),
  listening: ReadonlySet<number> = new Set(),
): readonly ProcessInfo[] {
  return rows.map(row => {
    const own = known.get(row.pid);
    return {
      pid: row.pid,
      argv: row.argv,
      startedSecondsAgo: row.startedSecondsAgo,
      cwd: cwdByPid.get(row.pid),
      verdict: own === undefined ? classifyCommand(row.argv) : 'safe_to_kill',
      ...(own === undefined ? {} : { known: own }),
      ppid: row.ppid,
      ...(listening.has(row.pid) ? { listening: true as const } : {}),
    };
  });
}
