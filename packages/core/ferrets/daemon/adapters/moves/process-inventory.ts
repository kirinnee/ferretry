import type { Clock, HostFactsPort, SpawnPort } from '@ferretry/kernel/contract';
import { claudeTaskId } from '@ferretry/std';
import type { KeptAttachment } from '../../../contract/job-keeping.ts';
import { bounded, KEEPER_TIMEOUT_MS } from '../../lib/moves/bounded.ts';
import { markJobAttachments } from '../../lib/moves/job-attachments.ts';
import { identifyAgentJobs } from '../../lib/moves/agent-jobs.ts';
import { type ConfiguredServersPort, configuredServersOf } from '../../lib/moves/configured-servers.ts';
import { identifyKnownProcesses, isHarnessCommand } from '../../lib/moves/harness-provenance.ts';
import type { ProcessObservation } from '../../lib/moves/inflight-report.ts';
import type {
  MovePane,
  ProcessInventoryPort,
  ProcessProbePort,
  ProcessTableRead,
} from '../../lib/moves/process-inventory-port.ts';
import { descendantsOf, inventoryProcesses, type ProcRow, parseProcessTable } from '../../lib/moves/process-table.ts';

const processTableArguments = ['-Ao', 'pid=,ppid=,etime=,args='] as const;

/** `USER_HZ`: the unit of `/proc/<pid>/stat`'s start time. 100 on every Linux architecture userspace sees. */
const CLOCK_TICKS_PER_SECOND = 100;

/**
 * What the probe reads of the machine: the kernel's host facts, plus the one read they do not offer yet — where a
 * process is working (`readlink /proc/<pid>/cwd`). Throws as the read does (a vanished process, a process of another
 * user), and the probe keeps its own catch.
 */
export interface ProcessHostFacts
  extends Pick<
    HostFactsPort,
    'platform' | 'procFile' | 'procSystemFile' | 'procTasks' | 'procTaskChildren' | 'procFds' | 'procFdLink'
  > {
  procWorkingDirectory(pid: number): Promise<string>;
}

export interface ProcessProbeOptions {
  /**
   * Whether procfs lists each task's children on this host. Linux defaults to yes, every other platform to no.
   */
  readonly procfs?: boolean;
  /**
   * How long one read of the full table answers every later ask. Zero — the default — reads it every
   * time; a caller that asks about several panes in one pass, and can live with a table that old, sets it.
   */
  readonly tableTtlMs?: number;
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Kernel-backed process probe. `ps` is a program the manifest declares in `permissions.spawn`, which the kernel
 * resolves itself, so the probe can never run an attacker-planted binary from `$PATH`; a `ps` that cannot be run is
 * reported as a failed read rather than assumed empty.
 *
 * WHERE PROCFS LISTS CHILDREN, NO `ps` RUNS AT ALL. `ps -Ao` reads three files for every process on
 * the machine — eleven thousand opens a second on a busy box when the liveness monitor asked about each
 * ferret — to answer a question about one pane's handful of descendants. {@link descendants} walks
 * that subtree alone through `/proc/<pid>/task/<tid>/children`, in the order the table walk produced.
 */
export class KernelProcessProbe implements ProcessProbePort {
  private table: { readonly atMs: number; readonly read: ProcessTableRead } | undefined;
  private readonly procfs: boolean;

  constructor(
    private readonly spawn: Pick<SpawnPort, 'run'>,
    private readonly host: ProcessHostFacts,
    private readonly clock: Pick<Clock, 'nowMs'>,
    private readonly options: ProcessProbeOptions = {},
  ) {
    this.procfs = options.procfs ?? host.platform === 'linux';
  }

  async processTable(): Promise<ProcessTableRead> {
    const nowMs = this.clock.nowMs();
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
    if (!this.procfs) return undefined;
    try {
      const clock = await this.clockFacts();
      if (clock === undefined) return undefined;
      const rows: ProcRow[] = [];
      const queue = [rootPid];
      const seen = new Set(queue);
      for (let index = 0; index < queue.length; index++) {
        const parent = queue[index] as number;
        // The root must be readable — that is the whole question; a descendant that exited mid-walk
        // simply has no children left, exactly as a table read a moment later would show.
        const children = await this.childrenOf(parent).catch(error => {
          if (index === 0) throw error;
          return [];
        });
        for (const pid of children) {
          if (seen.has(pid)) continue;
          seen.add(pid);
          const row = await this.procRow(pid, clock);
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

  /**
   * These pids, wherever they are on the host now — a job re-parented out of its pane included. From procfs where
   * there is one, else the full table, read fresh (never the cached one: a stopped job must be seen gone). A pid
   * not running is absent. Throws when neither can be read, so the caller can never mistake "unreadable" for "gone".
   */
  async lookup(pids: readonly number[]): Promise<ReadonlyMap<number, ProcRow>> {
    const found = new Map<number, ProcRow>();
    if (this.procfs) {
      const clock = await this.clockFacts();
      if (clock === undefined) throw new Error('procfs gave no usable boot time');
      for (const pid of pids) {
        const row = await this.procRow(pid, clock);
        if (row !== undefined) found.set(pid, row);
      }
      return found;
    }
    const read = await this.readTable();
    if (read.kind === 'failed') throw new Error(read.reason);
    const wanted = new Set(pids);
    for (const row of parseProcessTable(read.stdout)) if (wanted.has(row.pid)) found.set(row.pid, row);
    return found;
  }

  private async readTable(): Promise<ProcessTableRead> {
    try {
      const { exitCode: code, signal, stdout, stderr } = await this.spawn.run('ps', processTableArguments);
      return code === 0
        ? { kind: 'read', stdout }
        : { kind: 'failed', reason: `ps exited ${String(code ?? signal)}: ${stderr.trim() || 'no output'}` };
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
    if (!this.procfs) return undefined;
    const inodes = new Set<string>();
    for (const table of ['net/tcp', 'net/tcp6'] as const) {
      const text = await this.host.procSystemFile(table).catch(() => '');
      for (const inode of listeningInodes(text)) inodes.add(inode);
    }
    const found = new Set<number>();
    if (inodes.size === 0) return found;
    for (const pid of pids) {
      const fds = await this.host.procFds(pid).catch(() => []);
      for (const fd of fds) {
        const link = await this.host.procFdLink(pid, fd).catch(() => '');
        const inode = /^socket:\[(\d+)\]$/u.exec(link)?.[1];
        if (inode !== undefined && inodes.has(inode)) {
          found.add(pid);
          break;
        }
      }
    }
    return found;
  }

  /** When the machine booted and what time it is, to turn a process's start tick into an age. `undefined` when procfs gives no boot time. */
  private async clockFacts(): Promise<{ readonly bootSeconds: number; readonly nowSeconds: number } | undefined> {
    const bootSeconds = Number(/^btime\s+(\d+)$/mu.exec(await this.host.procSystemFile('stat'))?.[1]);
    return Number.isFinite(bootSeconds) ? { bootSeconds, nowSeconds: this.clock.nowMs() / 1000 } : undefined;
  }

  /** Every child of every thread of `pid`, ascending — the order a pid-sorted table lists them in. */
  private async childrenOf(pid: number): Promise<readonly number[]> {
    const tasks = await this.host.procTasks(pid);
    const children = new Set<number>();
    for (const task of tasks) {
      const listed = await this.host.procTaskChildren(pid, Number(task));
      for (const word of listed.split(' ')) if (/^\d+$/u.test(word)) children.add(Number(word));
    }
    return [...children].sort((left, right) => left - right);
  }

  /**
   * One process as a `ps -o pid=,ppid=,etime=,args=` row: `args` is the command line with its NULs as
   * spaces and control characters as `?`, and `[comm]` for a process with none, as procps prints them.
   */
  private async procRow(
    pid: number,
    clock: { readonly bootSeconds: number; readonly nowSeconds: number },
  ): Promise<ProcRow | undefined> {
    try {
      const stat = await this.host.procFile(pid, 'stat');
      const close = stat.lastIndexOf(')');
      const comm = stat.slice(stat.indexOf('(') + 1, close);
      const fields = stat.slice(close + 2).split(' ');
      const ppid = Number(fields[1]);
      const startTicks = Number(fields[19]);
      const cmdline = await this.host.procFile(pid, 'cmdline');
      const words = cmdline.split('\0');
      if (words.at(-1) === '') words.pop();
      const command = words.join(' ');
      // biome-ignore lint/suspicious/noControlCharactersInRegex: procps prints every control character as `?`.
      const argv = command.replace(/[\u0000-\u001f\u007f]/gu, '?');
      if (pid <= 1 || !Number.isSafeInteger(ppid) || !Number.isFinite(startTicks)) return undefined;
      return {
        pid,
        ppid,
        startedSecondsAgo: Math.max(
          0,
          Math.floor(clock.nowSeconds - clock.bootSeconds - startTicks / CLOCK_TICKS_PER_SECOND),
        ),
        argv: argv === '' ? `[${comm}]` : argv,
        // The exact words, so a multi-line tool command is judged line by line rather than by its first (see ProcRow).
        ...(command === '' ? {} : { command }),
      };
    } catch {
      // Exited between being listed and being read: a table read a moment later would not show it either.
      return undefined;
    }
  }

  /** Where the process's stdout points, from procfs; undefined where that is unreadable (no procfs, another user's process). */
  async stdoutPath(pid: number): Promise<string | undefined> {
    if (!this.procfs) return undefined;
    try {
      return await this.host.procFdLink(pid, '1');
    } catch {
      return undefined;
    }
  }

  /** Reads `/proc`, so a platform without it degrades to an unknown directory rather than failing. */
  async workingDirectory(pid: number): Promise<string | undefined> {
    try {
      return await this.host.procWorkingDirectory(pid);
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

/**
 * Reads a pane's descendant tree.
 *
 * The pane is the ferret's own, reached through its runner ({@link MovePane}): this reads what the runner identifies and
 * the process table below that root, and never names a tmux session or a socket.
 */
export class PaneProcessInventory implements ProcessInventoryPort {
  constructor(
    private readonly probe: ProcessProbePort,
    private readonly provenance: {
      readonly binaryName: string;
      readonly toolsServerArguments: readonly string[];
      readonly statuslineSubcommand: string;
      readonly servers: ConfiguredServersPort;
      /** The keeper's proven attachments of a ferret; absent, none is ever known (the classifier decides alone). */
      readonly attachments?: (ferret: string) => Promise<readonly KeptAttachment[]>;
      /** How long the keeper gets to answer on the gate path (default {@link KEEPER_TIMEOUT_MS}); a timeout proves no attachment. */
      readonly keeperTimeoutMs?: number;
      /** The clock's sleep, which the keeper's bound is measured on; without it the keeper's answer is awaited as it comes. */
      readonly sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  /** The keeper's answer, bounded on the clock where one is given: a hang proves no attachment (fail closed). */
  private async keeperAttachments(answer: Promise<readonly KeptAttachment[]>): Promise<readonly KeptAttachment[]> {
    const sleep = this.provenance.sleep;
    return sleep === undefined
      ? await answer
      : await bounded(answer, this.provenance.keeperTimeoutMs ?? KEEPER_TIMEOUT_MS, 'the job keeper', sleep);
  }

  async collect(pane: MovePane, ferret?: string): Promise<ProcessObservation> {
    try {
      // THREE ANSWERS, NOT TWO. A pane the runner PROVES gone ran nothing (an empty observation: a session whose account died
      // has no pane, and "I could not look" would block the very move the operator is trying to make). A runner that cannot
      // tell, or a pane with no root process it can name, is a blind spot the gate refuses on: losing a signal must never
      // look like the absence of work.
      const identity = await pane.identify();
      if (identity === 'gone') return { kind: 'observed', processes: [] };
      if (identity === undefined) return unobservable('the runner could not say which process the pane runs');
      // A dead pane the runner keeps has no root process, and runs nothing.
      if (identity.pid === undefined) return { kind: 'observed', processes: [] };
      const panePid = identity.pid;
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
      const recognised = identifyKnownProcesses(rows, {
        rootPid: panePid,
        binaryName: this.provenance.binaryName,
        toolsServerArguments: this.provenance.toolsServerArguments,
        statuslineSubcommand: this.provenance.statuslineSubcommand,
        configuredServers,
      });
      // Only what provenance left unexplained: the harness and its own helpers are never servers to keep.
      const jobs = identifyAgentJobs(rows, panePid, recognised);
      // The keeper's registry proves which processes are attachments; a keeper that cannot answer proves none, so nothing
      // is ever wrongly called kept and the classifier decides alone, as it always did.
      const kept =
        ferret === undefined || this.provenance.attachments === undefined
          ? []
          : await this.keeperAttachments(this.provenance.attachments(ferret)).catch(() => []);
      const known = markJobAttachments(rows, recognised, jobs, kept, this.provenance.binaryName);
      const unexplained = rows.filter(row => !known.has(row.pid)).map(row => row.pid);
      const listening = (await this.probe.listening?.(unexplained).catch(() => undefined)) ?? new Set();
      // A tool shell's stdout names its Claude task; Codex's unified-exec commands run under an app-server.
      const taskIds = new Map<number, string>();
      for (const [pid, shell] of jobs) {
        if (pid !== shell || known.has(pid)) continue;
        const path = await this.probe.stdoutPath?.(pid);
        const task = path === undefined ? undefined : claudeTaskId(path);
        if (task !== undefined) taskIds.set(pid, task);
      }
      return {
        kind: 'observed',
        processes: inventoryProcesses(rows, cwdByPid, known, listening, jobs, {
          taskIds,
          codexJobs: codexAppServerJobs(rows, known),
        }),
      };
    } catch (error) {
      return unobservable(`the pane could not be inspected: ${detail(error)}`);
    }
  }
}

/**
 * The commands running under a Codex `app-server` that the pane's tree shows: Codex's unified-exec jobs, which live there
 * and are killed a minute after the client leaves. Only the app-server's direct children count — what they spawn is theirs.
 */
export function codexAppServerJobs(rows: readonly ProcRow[], known: ReadonlyMap<number, unknown>): ReadonlySet<number> {
  const servers = new Set(
    rows.filter(row => /\bapp-server\b/u.test(row.argv) && isHarnessCommand(row.argv)).map(row => row.pid),
  );
  return new Set(
    rows.filter(row => servers.has(row.ppid) && !servers.has(row.pid) && !known.has(row.pid)).map(row => row.pid),
  );
}

function unobservable(reason: string): ProcessObservation {
  return { kind: 'unobservable', reason };
}

/** Reads a project file by absolute path, or answers nothing when it is missing or not the daemon's to read. */
export interface ProjectFileReader {
  readText(path: string): Promise<string | undefined>;
}

/** Reads `<directory>/.mcp.json`. A missing, unreadable or malformed file explains no process. */
export class ProjectMcpServers implements ConfiguredServersPort {
  constructor(private readonly files: ProjectFileReader) {}

  async read(directory: string) {
    try {
      return configuredServersOf((await this.files.readText(`${directory}/.mcp.json`)) ?? null);
    } catch {
      // No file, or one this daemon may not read: nothing is configured as far as the inventory can tell.
      return [];
    }
  }
}
