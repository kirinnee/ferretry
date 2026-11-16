import type { SessionMemoryPort } from '../../lib/cgroups/index.ts';
import type { ProcessTreePort } from '../../lib/session/processes/ports.ts';

/** The live panes this daemon registered: the session and the pid its pane runs. */
export interface LivePaneSource {
  live(): Promise<{ readonly panes: readonly { readonly sessionId: string; readonly pid: number }[] }>;
}

/**
 * A ferret's resident memory, by summing its pane's process tree — what macOS has instead of cgroup
 * counters. Only this daemon's own registered panes are read, and only on the limits timer.
 */
export class PaneSessionMemory implements SessionMemoryPort {
  constructor(
    private readonly panes: LivePaneSource,
    private readonly tree: ProcessTreePort,
  ) {}

  async sessions(): Promise<readonly string[]> {
    return (await this.panes.live()).panes.map(pane => pane.sessionId);
  }

  async total(sessionId: string): Promise<number | undefined> {
    const pane = (await this.panes.live()).panes.find(entry => entry.sessionId === sessionId);
    if (pane === undefined) return undefined;
    const read = await this.tree.tree(pane.pid);
    if (read.kind !== 'read') return undefined;
    return read.rows.reduce((sum, row) => sum + (row.rssBytes ?? 0), 0);
  }
}
