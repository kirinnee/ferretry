import { readlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { ProcessObservation } from '../../lib/migrate/inflight-report.ts';
import type {
  ProcessInventoryPort,
  ProcessProbePort,
  ProcessTableRead,
} from '../../lib/migrate/process-inventory-port.ts';
import { descendantsOf, inventoryProcesses, parseProcessTable } from '../../lib/migrate/process-table.ts';
import type { PaneSnapshotPort } from '../../lib/migrate/preflight-service.ts';
import { capturePaneArguments, hasSessionArguments, panePidArguments } from '../../lib/tmux/commands.ts';
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
