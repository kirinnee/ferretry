import type { FyEvent } from '../../../contract/index.ts';

/**
 * One journal event, as a human reads it.
 *
 * The sequence comes FIRST and is always shown, because it is the cursor: an operator who wants to resume a
 * `fy stream` from where they stopped reads it off the last line. The turn is rendered only when the producer
 * supplied one, rather than as a `0` that would look like every event happened during the first turn.
 */
export function renderEvent(event: FyEvent): string {
  const turn = event.turn === undefined ? '' : ` turn=${event.turn}`;
  const data = event.data === undefined || event.data === null ? '' : ` ${JSON.stringify(event.data)}`;
  return `#${event.sequence} ${event.time} ${event.type}${turn} (${event.source})${data}`;
}

/**
 * The advisory a stream prints when the daemon proves its live socket has been quiet: a stream that produces nothing
 * looks exactly like a quiet ferret unless it says otherwise. It goes to stderr so a `--json` consumer's stdout stays
 * parseable, and it names the cursor so the note doubles as proof the socket follows the right position.
 */
export function renderStreamIdle(ferretId: string, cursor: number, seconds: number): string {
  return `no new events for ${ferretId} in ${seconds}s (still following from #${cursor})`;
}

/** Fleet form of the server's idle proof; no global cursor is invented. */
export function renderFleetStreamIdle(followed: number, seconds: number): string {
  return `no new fleet events in ${seconds}s (socket is live; following ${followed} ferrets)`;
}

/**
 * The FIRST idle proof a stream hears: the daemon sends it the moment its replay is done, so it says the replay is
 * over rather than that time passed.
 */
export function renderStreamCaughtUp(ferretId: string, cursor: number): string {
  return `caught up on ${ferretId} at #${cursor} (following live)`;
}

/** Fleet form of {@link renderStreamCaughtUp}. */
export function renderFleetStreamCaughtUp(followed: number): string {
  return `caught up on the fleet (following ${followed} ferrets live)`;
}
