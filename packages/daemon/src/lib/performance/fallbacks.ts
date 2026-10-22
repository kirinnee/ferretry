import { type PathRoots, pathShape } from '@ferretry/protocol';

/** One directory the file-event hub polls instead of watching, as the profile reads it. */
export interface PolledDirectory {
  readonly directory: string;
  readonly reason: string;
}

/** How many polled directories a report names before it only counts the rest. */
const NAMED = 5;

/**
 * The sentences a performance report adds for directories the file-event hub could not watch.
 *
 * A polled directory is a cost the event-driven daemon promised not to have — a `stat` sweep every few
 * seconds instead of an event — and on a platform whose watcher is unverified (FSEvents on macOS) it is
 * the first thing to look for. Each directory is written as its SHAPE, so the line is as shareable as
 * the rest of the report; the hub's free-text detail is left out because it may quote a path.
 */
export function polledDirectoryLimitations(
  polled: readonly PolledDirectory[],
  roots: PathRoots,
  pollMs: number,
): readonly string[] {
  if (polled.length === 0) return [];
  const named = polled.slice(0, NAMED).map(entry => `${pathShape(entry.directory, roots)} (${entry.reason})`);
  const more = polled.length > NAMED ? `, and ${String(polled.length - NAMED)} more` : '';
  return [
    `The file-event hub could not watch ${String(polled.length)} director${polled.length === 1 ? 'y' : 'ies'} and polls ${polled.length === 1 ? 'it' : 'them'} every ${String(Math.round(pollMs / 1_000))} s instead: ${named.join(', ')}${more}.`,
  ];
}
