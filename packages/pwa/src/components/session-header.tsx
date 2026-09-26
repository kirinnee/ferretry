import type { SessionView } from '@ferretry/protocol';
import { useAccountPickerSlice } from '../hooks/use-account-picker.ts';
import type { PickerAccount } from '../lib/account-picker-catalog.ts';
import type { DaemonAccountPickerStore } from '../lib/account-picker-store.ts';
import { displayCallsign } from '../lib/callsign.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { sessionStatusLabel } from '../lib/session-screens.ts';
import { sessionAccountLabel } from './daemon-picker-model.ts';
import { ModeBadge } from './mode-badge.tsx';
import { StatusMark } from './status-mark.tsx';

export interface SessionHeaderProps {
  /** The paired daemon owns navigation; session ids are not fleet-global. */
  readonly daemonId: string;
  readonly session: SessionView;
  /**
   * The daemon's account roster. Read, the eyebrow names the session's account
   * the way the pickers do; absent or `null` (unread), it falls back to the
   * wrapper id only when there is no callsign to show instead.
   */
  readonly accounts?: readonly PickerAccount[] | null;
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
/**
 * The eyebrow: whose session this is. The callsign is a person-readable name —
 * picked from a pool of given names, or chosen by whoever renamed the session —
 * so it leads; the account follows it once the roster can name it.
 */
const identityLine = (session: SessionView, accounts: readonly PickerAccount[] | null): string => {
  const { config } = session;
  const callsign = displayCallsign(config.teammate);
  if (accounts === null) return callsign || config.agent;
  const account = sessionAccountLabel(accounts, config.agent).name;
  return callsign === '' ? account : `${callsign} · ${account}`;
};

export function SessionHeader({
  daemonId,
  session,
  accounts = null,
  onOpenFleet,
  onBack,
  onOpenDetails,
}: SessionHeaderProps) {
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
        <p className="fy-eyebrow" title={config.agent}>
          {identityLine(session, accounts)}
        </p>
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

export interface RosterSessionHeaderProps extends Omit<SessionHeaderProps, 'accounts'> {
  readonly accountPicker: DaemonAccountPickerStore;
  readonly connection: DaemonConnection;
}

/**
 * The header with the roster read for it, through the same hook and store the
 * migrate sheet uses — so opening a session does not add a read of its own.
 */
export function RosterSessionHeader({ accountPicker, connection, ...props }: RosterSessionHeaderProps) {
  const slice = useAccountPickerSlice(accountPicker, connection);
  return <SessionHeader {...props} accounts={slice.catalog?.accounts ?? null} />;
}
