/**
 * Fetching one attachment's bytes from the daemon that owns them.
 *
 * The original (`ui/src/lib/api.ts`) had a page-global `api.attachment(
 * sessionId, attachmentId)`. Attachment ids are daemon-local, so with two
 * pairings the same pair of ids names two different files — the read has to
 * carry its daemon or it is a coin flip.
 */

import { attachmentApiPath } from './attachments.ts';
import type { DaemonConnection } from './daemon-connection.ts';
import type { DaemonSessionScope } from './daemon-scope.ts';
import { daemonRequest } from './daemon-transport.ts';
import { browserFetch, DaemonResponseError, type DaemonFetch } from './runtime-models.ts';

const failure = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

/** Reads an attachment as a blob from the daemon that owns the session. */
export const loadAttachmentBlob = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  attachmentId: string,
  signal?: AbortSignal,
  fetcher: DaemonFetch = browserFetch,
): Promise<Blob> => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('attachment scope must belong to the requested daemon');
  const target = daemonRequest(daemon, attachmentApiPath(scope.sessionId, attachmentId), { signal });
  const response = await fetcher(target.url, target.init);
  if (!response.ok) throw await failure(response);
  return await response.blob();
};
