/** What tmux is asked about every pane of a ferret's session: id, dead, and how its program ended. */
export const PANE_EXIT_FACTS = '#{pane_id}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}';

/** One pane's answer to {@link PANE_EXIT_FACTS}. `status` and `signal` are present only when tmux recorded one. */
export interface PaneExitFacts {
  readonly paneId: string;
  readonly dead: boolean;
  readonly status?: number;
  readonly signal?: number;
}

const count = (text: string | undefined): number | undefined =>
  text !== undefined && /^[0-9]+$/u.test(text) ? Number(text) : undefined;

/**
 * The panes `list-panes -F {@link PANE_EXIT_FACTS}` printed. A line that does not parse is dropped (never read as a
 * live or a dead pane), and a signal of 0 is none: a program ended by a signal has no exit status, and the other way round.
 */
export function parsePaneExits(stdout: string): readonly PaneExitFacts[] {
  const panes: PaneExitFacts[] = [];
  for (const line of stdout.split('\n')) {
    const [paneId = '', dead = '', status, signal] = line.trim().split('|');
    if (!/^%[0-9]+$/u.test(paneId) || (dead !== '0' && dead !== '1')) continue;
    const code = count(status);
    const killedBy = count(signal);
    panes.push({
      paneId,
      dead: dead === '1',
      ...(code === undefined ? {} : { status: code }),
      ...(killedBy === undefined || killedBy === 0 ? {} : { signal: killedBy }),
    });
  }
  return panes;
}
