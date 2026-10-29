import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { type ProcessIncarnation, procStatStartTicks, psStartSeconds } from '@ferretry/protocol';
import { processIncarnationFor } from '@ferretry/protocol/process-incarnation';
import { parseElapsed } from '../../../lib/migrate/process-table.ts';
import type {
  ProcessDetailRow,
  ProcessStreamTarget,
  ProcessTreePort,
  ProcessTreeRead,
} from '../../../lib/session/processes/ports.ts';
import { BunProcessProbe } from '../../migrate/bun-process-inventory.ts';

/** `USER_HZ`: the unit of `/proc/<pid>/stat`'s times. 100 on every Linux architecture userspace sees. */
const CLOCK_TICKS_PER_SECOND = 100;

/**
 * Linux: one pane's subtree from procfs, walked through `/proc/<pid>/task/<tid>/children` from the pane
 * pid down — no other process on the machine is ever read.
 *
 * Each process's standard output and error are resolved with `readlink` on `/proc/<pid>/fd/1` and `/2`,
 * which names the target WITHOUT opening it: opening the descriptor's alias would hand this daemon a
 * second reader on a pipe or terminal and take output away from its owner.
 */
export class ProcfsProcessTree implements ProcessTreePort {
  private readonly listener: BunProcessProbe;

  constructor(
    private readonly procRoot = '/proc',
    private readonly incarnation: ProcessIncarnation = processIncarnationFor('linux'),
  ) {
    this.listener = new BunProcessProbe(undefined, { procRoot });
  }

  async tree(rootPid: number): Promise<ProcessTreeRead> {
    let bootMs: number;
    try {
      const btime = /^btime (\d+)$/mu.exec(await readFile(join(this.procRoot, 'stat'), 'utf8'))?.[1];
      if (btime === undefined) return { kind: 'unavailable', reason: 'The boot time could not be read from /proc.' };
      bootMs = Number(btime) * 1000;
      await readdir(join(this.procRoot, String(rootPid), 'task'));
    } catch {
      return { kind: 'unavailable', reason: "This ferret's pane could not be read." };
    }
    const rows: ProcessDetailRow[] = [];
    const queue = [rootPid];
    const seen = new Set(queue);
    for (let index = 0; index < queue.length && rows.length < 500; index++) {
      const children = await childrenOf(this.procRoot, queue[index] as number).catch(() => []);
      for (const pid of children) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        const row = await this.row(pid, bootMs);
        if (row === undefined) continue;
        rows.push(row);
        queue.push(pid);
      }
    }
    return { kind: 'read', rows };
  }

  async listening(pids: readonly number[]): Promise<ReadonlySet<number> | undefined> {
    return await this.listener.listening(pids);
  }

  async startOf(pid: number): Promise<number | undefined> {
    return await this.incarnation.startOf(pid).catch(() => undefined);
  }

  private async row(pid: number, bootMs: number): Promise<ProcessDetailRow | undefined> {
    const base = join(this.procRoot, String(pid));
    try {
      const stat = await readFile(join(base, 'stat'), 'utf8');
      const parsed = parseProcStat(stat);
      const start = procStatStartTicks(stat);
      if (parsed === undefined || start === undefined) return undefined;
      const words = (await readFile(join(base, 'cmdline'), 'utf8')).split('\0');
      if (words.at(-1) === '') words.pop();
      // biome-ignore lint/suspicious/noControlCharactersInRegex: procps prints every control character as `?`.
      const argv = words.join(' ').replace(/[\u0000-\u001f\u007f]/gu, '?');
      const rssKb = /^VmRSS:\s+(\d+) kB$/mu.exec(await readFile(join(base, 'status'), 'utf8').catch(() => ''))?.[1];
      const [stdout, stderr] = await Promise.all([streamTarget(base, 1), streamTarget(base, 2)]);
      return {
        pid,
        ppid: parsed.ppid,
        start,
        startedAtMs: bootMs + (start / CLOCK_TICKS_PER_SECOND) * 1000,
        argv: argv === '' ? `[${parsed.comm}]` : argv,
        state: parsed.state,
        cpuSeconds: parsed.cpuTicks / CLOCK_TICKS_PER_SECOND,
        ...(rssKb === undefined ? {} : { rssBytes: Number(rssKb) * 1024 }),
        ...(stdout === undefined ? {} : { stdout }),
        ...(stderr === undefined ? {} : { stderr }),
      };
    } catch {
      // Exited between being listed and being read: a look a moment later would not show it either.
      return undefined;
    }
  }
}

/** `comm`, state, parent and user+system ticks from one `/proc/<pid>/stat` line. */
export function parseProcStat(
  text: string,
): { readonly comm: string; readonly state: string; readonly ppid: number; readonly cpuTicks: number } | undefined {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return undefined;
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  const ppid = Number(fields[1]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isSafeInteger(ppid) || !Number.isFinite(utime) || !Number.isFinite(stime)) return undefined;
  return { comm: text.slice(open + 1, close), state: fields[0] ?? '?', ppid, cpuTicks: utime + stime };
}

/** What a `readlink` of `/proc/<pid>/fd/<n>` names, with a regular file confirmed by `lstat` on its path. */
export async function classifyStreamLink(
  link: string,
  isRegularFile: (path: string) => Promise<boolean>,
): Promise<ProcessStreamTarget> {
  if (link === '/dev/null') return { kind: 'null' };
  if (link.startsWith('pipe:[')) return { kind: 'pipe' };
  if (link.startsWith('socket:[')) return { kind: 'socket' };
  if (/^\/dev\/(?:pts\/\d+|tty\w*|console)$/u.test(link)) return { kind: 'terminal', path: link };
  if (link.endsWith(' (deleted)')) return { kind: 'other', description: 'a deleted file' };
  if (isAbsolute(link) && (await isRegularFile(link))) return { kind: 'file', path: link };
  return { kind: 'other', description: link.startsWith('/') ? 'not a regular file' : link };
}

async function streamTarget(base: string, fd: 1 | 2): Promise<ProcessStreamTarget | undefined> {
  const link = await readlink(join(base, 'fd', String(fd))).catch(() => undefined);
  if (link === undefined) return { kind: 'other', description: 'closed or not readable' };
  return await classifyStreamLink(link, async path =>
    (await lstat(path).catch(() => undefined))?.isFile() === true,
  );
}

async function childrenOf(proc: string, pid: number): Promise<readonly number[]> {
  const tasks = await readdir(join(proc, String(pid), 'task'));
  const children = new Set<number>();
  for (const task of tasks) {
    const listed = await readFile(join(proc, String(pid), 'task', task, 'children'), 'utf8').catch(() => '');
    for (const word of listed.split(' ')) if (/^\d+$/u.test(word)) children.add(Number(word));
  }
  return [...children].sort((left, right) => left - right);
}

const PS_DETAIL_ARGUMENTS = ['-Ao', 'pid=,ppid=,lstart=,state=,time=,rss=,args='] as const;

/**
 * macOS (and any host without procfs): the subtree from one `ps` table. Descriptors cannot be read
 * without `lsof`, so `stdout`/`stderr` are left unknown and output is reported as not supported yet —
 * a declared GAP (docs/processes.md).
 */
export class PsProcessTree implements ProcessTreePort {
  constructor(
    private readonly psExecutable: string,
    private readonly incarnation: ProcessIncarnation = processIncarnationFor('darwin'),
  ) {
    if (!isAbsolute(psExecutable)) throw new Error('the ps executable must be an absolute path');
  }

  async tree(rootPid: number): Promise<ProcessTreeRead> {
    try {
      const child = Bun.spawn([this.psExecutable, ...PS_DETAIL_ARGUMENTS], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        env: { LC_ALL: 'C', TZ: 'UTC0' },
      });
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      if (code !== 0) return { kind: 'unavailable', reason: `ps exited ${code}.` };
      return { kind: 'read', rows: subtreeOf(rootPid, parsePsDetailTable(stdout)) };
    } catch {
      return { kind: 'unavailable', reason: 'The process table could not be read.' };
    }
  }

  async listening(): Promise<ReadonlySet<number> | undefined> {
    return undefined;
  }

  async startOf(pid: number): Promise<number | undefined> {
    return await this.incarnation.startOf(pid).catch(() => undefined);
  }
}

/** `ps -Ao pid=,ppid=,lstart=,state=,time=,rss=,args=` under `LC_ALL=C TZ=UTC0`. */
export function parsePsDetailTable(stdout: string): readonly ProcessDetailRow[] {
  const rows: ProcessDetailRow[] = [];
  const line =
    /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/u;
  for (const text of stdout.split('\n')) {
    const match = line.exec(text);
    if (match === null) continue;
    const start = psStartSeconds(match[3] ?? '');
    const pid = Number(match[1]);
    if (start === undefined || pid <= 1) continue;
    // `time` is `[dd-][hh:]mm:ss.cc`: the elapsed parser reads the whole seconds, the hundredths added back.
    const [clock, hundredths] = (match[5] ?? '').split('.');
    const seconds = parseElapsed(clock ?? '');
    rows.push({
      pid,
      ppid: Number(match[2]),
      start,
      startedAtMs: start * 1000,
      argv: (match[7] ?? '').trim(),
      state: match[4] ?? '?',
      ...(seconds === undefined ? {} : { cpuSeconds: seconds + Number(hundredths ?? 0) / 100 }),
      rssBytes: Number(match[6]) * 1024,
    });
  }
  return rows;
}

function subtreeOf(rootPid: number, rows: readonly ProcessDetailRow[]): readonly ProcessDetailRow[] {
  const children = new Map<number, ProcessDetailRow[]>();
  for (const row of rows) children.get(row.ppid)?.push(row) ?? children.set(row.ppid, [row]);
  const output: ProcessDetailRow[] = [];
  const queue = [rootPid];
  const seen = new Set(queue);
  for (let index = 0; index < queue.length && output.length < 500; index++)
    for (const child of children.get(queue[index] as number) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      output.push(child);
      queue.push(child.pid);
    }
  return output;
}

/** The tree reader for this host: procfs on Linux, `ps` elsewhere. */
export function processTreeFor(platform: string = process.platform): ProcessTreePort {
  if (platform === 'linux') return new ProcfsProcessTree();
  return new PsProcessTree(Bun.which('ps') ?? '/bin/ps');
}
