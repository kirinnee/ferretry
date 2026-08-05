import {
  type CloseTerminalResponse,
  CloseTerminalResponseSchema,
  type CreateTerminalRequest,
  CreateTerminalRequestSchema,
  FY_REQUEST_ID_HEADER,
  RenameTerminalRequestSchema,
  SocketTicketResponseSchema,
  TerminalIdSchema,
  type TerminalListView,
  TerminalListViewSchema,
  type TerminalView,
  TerminalViewSchema,
} from '@ferretry/protocol';
import type { DaemonConnection } from './daemon-connection.ts';
import type { DaemonSessionScope } from './daemon-scope.ts';
import { daemonRequest } from './daemon-transport.ts';
import { browserFetch, type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

const assertScopeDaemon = (daemon: DaemonConnection, scope: DaemonSessionScope): void => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('terminal scope must belong to the requested daemon');
};

const terminalsPath = (scope: DaemonSessionScope): string =>
  `/v1/sessions/${encodeURIComponent(scope.sessionId)}/terminals`;

/**
 * Terminal identity is daemon-issued and lands in a URL path, so it is parsed
 * before use rather than trusted from whichever view supplied it.
 */
const terminalPath = (scope: DaemonSessionScope, terminalId: string): string =>
  `${terminalsPath(scope)}/${encodeURIComponent(TerminalIdSchema.parse(terminalId))}`;

const responseError = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

/**
 * Every terminal call is addressed to exactly one paired daemon. There is no
 * page-relative overload: a session ID reused across two daemons must never
 * resolve to whichever daemon happens to be current.
 */
const terminalJson = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  path: string,
  init: RequestInit,
  fetcher: DaemonFetch,
): Promise<unknown> => {
  assertScopeDaemon(daemon, scope);
  const mutation = (init.method ?? 'GET').toUpperCase() !== 'GET';
  const request = daemonRequest(daemon, path, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(mutation ? { [FY_REQUEST_ID_HEADER]: crypto.randomUUID() } : {}),
    },
  });
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  return await response.json();
};

const parseTerminal = (scope: DaemonSessionScope, body: unknown): TerminalView => {
  const view = TerminalViewSchema.parse(body);
  if (view.sessionId !== scope.sessionId) throw new DaemonResponseError(502, 'daemon returned another session');
  return view;
};

/** Lists the terminals the paired daemon owns for one of its sessions. */
export const listSessionTerminals = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch = browserFetch,
): Promise<TerminalListView> => {
  const body = await terminalJson(daemon, scope, terminalsPath(scope), {}, fetcher);
  const list = TerminalListViewSchema.parse(body);
  if (list.sessionId !== scope.sessionId) throw new DaemonResponseError(502, 'daemon listed another session');
  return list;
};

/** Opens a terminal, letting the daemon choose any size the caller omits. */
export const createSessionTerminal = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  request: CreateTerminalRequest = {},
  fetcher: DaemonFetch = browserFetch,
): Promise<TerminalView> => {
  const body = await terminalJson(
    daemon,
    scope,
    terminalsPath(scope),
    { method: 'POST', body: JSON.stringify(CreateTerminalRequestSchema.parse(request)) },
    fetcher,
  );
  return parseTerminal(scope, body);
};

/** Retitles one terminal on the daemon that owns it. */
export const renameSessionTerminal = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  terminalId: string,
  title: string,
  fetcher: DaemonFetch = browserFetch,
): Promise<TerminalView> => {
  const body = await terminalJson(
    daemon,
    scope,
    terminalPath(scope, terminalId),
    { method: 'PATCH', body: JSON.stringify(RenameTerminalRequestSchema.parse({ title })) },
    fetcher,
  );
  return parseTerminal(scope, body);
};

/** Closes one terminal, confirming the daemon closed the one that was asked for. */
export const closeSessionTerminal = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  terminalId: string,
  fetcher: DaemonFetch = browserFetch,
): Promise<CloseTerminalResponse> => {
  const body = await terminalJson(daemon, scope, terminalPath(scope, terminalId), { method: 'DELETE' }, fetcher);
  const closed = CloseTerminalResponseSchema.parse(body);
  if (closed.id !== terminalId) throw new DaemonResponseError(502, 'daemon closed another terminal');
  return closed;
};

/**
 * Buys the short-lived credential a browser WebSocket can actually carry.
 *
 * The device token remains in this header-carrying request; it is never copied into the resulting
 * stream URL. The daemon binds the ticket to this exact `(daemon, session, terminal)` stream, and
 * the local scope assertion prevents a same-named session on another pairing from being substituted.
 */
export const daemonTerminalTicket = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  terminalId: string,
  fetcher: DaemonFetch = browserFetch,
): Promise<string> => {
  assertScopeDaemon(daemon, scope);
  const request = daemonRequest(daemon, `${terminalPath(scope, terminalId)}/stream/ticket`, { method: 'POST' });
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  return SocketTicketResponseSchema.parse(await response.json()).ticket;
};

/**
 * Builds a viewer URL from a per-connection ticket on the paired daemon.  The
 * device token is deliberately absent: it would outlive the socket in any log
 * or history that retains the URL, and the page origin is never the daemon.
 */
export const terminalStreamUrl = (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  terminalId: string,
  ticket: string,
): string => {
  assertScopeDaemon(daemon, scope);
  if (ticket.trim() === '') throw new Error('terminal stream ticket must not be empty');
  const url = new URL(`${terminalPath(scope, terminalId)}/stream`, `${daemon.baseUrl}/`);
  if (url.origin !== new URL(daemon.baseUrl).origin)
    throw new Error('terminal stream must remain on the paired daemon');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket);
  return url.toString();
};

/**
 * The original wording is preserved verbatim: "this box" is the daemon serving
 * the list, which is now one of several a reader may have paired.
 */
export const terminalLimitLabel = (list: TerminalListView): string =>
  `${list.terminals.length}/${list.limits.perSession} in this session · ${list.limits.runningGlobal}/${list.limits.global} on this box`;
