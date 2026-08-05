import { type DaemonId, daemonId } from '../daemon-connection.ts';
import { daemonSessionKey, daemonSessionScope } from '../daemon-scope.ts';

/** The route shown before a browser has selected one of its paired daemons. */
export interface ConnectionPickerRoute {
  readonly kind: 'connection-picker';
}

/**
 * The first-run setup guide, as a real route.
 *
 * Setup is a journey through a terminal on another machine: the reader leaves,
 * runs a command, and comes back — sometimes by reloading, sometimes hours
 * later. A component-local step would not survive that, and a landing page
 * cannot link to a state that has no address, so the stepper gets a pathname.
 */
export interface SetupRoute {
  readonly kind: 'setup';
}

export interface DaemonSessionsRoute {
  readonly kind: 'sessions';
  readonly daemonId: DaemonId;
}

export interface DaemonNewSessionRoute {
  readonly kind: 'new-session';
  readonly daemonId: DaemonId;
}

export interface DaemonProjectsRoute {
  readonly kind: 'projects';
  readonly daemonId: DaemonId;
}

export interface DaemonSessionRoute {
  readonly kind: 'session';
  readonly daemonId: DaemonId;
  readonly sessionId: string;
}

export interface DaemonSettingsRoute {
  readonly kind: 'settings';
  readonly daemonId: DaemonId;
}

export interface DaemonWardenRoute {
  readonly kind: 'warden';
  readonly daemonId: DaemonId;
}

export interface DaemonAnalyticsRoute {
  readonly kind: 'analytics';
  readonly daemonId: DaemonId;
}

export interface DaemonLearningRoute {
  readonly kind: 'learning';
  readonly daemonId: DaemonId;
}

export interface DaemonImportedHistoryRoute {
  readonly kind: 'imported-history';
  readonly daemonId: DaemonId;
}

export type DaemonPageRoute =
  | DaemonSessionsRoute
  | DaemonNewSessionRoute
  | DaemonProjectsRoute
  | DaemonSessionRoute
  | DaemonSettingsRoute
  | DaemonWardenRoute
  | DaemonAnalyticsRoute
  | DaemonLearningRoute
  | DaemonImportedHistoryRoute;

export type PageRoute = ConnectionPickerRoute | SetupRoute | DaemonPageRoute;

/** A compatibility result that callers can replace with its canonical target. */
export interface LegacyTasksRedirectRoute {
  readonly kind: 'legacy-tasks-redirect';
  readonly to: DaemonSessionsRoute;
}

export type Route = PageRoute | LegacyTasksRedirectRoute;

const connectionPicker: ConnectionPickerRoute = { kind: 'connection-picker' };
const setup: SetupRoute = { kind: 'setup' };

/** Decodes a single URL pathname segment without allowing malformed input to escape the router. */
export const decodeRouteSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

const parsedDaemonId = (segment: string | undefined): DaemonId | undefined => {
  if (segment === undefined) return undefined;

  try {
    return daemonId(decodeRouteSegment(segment));
  } catch {
    return undefined;
  }
};

const parsedSessionId = (segment: string | undefined): string | undefined => {
  if (segment === undefined) return undefined;
  const sessionId = decodeRouteSegment(segment);
  return sessionId.trim() === '' ? undefined : sessionId;
};

/** Builds the canonical connection-picker pathname. */
export const connectionPickerPath = (): '/' => '/';

/** Builds the canonical setup pathname. The one address a landing page may link to. */
export const setupPath = (): '/setup' => '/setup';

/** Builds the canonical sessions pathname for one daemon. */
export const daemonSessionsPath = (id: DaemonId): string => `/d/${encodeURIComponent(id)}`;

/** Builds the canonical new-session pathname for one daemon. */
export const daemonNewSessionPath = (id: DaemonId): string => `${daemonSessionsPath(id)}/new`;

/** Builds the canonical durable-project hub pathname for one daemon. */
export const daemonProjectsPath = (id: DaemonId): string => `${daemonSessionsPath(id)}/projects`;

/** Builds the canonical session pathname for one daemon and session. */
export const daemonSessionPath = (id: DaemonId, sessionId: string): string => {
  const scope = daemonSessionScope({ daemonId: id }, sessionId);
  return `${daemonSessionsPath(id)}/session/${encodeURIComponent(scope.sessionId)}`;
};

/** Builds the canonical settings pathname for one daemon. */
export const daemonSettingsPath = (id: DaemonId): string => `${daemonSessionsPath(id)}/settings`;

/** Builds the canonical Warden pathname for one daemon. */
export const daemonWardenPath = (id: DaemonId): string => `${daemonSessionsPath(id)}/warden`;

/** Builds the canonical analytics pathname for one daemon. */
export const daemonAnalyticsPath = (id: DaemonId): string => `${daemonSessionsPath(id)}/analytics`;

/** Builds the canonical learning pathname for one daemon. */
export const daemonLearningPath = (id: DaemonId): string => `${daemonSessionsPath(id)}/learning`;

/** Builds the canonical history-import pathname for one daemon. */
export const daemonImportedHistoryPath = (id: DaemonId): string => `${daemonSessionsPath(id)}/history`;

/** Resolves a browser pathname to the page model, without consulting browser globals. */
export const parseRoute = (pathname: string): Route => {
  const [first, daemonSegment, destination, sessionSegment, ...remainder] = pathname.split('/').filter(Boolean);
  if (first === 'setup') return setup;
  if (first !== 'd') return connectionPicker;

  const id = parsedDaemonId(daemonSegment);
  if (id === undefined) return connectionPicker;

  if (sessionSegment === undefined && remainder.length === 0) {
    if (destination === 'new') return { kind: 'new-session', daemonId: id };
    if (destination === 'projects') return { kind: 'projects', daemonId: id };
    if (destination === 'settings') return { kind: 'settings', daemonId: id };
    if (destination === 'warden') return { kind: 'warden', daemonId: id };
    if (destination === 'analytics') return { kind: 'analytics', daemonId: id };
    if (destination === 'learning') return { kind: 'learning', daemonId: id };
    if (destination === 'history') return { kind: 'imported-history', daemonId: id };
    if (destination === 'tasks') return { kind: 'legacy-tasks-redirect', to: { kind: 'sessions', daemonId: id } };
  }

  if (remainder.length === 0) {
    const sessionId = destination === 'session' ? parsedSessionId(sessionSegment) : undefined;
    if (sessionId !== undefined) return { kind: 'session', daemonId: id, sessionId };
  }

  return { kind: 'sessions', daemonId: id };
};

/** Returns the canonical pathname for a parsed page or compatibility redirect. */
export const routePath = (route: Route): string => {
  switch (route.kind) {
    case 'connection-picker':
      return connectionPickerPath();
    case 'setup':
      return setupPath();
    case 'sessions':
      return daemonSessionsPath(route.daemonId);
    case 'new-session':
      return daemonNewSessionPath(route.daemonId);
    case 'projects':
      return daemonProjectsPath(route.daemonId);
    case 'session':
      return daemonSessionPath(route.daemonId, route.sessionId);
    case 'settings':
      return daemonSettingsPath(route.daemonId);
    case 'warden':
      return daemonWardenPath(route.daemonId);
    case 'analytics':
      return daemonAnalyticsPath(route.daemonId);
    case 'learning':
      return daemonLearningPath(route.daemonId);
    case 'imported-history':
      return daemonImportedHistoryPath(route.daemonId);
    case 'legacy-tasks-redirect':
      return routePath(route.to);
  }
};

/**
 * Returns a stable, collision-safe key for retaining a page instance.
 * Session keys deliberately share the daemon-session seam used by caches.
 */
export const routePageKey = (route: Route): string => {
  if (route.kind === 'legacy-tasks-redirect') return routePageKey(route.to);
  if (route.kind === 'connection-picker' || route.kind === 'setup') return route.kind;
  if (route.kind === 'session') return `session:${daemonSessionKey(daemonSessionScope(route, route.sessionId))}`;
  return `${route.kind}:${JSON.stringify(route.daemonId)}`;
};
