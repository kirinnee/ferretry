import type { ComponentType } from 'react';

import type { DaemonConnection, DaemonId } from '../daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionScope } from '../daemon-scope.ts';
import type { PageRoute } from './routes.ts';

export interface DaemonPageProps {
  readonly connection: DaemonConnection;
}

export interface SessionChatPageProps extends DaemonPageProps {
  readonly scope: DaemonSessionScope;
}

export interface PageHostSlots {
  readonly ConnectionPicker: ComponentType;
  /** First-run setup. Connection-free: it exists precisely because there is none yet. */
  readonly Setup: ComponentType;
  readonly Sessions: ComponentType<DaemonPageProps>;
  readonly NewSession: ComponentType<DaemonPageProps>;
  readonly SessionChat: ComponentType<SessionChatPageProps>;
  readonly Settings: ComponentType<DaemonPageProps>;
  readonly Warden: ComponentType<DaemonPageProps>;
  readonly Analytics: ComponentType<DaemonPageProps>;
  readonly Learning: ComponentType<DaemonPageProps>;
}

export interface PageHostProps {
  readonly route: PageRoute;
  readonly connection?: DaemonConnection;
  readonly slots: PageHostSlots;
}

const requireRouteConnection = (
  routeDaemonId: DaemonId,
  connection: DaemonConnection | undefined,
): DaemonConnection => {
  if (connection === undefined) throw new Error('a daemon page requires a runtime connection');
  if (connection.daemonId !== routeDaemonId) throw new Error('the runtime connection does not match the route daemon');
  return connection;
};

/**
 * Selects one route-level screen without owning feature data or transports.
 * Every daemon page receives an explicit, route-matched runtime connection;
 * the chat page additionally receives the canonical daemon/session scope.
 */
export function PageHost({ route, connection, slots }: PageHostProps) {
  if (route.kind === 'connection-picker') return <slots.ConnectionPicker />;
  if (route.kind === 'setup') return <slots.Setup />;

  const matchedConnection = requireRouteConnection(route.daemonId, connection);
  switch (route.kind) {
    case 'sessions':
      return <slots.Sessions connection={matchedConnection} />;
    case 'new-session':
      return <slots.NewSession connection={matchedConnection} />;
    case 'session':
      return (
        <slots.SessionChat
          connection={matchedConnection}
          scope={daemonSessionScope(matchedConnection, route.sessionId)}
        />
      );
    case 'settings':
      return <slots.Settings connection={matchedConnection} />;
    case 'warden':
      return <slots.Warden connection={matchedConnection} />;
    case 'analytics':
      return <slots.Analytics connection={matchedConnection} />;
    case 'learning':
      return <slots.Learning connection={matchedConnection} />;
  }
}
