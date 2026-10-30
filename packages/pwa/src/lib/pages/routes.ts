import { BoardProjectIdSchema, ProjectInfoSchema } from '@ferretry/protocol';

import { type DaemonId, daemonId } from '../daemon-connection.ts';
import { daemonSessionKey, daemonSessionScope } from '../daemon-scope.ts';

/**
 * WHAT A PROJECT ID IS HAS ONE OWNER, and it is not this file.
 *
 * `ProjectInfoSchema` declares `id` a UUID and says in as many words that a path
 * is not an identity. Restating that here as a regex would be a second
 * declaration free to drift from the one the daemon and the registry agree on,
 * so the router borrows the protocol's own field schema instead.
 */
const ProjectIdSchema = ProjectInfoSchema.shape.id;

const isProjectId = (value: string): boolean => ProjectIdSchema.safeParse(value).success;

/** A board's project is a registered UUID or the Unfiled board; the lane editor serves both. */
const isBoardProjectId = (value: string): boolean => BoardProjectIdSchema.safeParse(value).success;

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

/** One durable registered Project, addressed by its protocol UUID rather than its path. */
export interface DaemonProjectDetailRoute {
  readonly kind: 'project-detail';
  readonly daemonId: DaemonId;
  readonly projectId: string;
}

/** One project's lane editor: the Board's lanes, edited, proposed or picked from a template. */
export interface DaemonProjectLanesRoute {
  readonly kind: 'project-lanes';
  readonly daemonId: DaemonId;
  readonly projectId: string;
}

export interface DaemonSessionRoute {
  readonly kind: 'session';
  readonly daemonId: DaemonId;
  readonly sessionId: string;
}

/**
 * The Inbox: every open item, across every paired machine, newest first. Addressed under the
 * machine on screen only because every page is — the deck itself is not one machine's.
 */
export interface DaemonAgendaRoute {
  readonly kind: 'attention';
  readonly daemonId: DaemonId;
}

/**
 * The Board: every card on every paired machine, as lanes. `taskId` is the card the address names; the Board
 * page stays the same page when it changes (the card detail opens over it), so it is not part of the page key.
 */
export interface DaemonBoardRoute {
  readonly kind: 'board';
  readonly daemonId: DaemonId;
  readonly taskId?: string;
}

export interface DaemonSettingsRoute {
  readonly kind: 'settings';
  readonly daemonId: DaemonId;
}

export interface DaemonWardenRoute {
  readonly kind: 'warden';
  readonly daemonId: DaemonId;
}

/** Analytics' two pages: the Overview of a period, and the Query page. */
export type AnalyticsView = 'overview' | 'query';

export interface DaemonAnalyticsRoute {
  readonly kind: 'analytics';
  readonly daemonId: DaemonId;
  /** Absent means the Overview, so every older `{ kind: 'analytics' }` still names it. */
  readonly view?: AnalyticsView;
}

export interface DaemonLearningRoute {
  readonly kind: 'learning';
  readonly daemonId: DaemonId;
}

export interface DaemonImportedHistoryRoute {
  readonly kind: 'imported-history';
  readonly daemonId: DaemonId;
}

/**
 * One machine's first run, full screen and outside Settings: what pairing a machine that is not set up
 * yet opens. It is a one-time guided job, so it gets no app chrome — only its own named stepper.
 */
export interface DaemonMachineSetupRoute {
  readonly kind: 'machine-setup';
  readonly daemonId: DaemonId;
}

export type DaemonPageRoute =
  | DaemonSessionsRoute
  | DaemonNewSessionRoute
  | DaemonProjectsRoute
  | DaemonProjectDetailRoute
  | DaemonProjectLanesRoute
  | DaemonSessionRoute
  | DaemonAgendaRoute
  | DaemonBoardRoute
  | DaemonSettingsRoute
  | DaemonWardenRoute
  | DaemonAnalyticsRoute
  | DaemonLearningRoute
  | DaemonImportedHistoryRoute
  | DaemonMachineSetupRoute;

export type PageRoute = ConnectionPickerRoute | SetupRoute | DaemonPageRoute;

/** A compatibility result that callers can replace with its canonical target. */
export interface LegacyTasksRedirectRoute {
  readonly kind: 'legacy-tasks-redirect';
  readonly to: DaemonBoardRoute;
}

/** The Inbox's old `/attention` address, which now redirects to `/inbox` keeping its query. */
export interface LegacyAttentionRedirectRoute {
  readonly kind: 'legacy-attention-redirect';
  readonly to: DaemonAgendaRoute;
}

export type Route = PageRoute | LegacyTasksRedirectRoute | LegacyAttentionRedirectRoute;

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

/** Builds the canonical UUID-addressed project detail pathname for one daemon. */
export const daemonProjectPath = (id: DaemonId, projectId: string): string => {
  const value = projectId.trim();
  if (value === '') throw new Error('projectId must not be empty');
  // A path, a name or a folder somebody typed all reach here as a non-empty
  // string. Refusing them at the builder is what stops a link that LOOKS like a
  // project address from being minted at all.
  if (!isProjectId(value)) throw new Error('projectId must be a registered project UUID');
  return `${daemonProjectsPath(id)}/${encodeURIComponent(value)}`;
};

/** Builds the lane editor pathname for one board project: `/d/<id>/projects/<uuid | unfiled>/lanes`. */
export const daemonProjectLanesPath = (id: DaemonId, projectId: string): string => {
  const value = projectId.trim();
  if (!isBoardProjectId(value)) throw new Error('projectId must be a board project id');
  return `${daemonProjectsPath(id)}/${encodeURIComponent(value)}/lanes`;
};

/** Builds the canonical session pathname for one daemon and session. */
export const daemonSessionPath = (id: DaemonId, sessionId: string): string => {
  const scope = daemonSessionScope({ daemonId: id }, sessionId);
  return `${daemonSessionsPath(id)}/session/${encodeURIComponent(scope.sessionId)}`;
};

/** Builds the Inbox pathname, under the machine on screen. `/attention` is the old spelling and redirects here. */
export const daemonAgendaPath = (id: DaemonId): string => `${daemonSessionsPath(id)}/inbox`;

/** Builds the Board pathname, under the machine on screen. */
export const daemonBoardPath = (id: DaemonId): string => `${daemonSessionsPath(id)}/board`;

/** Builds one card's address on the Board: `/d/<id>/board/<taskId>`. */
export const daemonBoardCardPath = (id: DaemonId, taskId: string): string =>
  `${daemonBoardPath(id)}/${encodeURIComponent(taskId)}`;

/** The Board narrowed to one ferret's cards, with `highlight` (a task id) marked: `/d/<id>/board?ferret=<session>&highlight=<task>`. */
export const daemonBoardForFerretPath = (id: DaemonId, sessionId: string, highlight?: string): string => {
  const query = new URLSearchParams({ ferret: sessionId });
  if (highlight !== undefined) query.set('highlight', highlight);
  return `${daemonBoardPath(id)}?${query.toString()}`;
};

/** Builds the canonical settings pathname for one daemon. */
export const daemonSettingsPath = (id: DaemonId): string => `${daemonSessionsPath(id)}/settings`;

/** Builds the canonical Warden pathname for one daemon. */
export const daemonWardenPath = (id: DaemonId): string => `${daemonSessionsPath(id)}/warden`;

/** Builds the canonical analytics pathname for one daemon. */
export const daemonAnalyticsPath = (id: DaemonId): string => `${daemonSessionsPath(id)}/analytics`;

/**
 * Builds the Analytics › Query pathname for one daemon, with the query as `?q=` when there is one. The
 * query text is the page's source of truth, so a link carries it whole.
 */
export const daemonAnalyticsQueryPath = (id: DaemonId, query?: string | null): string =>
  `${daemonAnalyticsPath(id)}/query${query?.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`;

/** Builds the canonical learning pathname for one daemon. */
export const daemonLearningPath = (id: DaemonId): string => `${daemonSessionsPath(id)}/learning`;

/** Builds the canonical history-import pathname for one daemon. */
export const daemonImportedHistoryPath = (id: DaemonId): string => `${daemonSessionsPath(id)}/history`;

/** Builds one machine's full-screen first run: `/d/<id>/setup`. */
export const daemonMachineSetupPath = (id: DaemonId): string => `${daemonSessionsPath(id)}/setup`;

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
    if (destination === 'inbox') return { kind: 'attention', daemonId: id };
    if (destination === 'attention')
      return { kind: 'legacy-attention-redirect', to: { kind: 'attention', daemonId: id } };
    if (destination === 'warden') return { kind: 'warden', daemonId: id };
    if (destination === 'analytics') return { kind: 'analytics', daemonId: id };
    if (destination === 'learning') return { kind: 'learning', daemonId: id };
    if (destination === 'history') return { kind: 'imported-history', daemonId: id };
    if (destination === 'setup') return { kind: 'machine-setup', daemonId: id };
    if (destination === 'board') return { kind: 'board', daemonId: id };
    if (destination === 'tasks') return { kind: 'legacy-tasks-redirect', to: { kind: 'board', daemonId: id } };
  }

  if (destination === 'board' && sessionSegment !== undefined && remainder.length === 0) {
    const taskId = decodeRouteSegment(sessionSegment);
    return { kind: 'board', daemonId: id, taskId };
  }

  if (destination === 'analytics' && sessionSegment === 'query' && remainder.length === 0)
    return { kind: 'analytics', daemonId: id, view: 'query' };

  if (
    destination === 'projects' &&
    sessionSegment !== undefined &&
    remainder.length === 1 &&
    remainder[0] === 'lanes'
  ) {
    const candidate = decodeRouteSegment(sessionSegment);
    if (isBoardProjectId(candidate)) return { kind: 'project-lanes', daemonId: id, projectId: candidate };
    return { kind: 'projects', daemonId: id };
  }

  if (destination === 'projects' && sessionSegment !== undefined && remainder.length === 0) {
    const candidate = decodeRouteSegment(sessionSegment);
    if (isProjectId(candidate)) return { kind: 'project-detail', daemonId: id, projectId: candidate };
    // A segment under `/projects` that is NOT a record id resolves to the hub,
    // not to the daemon's catch-all: the path names the projects destination and
    // only the identity is unusable. This is also what keeps the segment from
    // swallowing the namespace — a later `/projects/new` is free to become its
    // own route instead of a detail screen for a project called "new".
    return { kind: 'projects', daemonId: id };
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
    case 'project-detail':
      return daemonProjectPath(route.daemonId, route.projectId);
    case 'project-lanes':
      return daemonProjectLanesPath(route.daemonId, route.projectId);
    case 'session':
      return daemonSessionPath(route.daemonId, route.sessionId);
    case 'attention':
      return daemonAgendaPath(route.daemonId);
    case 'board':
      return route.taskId === undefined
        ? daemonBoardPath(route.daemonId)
        : daemonBoardCardPath(route.daemonId, route.taskId);
    case 'settings':
      return daemonSettingsPath(route.daemonId);
    case 'warden':
      return daemonWardenPath(route.daemonId);
    case 'analytics':
      return route.view === 'query' ? daemonAnalyticsQueryPath(route.daemonId) : daemonAnalyticsPath(route.daemonId);
    case 'learning':
      return daemonLearningPath(route.daemonId);
    case 'imported-history':
      return daemonImportedHistoryPath(route.daemonId);
    case 'machine-setup':
      return daemonMachineSetupPath(route.daemonId);
    case 'legacy-tasks-redirect':
    case 'legacy-attention-redirect':
      return routePath(route.to);
  }
};

/**
 * Returns a stable, collision-safe key for retaining a page instance.
 * Session keys deliberately share the daemon-session seam used by caches.
 */
export const routePageKey = (route: Route): string => {
  if (route.kind === 'legacy-tasks-redirect' || route.kind === 'legacy-attention-redirect')
    return routePageKey(route.to);
  if (route.kind === 'connection-picker' || route.kind === 'setup') return route.kind;
  if (route.kind === 'session') return `session:${daemonSessionKey(daemonSessionScope(route, route.sessionId))}`;
  // The two Analytics pages are kept apart, so each keeps its own state while the other is on screen.
  if (route.kind === 'analytics' && route.view === 'query') return `analytics-query:${JSON.stringify(route.daemonId)}`;
  if (route.kind === 'project-detail') return `project-detail:${JSON.stringify([route.daemonId, route.projectId])}`;
  if (route.kind === 'project-lanes') return `project-lanes:${JSON.stringify([route.daemonId, route.projectId])}`;
  return `${route.kind}:${JSON.stringify(route.daemonId)}`;
};
