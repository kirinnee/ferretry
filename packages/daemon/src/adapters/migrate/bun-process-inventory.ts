import { readlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { ProcessObservation } from '../../lib/migrate/inflight-report.ts';
import type {
  ProcessInventoryPort,
  ProcessProbePort,
  ProcessTableRead,
} from '../../lib/migrate/process-inventory-port.ts';
import { descendantsOf, inventoryProcesses, parseProcessTable } from '../../lib/migrate/process-table.ts';
import { panePidArguments } from '../../lib/tmux/commands.ts';
import type { TmuxCommandPort } from '../../lib/tmux/contracts.ts';

const processTableArguments = ['-Ao', 'pid=,ppid=,etimes=,args='] as const;

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bun-backed process probe. The `ps` executable must be an absolute path so the probe can never
 * resolve an attacker-planted binary from `$PATH`; an unresolved one is reported as a failed read
 * rather than assumed empty.
 */
export class BunProcessProbe implements ProcessProbePort {
  constructor(private readonly psExecutable: string | undefined) {}

  async processTable(): Promise<ProcessTableRead> {
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
  ) {}

  async collect(tmuxSession: string): Promise<ProcessObservation> {
    try {
      const pane = await this.tmux.execute(panePidArguments(tmuxSession));
      if (pane.code !== 0)
        return unobservable(`the pane pid could not be resolved: ${pane.stderr.trim() || `tmux exited ${pane.code}`}`);
      const panePid = Number(pane.stdout.trim());
      if (!Number.isFinite(panePid) || panePid <= 1)
        return unobservable(`tmux reported an unusable pane pid ${JSON.stringify(pane.stdout.trim())}`);
      const table = await this.probe.processTable();
      if (table.kind === 'failed') return unobservable(table.reason);
      const rows = descendantsOf(panePid, parseProcessTable(table.stdout));
      const cwdByPid = new Map<number, string | undefined>();
      for (const row of rows) cwdByPid.set(row.pid, await this.probe.workingDirectory(row.pid));
      return { kind: 'observed', processes: inventoryProcesses(rows, cwdByPid) };
    } catch (error) {
      return unobservable(`the pane could not be inspected: ${detail(error)}`);
    }
  }
}

function unobservable(reason: string): ProcessObservation {
  return { kind: 'unobservable', reason };
}
