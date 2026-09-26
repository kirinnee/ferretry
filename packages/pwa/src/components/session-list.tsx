import type { SessionView } from '@ferretry/protocol';
import type { PickerAccount } from '../lib/account-picker-catalog.ts';
import { relativeTime, sessionNavigation, sessionStatusLabel } from '../lib/session-screens.ts';
import { sessionAccountLabel } from './daemon-picker-model.ts';
import { ModeBadge } from './mode-badge.tsx';
import { QuotaReadout } from './quota-readout.tsx';
import { StatusMark } from './status-mark.tsx';

export interface SessionListProps {
  readonly daemonId: string;
  readonly sessions: readonly SessionView[];
  /** The daemon's account roster; absent or `null` (unread) keeps the old model-or-wrapper line. */
  readonly accounts?: readonly PickerAccount[] | null;
  readonly now?: number;
  readonly onOpenSession: (daemonId: string, sessionId: string) => void;
}

/**
 * Fleet rows deliberately receive the daemon id from their host. The same
 * session id may exist on multiple paired daemons, so navigation never relies
 * on an ambient/global connection.
 */
/** The row's meta line: the account by its fleet name, then the model when one was asked for. */
const metaLine = (session: SessionView, accounts: readonly PickerAccount[] | null): string => {
  const { config } = session;
  if (accounts === null) return config.model ?? config.agent;
  const account = sessionAccountLabel(accounts, config.agent).name;
  return config.model === undefined ? account : `${account} · ${config.model}`;
};

export function SessionList({
  daemonId,
  sessions,
  accounts = null,
  now = Date.now(),
  onOpenSession,
}: SessionListProps) {
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
                  <span className="fy-status">
                    <StatusMark view={session} />
                    {sessionStatusLabel(state.status)}
                  </span>
                  <ModeBadge mode={config.mode} size="sm" />
                  <span className="fy-session-meta" title={config.agent}>
                    {metaLine(session, accounts)}
                  </span>
                  <QuotaReadout className="fy-session-quota" quota={state.quota} showUnknown />
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
