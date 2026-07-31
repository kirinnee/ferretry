import type { SessionView } from '@ferretry/protocol';
import { relativeTime, sessionStatusLabel } from '../lib/session-screens.ts';

export interface SessionDetailsProps {
  readonly daemonId: string;
  readonly session: SessionView;
  readonly now?: number;
  readonly onClose?: () => void;
}

/**
 * Session metadata lives behind a labelled panel instead of becoming permanent
 * transcript chrome. Hosts can present this as a desktop side panel or mobile
 * bottom sheet without changing the information hierarchy.
 */
export function SessionDetails({ daemonId, session, now = Date.now(), onClose }: SessionDetailsProps) {
  const { config, state } = session;
  return (
    <aside aria-label="Session details" className="fy-session-details">
      <header className="fy-detail-header">
        <div>
          <p className="fy-eyebrow">Session details</p>
          <h2>{config.name}</h2>
        </div>
        {onClose ? (
          <button aria-label="Close session details" className="fy-icon-button" onClick={onClose} type="button">
            ×
          </button>
        ) : null}
      </header>
      <dl>
        <Detail label="Status" value={sessionStatusLabel(state.status)} />
        <Detail label="Mode" value={config.mode} />
        <Detail label="Model" value={(config.model ?? config.modelHint) || '—'} />
        <Detail label="Turn" value={String(state.turn)} />
        <Detail label="Context" value={state.contextPercent === undefined ? '—' : `${state.contextPercent}%`} />
        <Detail label="Activity" value={state.activity ?? 'No activity recorded'} />
        <Detail label="Last active" value={relativeTime(state.lastActivityAt, now)} />
        <Detail label="Daemon" value={daemonId} />
        <Detail label="Session ID" value={config.id} />
        {config.parent ? <Detail label="Parent" value={config.parent} /> : null}
      </dl>
    </aside>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="fy-detail-row">
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}
