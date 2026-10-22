import type { FyEvent } from '@ferretry/protocol';

/**
 * One journal event, as a human reads it.
 *
 * The sequence comes FIRST and is always shown, because it is the cursor: an operator who wants to
 * resume a `fy events` or `fy stream` from where they stopped reads it off the last line. It is also
 * the only field on the envelope that is guaranteed present and meaningful — the turn is not recorded
 * by the daemon at all, so it is rendered only when the producer supplied one rather than as a `0`
 * that would look like every event happened during the session's first turn.
 */
export function renderEvent(event: FyEvent): string {
  const turn = event.turn === undefined ? '' : ` turn=${event.turn}`;
  const data = event.data === undefined || event.data === null ? '' : ` ${JSON.stringify(event.data)}`;
  return `#${event.sequence} ${event.time} ${event.type}${turn} (${event.source})${data}`;
}

/**
 * The advisory a stream prints when the daemon proves its live socket has been quiet.
 *
 * A stream that produces nothing looks exactly like a quiet session unless it says otherwise, and the
 * difference matters: one means the agent is thinking and the other means the follow is broken. It
 * goes to stderr so a `--json` consumer's stdout stays parseable, and it names the cursor so the note
 * doubles as proof the socket is still following the right position. The caller prefixes the command
 * name, which this domain does not know.
 */
export function renderStreamIdle(sessionId: string, cursor: number, seconds: number): string {
  return `no new events for ${sessionId} in ${seconds}s (still following from #${cursor})`;
}

/** Fleet form of the server's idle proof; no global cursor is invented. */
export function renderFleetStreamIdle(followedSessions: number, seconds: number): string {
  return `no new fleet events in ${seconds}s (socket is live; following ${followedSessions} sessions)`;
}

/**
 * The FIRST idle proof a stream hears, which says the replay is over rather than that time passed.
 *
 * A daemon sends it the moment its replay is done, so "no new events in 30s" would be false for it.
 * A daemon that predates the opening proof sends its first one after a quiet window instead, and
 * "caught up" is true of that one too — which is why the wording keys off "first", not off a version.
 */
export function renderStreamCaughtUp(sessionId: string, cursor: number): string {
  return `caught up on ${sessionId} at #${cursor} (following live)`;
}

/** Fleet form of {@link renderStreamCaughtUp}. */
export function renderFleetStreamCaughtUp(followedSessions: number): string {
  return `caught up on the fleet (following ${followedSessions} sessions live)`;
}
