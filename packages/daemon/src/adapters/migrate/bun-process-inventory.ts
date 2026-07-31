import type { CommandPort, CommandResult, ProcessInventoryPort } from '../../lib/migrate/process-inventory-port.ts';
import { descendantsOf, inventoryProcesses, parseProcessTable } from '../../lib/migrate/process-table.ts';
import type { ProcessInfo } from '../../lib/migrate/inflight-report.ts';

/** Bun-backed command adapter. Dependencies are injected so tests never touch a live tmux server. */
export class BunCommandPort implements CommandPort {
  async execute(command: string, arguments_: readonly string[]): Promise<CommandResult> {
    const child = Bun.spawn([command, ...arguments_], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  }
}

/** Reads a pane's descendant tree through an injected command boundary. */
export class PaneProcessInventory implements ProcessInventoryPort {
  constructor(private readonly commands: CommandPort) {}

  async collect(tmuxSession: string): Promise<readonly ProcessInfo[]> {
    try {
      const pane = await this.commands.execute('tmux', ['display-message', '-p', '-t', tmuxSession, '#{pane_pid}']);
      const panePid = pane.code === 0 ? Number(pane.stdout.trim()) : Number.NaN;
      if (!Number.isFinite(panePid) || panePid <= 1) return [];
      const table = await this.commands.execute('ps', ['-Ao', 'pid=,ppid=,etimes=,args=']);
      if (table.code !== 0) return [];
      const rows = descendantsOf(panePid, parseProcessTable(table.stdout));
      const cwdByPid = new Map<number, string | undefined>();
      for (const row of rows) {
        const cwd = await this.commands.execute('readlink', [`/proc/${row.pid}/cwd`]);
        cwdByPid.set(row.pid, cwd.code === 0 && cwd.stdout.trim() ? cwd.stdout.trim() : undefined);
      }
      return inventoryProcesses(rows, cwdByPid);
    } catch {
      // An unreadable pane is not evidence that destructive work is safe; callers retain other signals.
      return [];
    }
  }
}
