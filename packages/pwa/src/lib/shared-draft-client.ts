/**
 * Reading and editing one session's SHARED DRAFT — the owner's unsent composer, live on each of their
 * devices — on precisely the daemon that owns the session.
 *
 * The daemon sequences every edit (`@ferretry/protocol` `shared-draft.ts`); this module only carries
 * them. Both answers are parsed before anything trusts them, and an answer for another session is
 * refused: a draft is private, and showing somebody else's in this composer would be a leak.
 *
 * A refusal keeps the daemon's own code (`shared_draft_stale`, `shared_draft_too_long`, …) so the
 * composer can tell "read the draft again" from "this is too long" without matching on prose.
 */
import {
  type SharedDraftEdit,
  type SharedDraftEditResult,
  SharedDraftEditResultSchema,
  type SharedDraftSnapshot,
  SharedDraftSnapshotSchema,
} from '@ferretry/protocol';
import type { DaemonConnection } from './daemon-connection.ts';
import type { DaemonSessionScope } from './daemon-scope.ts';
import { daemonRequest } from './daemon-transport.ts';
import { browserFetch, type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

export const sharedDraftPath = (scope: DaemonSessionScope): string =>
  `/v1/sessions/${encodeURIComponent(scope.sessionId)}/shared-draft`;

const responseError = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

const assertScopeDaemon = (daemon: DaemonConnection, scope: DaemonSessionScope): void => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('draft scope must belong to the requested daemon');
};

const answer = async (fetcher: DaemonFetch, request: { readonly url: string; readonly init: RequestInit }) => {
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  return (await response.json()) as unknown;
};

const ownSession = (scope: DaemonSessionScope, snapshot: SharedDraftSnapshot): SharedDraftSnapshot => {
  if (snapshot.sessionId !== scope.sessionId)
    throw new DaemonResponseError(502, 'the daemon answered with another session’s draft');
  return snapshot;
};

/** The draft as the daemon holds it now. */
export const fetchSharedDraft = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch = browserFetch,
): Promise<SharedDraftSnapshot> => {
  assertScopeDaemon(daemon, scope);
  const request = daemonRequest(daemon, sharedDraftPath(scope), { method: 'GET' });
  const parsed = SharedDraftSnapshotSchema.safeParse(await answer(fetcher, request));
  if (!parsed.success) throw new DaemonResponseError(502, 'the daemon answered with no draft');
  return ownSession(scope, parsed.data);
};

/** Sends one edit and answers with it as the daemon sequenced it, and the draft after it. */
export const editSharedDraft = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  edit: SharedDraftEdit,
  fetcher: DaemonFetch = browserFetch,
): Promise<SharedDraftEditResult> => {
  assertScopeDaemon(daemon, scope);
  const request = daemonRequest(daemon, sharedDraftPath(scope), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(edit),
  });
  const parsed = SharedDraftEditResultSchema.safeParse(await answer(fetcher, request));
  if (!parsed.success) throw new DaemonResponseError(502, 'the daemon answered the edit with no draft');
  ownSession(scope, parsed.data.snapshot);
  return parsed.data;
};
