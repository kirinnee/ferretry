import { RUNNER_EXIT_LAST_BYTES, RUNNER_EXIT_LAST_LINES } from '@ferretry/core-ferrets/contract';

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

/**
 * The closing words of a dead pane: the last non-empty lines of an ALREADY MASKED screen, bounded from the end. `undefined`
 * when the screen shows nothing.
 */
export function lastLinesOf(masked: string): string | undefined {
  const lines = masked
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')
    .slice(-RUNNER_EXIT_LAST_LINES)
    .join('\n');
  const bounded = lines.length > RUNNER_EXIT_LAST_BYTES ? lines.slice(-RUNNER_EXIT_LAST_BYTES) : lines;
  return bounded.trim() === '' ? undefined : bounded.trim();
}
