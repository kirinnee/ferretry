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
 * doubles as proof the socket is still following the right position.
 */
export function renderStreamIdle(sessionId: string, cursor: number, seconds: number): string {
  return `fy stream: no new events for ${sessionId} in ${seconds}s (still following from #${cursor})`;
}

/** Fleet form of the server's idle proof; no global cursor is invented. */
export function renderFleetStreamIdle(followedSessions: number, seconds: number): string {
  return `fy stream: no new fleet events in ${seconds}s (socket is live; following ${followedSessions} sessions)`;
}
