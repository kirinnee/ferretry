import type { SessionView } from '@ferretry/protocol';
import { relativeTime, sessionNavigation, sessionStatusLabel } from '../lib/session-screens.ts';

export interface SessionListProps {
  readonly daemonId: string;
  readonly sessions: readonly SessionView[];
  readonly now?: number;
  readonly onOpenSession: (daemonId: string, sessionId: string) => void;
}

const statusTone = (status: SessionView['state']['status']): string => {
  if (status === 'failed' || status === 'stalled' || status === 'kill_failed') return 'var(--err, #b42318)';
  if (status === 'completed' || status === 'stopped') return 'var(--muted, #667085)';
  if (status === 'waiting' || status === 'awaiting_question') return 'var(--warn, #a15c00)';
  return 'var(--ok, #027a48)';
};

/**
 * Fleet rows deliberately receive the daemon id from their host. The same
 * session id may exist on multiple paired daemons, so navigation never relies
 * on an ambient/global connection.
 */
export function SessionList({ daemonId, sessions, now = Date.now(), onOpenSession }: SessionListProps) {
  return (
    <section aria-labelledby="sessions-heading" className="fy-session-list">
      <div className="fy-screen-heading">
        <div>
          <p className="fy-eyebrow">Current daemon</p>
          <h1 id="sessions-heading">Sessions</h1>
        </div>
        <span aria-label={`${sessions.length} sessions`} className="fy-count" role="status">
          {sessions.length}
        </span>
      </div>
      {sessions.length === 0 ? (
        <p className="fy-empty">No sessions on this daemon yet.</p>
      ) : (
        <ul className="fy-session-rows">
          {sessions.map(session => {
            const { config, state } = session;
            const activityAt = state.lastActivityAt ?? config.updatedAt;
            return (
              <li className="fy-session-row-item" key={`${daemonId}:${config.id}`}>
                <button
                  className="fy-session-row"
                  onClick={() => onOpenSession(...sessionNavigation(daemonId, config.id))}
                  type="button"
                >
                  <span className="fy-session-identity">
                    <strong>{config.name}</strong>
                    <small title={config.id}>{config.teammate ?? config.id}</small>
                  </span>
                  <span className="fy-session-task">{config.label ?? config.cwd}</span>
                  <span className="fy-status" style={{ color: statusTone(state.status) }}>
                    <i aria-hidden="true" />
                    {sessionStatusLabel(state.status)}
                  </span>
                  <span className="fy-session-meta">{config.model ?? config.agent}</span>
                  <time className="fy-session-age" dateTime={new Date(activityAt).toISOString()}>
                    {relativeTime(activityAt, now)}
                  </time>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
