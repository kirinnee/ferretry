import type { SessionView } from '@ferretry/protocol';
import { sessionStatusLabel } from '../lib/session-screens.ts';
import { ModeBadge } from './mode-badge.tsx';
import { StatusMark } from './status-mark.tsx';

export interface SessionHeaderProps {
  /** The paired daemon owns navigation; session ids are not fleet-global. */
  readonly daemonId: string;
  readonly session: SessionView;
  readonly onOpenFleet?: (daemonId: string) => void;
  readonly onBack?: (daemonId: string) => void;
  readonly onOpenDetails?: (daemonId: string, sessionId: string) => void;
}

/**
 * The steering-only session bar from the source chat page.  Its compact shape
 * intentionally has just fleet, back/identity, and details targets on a
 * phone; status and mode remain available in the details panel rather than
 * consuming transcript width.
 */
export function SessionHeader({ daemonId, session, onOpenFleet, onBack, onOpenDetails }: SessionHeaderProps) {
  const { config, state } = session;
  const title = config.label ?? config.name ?? config.id;
  const status = sessionStatusLabel(state.status);

  return (
    <header className="fy-session-header" data-daemon-id={daemonId}>
      <div className="fy-session-header-mobile-actions">
        {onOpenFleet ? (
          <button aria-label="Open sessions" onClick={() => onOpenFleet(daemonId)} type="button">
            ☰
          </button>
        ) : null}
        {onBack ? (
          <button aria-label="Back to sessions" onClick={() => onBack(daemonId)} type="button">
            ‹
          </button>
        ) : null}
      </div>
      <div className="fy-session-header-identity">
        <p className="fy-eyebrow">{config.teammate ?? config.agent}</p>
        <h1 title={title}>{title}</h1>
        <span className="fy-session-header-id" title={config.id}>
          {config.id}
        </span>
      </div>
      <div className="fy-session-header-meta">
        <span className="fy-status">
          <StatusMark view={session} />
          {status}
        </span>
        <ModeBadge mode={config.mode} size="sm" />
      </div>
      {onOpenDetails ? (
        <button
          aria-label="Open session details"
          className="fy-session-header-details"
          onClick={() => onOpenDetails(daemonId, config.id)}
          type="button"
        >
          <span aria-hidden="true">•••</span>
          <span className="sr-only">Session details</span>
        </button>
      ) : null}
    </header>
  );
}
