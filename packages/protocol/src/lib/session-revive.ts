import type { SessionRevive, SessionStatus, SessionView } from './session.ts';

/**
 * Whether a session in `status` can be brought back — the ONE rule behind every Resume button.
 *
 * The daemon stamps it on each view it serves (`view.revive`); a client reads {@link reviveOf}, which
 * falls back to this same function for a daemon that predates the field. A session is revivable once
 * nothing is working it: it finished, failed, stalled or was stopped. `kill_failed` is the exception
 * (the last stop is unconfirmed, so a second CLI must not start beside it), and every status that is
 * live or already on its way up is not revivable.
 */
export function reviveRuling(status: SessionStatus): SessionRevive {
  switch (status) {
    case 'failed':
      return { revivable: true, reason: 'It failed. Resume relaunches its CLI on the same conversation.' };
    case 'stopped':
      return { revivable: true, reason: 'It was stopped. Resume relaunches its CLI on the same conversation.' };
    case 'completed':
      return { revivable: true, reason: 'It finished. Resume relaunches its CLI on the same conversation.' };
    case 'stalled':
      return { revivable: true, reason: 'It stopped moving. Resume relaunches its CLI on the same conversation.' };
    case 'kill_failed':
      return { revivable: false, reason: 'Its last stop was not confirmed. Stop it again before resuming.' };
    case 'created':
    case 'starting':
    case 'retrying':
      return { revivable: false, reason: 'It is starting.' };
    case 'running':
    case 'thinking':
    case 'tool_running':
    case 'awaiting_question':
    case 'awaiting_user':
    case 'interrupted':
    case 'rate_limited':
    case 'waiting':
      return { revivable: false, reason: 'It is still running.' };
  }
}

/** What the daemon said about reviving this session, or the rule's answer when the daemon said nothing. */
export const reviveOf = (
  view: Pick<SessionView, 'revive'> & { readonly state: { readonly status: SessionStatus } },
): SessionRevive => view.revive ?? reviveRuling(view.state.status);
