/**
 * The dials behind Add MCP server…: one ferret's project servers, and a preview and an add for each
 * scope (`@ferretry/protocol` session-mcp; the daemon side is `mounts/session-mcp.ts`).
 *
 * The SCOPE IS THE PATH. A project write and a login write are governed by different capabilities, so
 * the daemon serves each at its own route, and the caller names the scope by which one it dials.
 *
 * A REFUSAL IS THE DAEMON'S SENTENCE. Every non-2xx answer becomes a `DaemonResponseError` carrying the
 * daemon's own `error` text and `code` — "…changed since the preview; review the new diff", "Codex does
 * not read .mcp.json…", a step-up demand — so the form can say exactly what the daemon said.
 *
 * Every answer is PARSED through the shared schema: a preview decides what a person approves, so a body
 * this page cannot read is refused rather than shown.
 */
import {
  type SessionMcpAdded,
  SessionMcpAddedSchema,
  type SessionMcpAddRequest,
  type SessionMcpListing,
  SessionMcpListingSchema,
  type SessionMcpPreview,
  type SessionMcpPreviewRequest,
  SessionMcpPreviewSchema,
  type SessionMcpScope,
} from '@ferretry/protocol';
import type { z } from 'zod';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { daemonRequest } from '../../lib/daemon-transport.ts';
import { type DaemonFetch, DaemonResponseError } from '../../lib/runtime-models.ts';

const assertScopeDaemon = (daemon: DaemonConnection, scope: DaemonSessionScope): void => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('MCP scope must belong to the requested daemon');
};

const failure = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

const jsonPost = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
  cache: 'no-store',
  ...(signal === undefined ? {} : { signal }),
});

const answer = async <Schema extends z.ZodType>(
  daemon: DaemonConnection,
  path: string,
  init: RequestInit,
  schema: Schema,
  fetcher: DaemonFetch,
): Promise<z.output<Schema>> => {
  const target = daemonRequest(daemon, path, init);
  const response = await fetcher(target.url, target.init);
  if (!response.ok) throw await failure(response);
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new DaemonResponseError(502, 'the daemon answered with a body this page cannot read');
  return parsed.data;
};

/** An answer for the other scope than the one dialled is as unreadable as a malformed one. */
const ofScope = <Value extends { readonly scope: SessionMcpScope }>(which: SessionMcpScope, value: Value): Value => {
  if (value.scope !== which)
    throw new DaemonResponseError(502, `the daemon answered for ${value.scope} when ${which} was asked`);
  return value;
};

/** `GET /v1/sessions/:id/mcp`: the project file's servers, or why this ferret has no project scope. */
export const readSessionMcp = (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch,
  signal?: AbortSignal,
): Promise<SessionMcpListing> => {
  assertScopeDaemon(daemon, scope);
  return answer(
    daemon,
    `/v1/sessions/${encodeURIComponent(scope.sessionId)}/mcp`,
    { method: 'GET', cache: 'no-store', ...(signal === undefined ? {} : { signal }) },
    SessionMcpListingSchema,
    fetcher,
  );
};

/** What adding `request` in `which` scope would change. Writes nothing. */
export const previewSessionMcp = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  which: SessionMcpScope,
  request: SessionMcpPreviewRequest,
  fetcher: DaemonFetch,
  signal?: AbortSignal,
): Promise<SessionMcpPreview> => {
  assertScopeDaemon(daemon, scope);
  const body = { name: request.name, server: request.server };
  const preview =
    which === 'project'
      ? await answer(
          daemon,
          `/v1/sessions/${encodeURIComponent(scope.sessionId)}/mcp/project/preview`,
          jsonPost(body, signal),
          SessionMcpPreviewSchema,
          fetcher,
        )
      : await answer(
          daemon,
          `/v1/sessions/${encodeURIComponent(scope.sessionId)}/mcp/login/preview`,
          jsonPost(body, signal),
          SessionMcpPreviewSchema,
          fetcher,
        );
  return ofScope(which, preview);
};

/**
 * The add itself. A project add sends the etag its preview answered with (`null` meaning there was no
 * file) — leaving it out is refused by the daemon; a login add never carries one, so it is dropped.
 */
export const addSessionMcp = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  which: SessionMcpScope,
  request: SessionMcpAddRequest,
  fetcher: DaemonFetch,
): Promise<SessionMcpAdded> => {
  assertScopeDaemon(daemon, scope);
  const added =
    which === 'project'
      ? await answer(
          daemon,
          `/v1/sessions/${encodeURIComponent(scope.sessionId)}/mcp/project`,
          jsonPost(request),
          SessionMcpAddedSchema,
          fetcher,
        )
      : await answer(
          daemon,
          `/v1/sessions/${encodeURIComponent(scope.sessionId)}/mcp/login`,
          jsonPost({ name: request.name, server: request.server }),
          SessionMcpAddedSchema,
          fetcher,
        );
  return ofScope(which, added);
};
