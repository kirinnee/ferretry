/**
 * THE ONE FILE THAT KNOWS THE APP SHELL (§5, §9.6).
 *
 * Today's views took a `DaemonConnection`, a `fetcher` from the PWA's store, the PWA's router and its page-path
 * builders. In 5.0 a half is built once per daemon with that daemon's own client (`implementApp`), the shell owns the
 * router, and a screen's address is the manifest's. Everything the views need from that is named here, so the day the
 * shell's surface moves this is the only file to change.
 *
 * Assumed from `@ferretry/app`: `useOptionalRouter()` (whose `route` carries the daemon of a per-daemon screen),
 * `DaemonCallError` (a refused call), and the `/d/<daemon>/<screen path>` address of a per-daemon screen
 * (`routeTable.href`, packages/app/src/router/routes.ts). The shell hands a half no daemon id, so the views read it from
 * the route they are drawn under.
 */
import { DaemonCallError, useOptionalRouter } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';

/** What a view reads and writes through: this daemon's client, already guarded by the inventory (§9.6). */
export type UsageClient = Pick<PluginClient, 'call'>;

/** A daemon's durable paired id, as the shell keys it. */
export type DaemonId = string;

/** The daemon a view talks to. The client is already that daemon's, so this only names it for keys and links. */
export interface DaemonConnection {
  readonly daemonId: DaemonId;
}

/** The id a view uses before the router says which daemon it is under (a test, a screenshot harness). */
export const THIS_DAEMON_ID: DaemonId = 'this-daemon';

/** The name the views give the one daemon a half talks to. */
export const THIS_MACHINE_NAME = 'this machine';

export const daemonConnection = (daemonId: DaemonId): DaemonConnection => ({ daemonId });

/** The daemon the current route is under, or {@link THIS_DAEMON_ID} without a router or a daemon in the route. */
export function useDaemonConnection(): DaemonConnection {
  const route = useOptionalRouter()?.route;
  const daemon = route !== undefined && 'daemon' in route ? route.daemon : undefined;
  return daemonConnection(daemon ?? THIS_DAEMON_ID);
}

// ── The addresses of this plugin's screens and of the ferret chat (manifest `ui.screens` paths) ────────────────────

const daemonBase = (id: DaemonId): string => `/d/${encodeURIComponent(id)}`;

/** `insights` (the overview). */
export const INSIGHTS_PATH = '/insights';
/** `insights-query`. */
export const INSIGHTS_QUERY_PATH = '/insights/query';

export type InsightsView = 'overview' | 'query';

export const daemonInsightsPath = (id: DaemonId): string => `${daemonBase(id)}${INSIGHTS_PATH}`;

export const daemonInsightsQueryPath = (id: DaemonId, query?: string | null): string =>
  `${daemonBase(id)}${INSIGHTS_QUERY_PATH}${query?.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`;

/** A ferret's conversation (Conversation's `chat` screen, `/ferrets/:ferret/chat`). */
export const daemonFerretPath = (id: DaemonId, ferretId: string): string =>
  `${daemonBase(id)}/ferrets/${encodeURIComponent(ferretId)}/chat`;

/** What a refused call carries, whichever way it was refused. */
export interface CallRefusal {
  readonly status: number;
  readonly code: string | undefined;
  readonly message: string;
}

/** A refused call as a {@link CallRefusal}; `undefined` when `error` is not one. */
export const callRefusal = (error: unknown): CallRefusal | undefined =>
  error instanceof DaemonCallError ? { status: error.status, code: error.code, message: error.message } : undefined;

export { DaemonCallError };

/** A ferret on a daemon: the identity a side-pane surface is scoped to (`ferret.side` panels get `subject` = the ferret). */
export interface DaemonSessionScope {
  readonly daemonId: DaemonId;
  readonly sessionId: string;
}

export const daemonSessionScope = (daemon: DaemonConnection, sessionId: string): DaemonSessionScope => {
  if (sessionId.trim() === '') throw new Error('sessionId must not be empty');
  return { daemonId: daemon.daemonId, sessionId };
};
