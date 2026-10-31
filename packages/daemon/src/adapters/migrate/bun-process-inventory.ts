import { readdir, readFile, readlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { identifyAgentJobs } from '../../lib/migrate/agent-jobs.ts';
import { type ConfiguredServersPort, configuredServersOf } from '../../lib/migrate/configured-servers.ts';
import { identifyKnownProcesses } from '../../lib/migrate/harness-provenance.ts';
import type { ProcessObservation } from '../../lib/migrate/inflight-report.ts';
import type { PaneSnapshotPort } from '../../lib/migrate/preflight-service.ts';
import type {
  ProcessInventoryPort,
  ProcessProbePort,
  ProcessTableRead,
} from '../../lib/migrate/process-inventory-port.ts';
import { descendantsOf, inventoryProcesses, type ProcRow, parseProcessTable } from '../../lib/migrate/process-table.ts';
import { capturePaneArguments, hasSessionArguments } from '../../lib/tmux/commands.ts';
import type { TmuxCommandPort } from '../../lib/tmux/contracts.ts';
import { paneProofArguments, parsePaneSighting } from '../../lib/tmux/pane-proof.ts';

const processTableArguments = ['-Ao', 'pid=,ppid=,etime=,args='] as const;

/** `USER_HZ`: the unit of `/proc/<pid>/stat`'s start time. 100 on every Linux architecture userspace sees. */
const CLOCK_TICKS_PER_SECOND = 100;

export interface ProcessProbeOptions {
  /**
   * Where procfs is mounted, on a host whose kernel lists each task's children there; `undefined` where
   * there is none. Linux defaults to `/proc`, every other platform to none.
   */
  readonly procRoot?: string;
  /**
   * How long one read of the full table answers every later ask. Zero — the default — reads it every
   * time; a caller that asks about several panes in one pass, and can live with a table that old, sets it.
   */
  readonly tableTtlMs?: number;
  readonly nowMs?: () => number;
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bun-backed process probe. The `ps` executable must be an absolute path so the probe can never
 * resolve an attacker-planted binary from `$PATH`; an unresolved one is reported as a failed read
 * rather than assumed empty.
 *
 * WHERE PROCFS LISTS CHILDREN, NO `ps` RUNS AT ALL. `ps -Ao` reads three files for every process on
 * the machine — eleven thousand opens a second on a busy box when the liveness monitor asked about each
 * ferret — to answer a question about one pane's handful of descendants. {@link descendants} walks
 * that subtree alone through `/proc/<pid>/task/<tid>/children`, in the order the table walk produced.
 */
export class BunProcessProbe implements ProcessProbePort {
  private table: { readonly atMs: number; readonly read: ProcessTableRead } | undefined;
  private readonly procRoot: string | undefined;

  constructor(
    private readonly psExecutable: string | undefined,
    private readonly options: ProcessProbeOptions = {},
  ) {
    this.procRoot = 'procRoot' in options ? options.procRoot : process.platform === 'linux' ? '/proc' : undefined;
  }

  async processTable(): Promise<ProcessTableRead> {
    const nowMs = this.options.nowMs?.() ?? Date.now();
    const ttl = this.options.tableTtlMs ?? 0;
    if (this.table !== undefined && nowMs - this.table.atMs < ttl) return this.table.read;
    const read = await this.readTable();
    if (read.kind === 'read') this.table = { atMs: nowMs, read };
    return read;
  }

  /**
   * The subtree under `rootPid` from procfs, or `undefined` — so the caller reads the full table — when
   * there is no procfs, the root cannot be read, or this kernel does not list children.
   */
  async descendants(rootPid: number): Promise<readonly ProcRow[] | undefined> {
    const proc = this.procRoot;
    if (proc === undefined) return undefined;
    try {
      const uptime = Number((await readFile(join(proc, 'uptime'), 'utf8')).split(' ')[0]);
      if (!Number.isFinite(uptime)) return undefined;
      const rows: ProcRow[] = [];
      const queue = [rootPid];
      const seen = new Set(queue);
      for (let index = 0; index < queue.length; index++) {
        const parent = queue[index] as number;
        // The root must be readable — that is the whole question; a descendant that exited mid-walk
        // simply has no children left, exactly as a table read a moment later would show.
        const children = await childrenOf(proc, parent).catch(error => {
          if (index === 0) throw error;
          return [];
        });
        for (const pid of children) {
          if (seen.has(pid)) continue;
          seen.add(pid);
          const row = await procRow(proc, pid, uptime);
          if (row === undefined) continue;
          rows.push(row);
          queue.push(pid);
        }
      }
      return rows;
    } catch {
      return undefined;
    }
  }

  private async readTable(): Promise<ProcessTableRead> {
    if (this.psExecutable === undefined || !isAbsolute(this.psExecutable))
      return { kind: 'failed', reason: 'no absolute ps executable is available to read the process table' };
    try {
      const child = Bun.spawn([this.psExecutable, ...processTableArguments], { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return code === 0
        ? { kind: 'read', stdout }
        : { kind: 'failed', reason: `ps exited ${code}: ${stderr.trim() || 'no output'}` };
    } catch (error) {
      return { kind: 'failed', reason: `ps could not be run: ${detail(error)}` };
    }
  }

  /**
   * The processes among `pids` holding a LISTEN socket, from procfs: the listening inodes of
   * `net/tcp` and `net/tcp6`, matched against each process's open descriptors. `undefined` without
   * procfs; a process that exits or is not ours to read simply holds none.
   */
  async listening(pids: readonly number[]): Promise<ReadonlySet<number> | undefined> {
    const proc = this.procRoot;
    if (proc === undefined) return undefined;
    const inodes = new Set<string>();
    for (const table of ['tcp', 'tcp6']) {
      const text = await readFile(join(proc, 'net', table), 'utf8').catch(() => '');
      for (const inode of listeningInodes(text)) inodes.add(inode);
    }
    const found = new Set<number>();
    if (inodes.size === 0) return found;
    for (const pid of pids) {
      const fds = await readdir(join(proc, String(pid), 'fd')).catch(() => []);
      for (const fd of fds) {
        const link = await readlink(join(proc, String(pid), 'fd', fd)).catch(() => '');
        const inode = /^socket:\[(\d+)\]$/u.exec(link)?.[1];
        if (inode !== undefined && inodes.has(inode)) {
          found.add(pid);
          break;
        }
      }
    }
    return found;
  }

  /** Reads `/proc`, so a platform without it degrades to an unknown directory rather than failing. */
  async workingDirectory(pid: number): Promise<string | undefined> {
    try {
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      // A process may exit, or belong to another user, between the table read and this call.
      return undefined;
    }
  }
}

/** The socket inodes a `/proc/net/tcp`-format table lists in state `0A` (LISTEN). */
export function listeningInodes(table: string): readonly string[] {
  const inodes: string[] = [];
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/u);
    if (fields[3] === '0A' && fields[9] !== undefined && fields[9] !== '0') inodes.push(fields[9]);
  }
  return inodes;
}

/** Every child of every thread of `pid`, ascending — the order a pid-sorted table lists them in. */
async function childrenOf(proc: string, pid: number): Promise<readonly number[]> {
  const tasks = await readdir(join(proc, String(pid), 'task'));
  const children = new Set<number>();
  for (const task of tasks) {
    const listed = await readFile(join(proc, String(pid), 'task', task, 'children'), 'utf8');
    for (const word of listed.split(' ')) if (/^\d+$/u.test(word)) children.add(Number(word));
  }
  return [...children].sort((left, right) => left - right);
}

/**
 * One process as a `ps -o pid=,ppid=,etime=,args=` row: `args` is the command line with its NULs as
 * spaces and control characters as `?`, and `[comm]` for a process with none, as procps prints them.
 */
async function procRow(proc: string, pid: number, uptime: number): Promise<ProcRow | undefined> {
  try {
    const stat = await readFile(join(proc, String(pid), 'stat'), 'utf8');
    const close = stat.lastIndexOf(')');
    const comm = stat.slice(stat.indexOf('(') + 1, close);
    const fields = stat.slice(close + 2).split(' ');
    const ppid = Number(fields[1]);
    const startTicks = Number(fields[19]);
    const cmdline = await readFile(join(proc, String(pid), 'cmdline'), 'utf8');
    const words = cmdline.split('\0');
    if (words.at(-1) === '') words.pop();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: procps prints every control character as `?`.
    const argv = words.join(' ').replace(/[\u0000-\u001f\u007f]/gu, '?');
    if (pid <= 1 || !Number.isSafeInteger(ppid) || !Number.isFinite(startTicks)) return undefined;
    return {
      pid,
      ppid,
      startedSecondsAgo: Math.max(0, Math.floor(uptime - startTicks / CLOCK_TICKS_PER_SECOND)),
      argv: argv === '' ? `[${comm}]` : argv,
    };
  } catch {
    // Exited between being listed and being read: a table read a moment later would not show it either.
    return undefined;
  }
}

/**
 * Reads a pane's descendant tree.
 *
 * tmux is reached through the socket-scoped {@link TmuxCommandPort} rather than a bare command, so
 * this can only ever address the daemon's own private server — never the machine's default socket.
 */
export class PaneProcessInventory implements ProcessInventoryPort {
  constructor(
    private readonly tmux: TmuxCommandPort,
    private readonly probe: ProcessProbePort,
    private readonly provenance: { readonly binaryName: string; readonly servers: ConfiguredServersPort },
  ) {}

  async collect(tmuxSession: string): Promise<ProcessObservation> {
    try {
      const pane = await this.tmux.execute(paneProofArguments(tmuxSession));
      if (pane.code !== 0) {
        // ASK A SECOND QUESTION BEFORE CALLING THIS A BLIND SPOT. A failed pane-pid read used to be
        // unobservable unconditionally, which is right when tmux may be hiding something and wrong
        // for the commonest migration there is: a session whose account died has no pane at all, and
        // "I could not look" then blocks the very move the operator is trying to make. tmux is asked
        // outright whether the session exists, and only a session it CONFIRMS is gone becomes an
        // empty observation — a server that will not answer either question stays a blind spot.
        if (await this.paneConfirmedAbsent(tmuxSession)) return { kind: 'observed', processes: [] };
        return unobservable(`the pane pid could not be resolved: ${pane.stderr.trim() || `tmux exited ${pane.code}`}`);
      }
      const sighting = parsePaneSighting(pane.stdout);
      if (sighting === undefined)
        return unobservable(`tmux reported an unusable pane pid ${JSON.stringify(pane.stdout.trim())}`);
      // A dead pane runs nothing. tmux 3.8 says so with no pid at all; older releases keep the dead one.
      if (sighting.pid === undefined) return { kind: 'observed', processes: [] };
      const panePid = sighting.pid;
      const subtree = await this.probe.descendants?.(panePid);
      let rows: readonly ProcRow[];
      if (subtree !== undefined) rows = subtree;
      else {
        const table = await this.probe.processTable();
        if (table.kind === 'failed') return unobservable(`the process table could not be read: ${table.reason}`);
        rows = descendantsOf(panePid, parseProcessTable(table.stdout));
      }
      const cwdByPid = new Map<number, string | undefined>();
      for (const row of rows) cwdByPid.set(row.pid, await this.probe.workingDirectory(row.pid));
      // The project's own server list is read from the directory the pane runs in; where that is not
      // readable (no /proc) the servers stay unexplained and therefore unclassified, never assumed.
      const paneDirectory = await this.probe.workingDirectory(panePid);
      const configuredServers = paneDirectory === undefined ? [] : await this.provenance.servers.read(paneDirectory);
      const known = identifyKnownProcesses(rows, {
        rootPid: panePid,
        binaryName: this.provenance.binaryName,
        configuredServers,
      });
      // Only what provenance left unexplained: the harness and its own helpers are never servers to keep.
      const unexplained = rows.filter(row => !known.has(row.pid)).map(row => row.pid);
      const listening = (await this.probe.listening?.(unexplained).catch(() => undefined)) ?? new Set();
      const jobs = identifyAgentJobs(rows, panePid, known);
      return { kind: 'observed', processes: inventoryProcesses(rows, cwdByPid, known, listening, jobs) };
    } catch (error) {
      return unobservable(`the pane could not be inspected: ${detail(error)}`);
    }
  }

  private async paneConfirmedAbsent(tmuxSession: string): Promise<boolean> {
    return await paneConfirmedAbsent(this.tmux, tmuxSession);
  }
}

function unobservable(reason: string): ProcessObservation {
  return { kind: 'unobservable', reason };
}

/**
 * Whether tmux positively reports that this session does not exist.
 *
 * `has-session` is the only question tmux answers unambiguously about absence: a non-zero exit means
 * no such session on this socket — including the case where the private server is not running at
 * all, which means no managed pane exists to hold work. Anything that stops the question being asked
 * (a tmux that will not spawn, an address the validator refuses) throws or answers zero, and the
 * caller then keeps its blind spot rather than reading a failure as an absence.
 */
async function paneConfirmedAbsent(tmux: TmuxCommandPort, tmuxSession: string): Promise<boolean> {
  const probe = await tmux.execute(hasSessionArguments(tmuxSession));
  return probe.code !== 0;
}

/**
 * Reads a pane's visible text through the socket-scoped tmux port, so the codex footer can be
 * counted without the migrate subsystem ever naming a command of its own.
 *
 * A capture that fails is asked the same second question the inventory above asks, and for the same
 * reason: a session tmux confirms is gone has no footer to read, and raising there would turn every
 * stopped codex session into a blind spot that refuses its own migration.
 */
export class TmuxPaneSnapshot implements PaneSnapshotPort {
  constructor(private readonly tmux: TmuxCommandPort) {}

  async visible(tmuxSession: string): Promise<string | undefined> {
    const result = await this.tmux.execute(capturePaneArguments(tmuxSession, false));
    if (result.code === 0) return result.stdout;
    if (await paneConfirmedAbsent(this.tmux, tmuxSession)) return undefined;
    throw new Error(`tmux could not capture the pane: ${result.stderr.trim() || `exited ${result.code}`}`);
  }
}

/** Reads `<directory>/.mcp.json`. A missing, unreadable or malformed file explains no process. */
export class ProjectMcpServers implements ConfiguredServersPort {
  async read(directory: string) {
    try {
      return configuredServersOf(await readFile(join(directory, '.mcp.json'), 'utf8'));
    } catch {
      // No file, or one this daemon may not read: nothing is configured as far as the inventory can tell.
      return [];
    }
  }
}
