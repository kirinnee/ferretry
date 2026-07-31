import { AttentionSnapshotSchema, type AttentionActionRequest, type AttentionSnapshot } from '@ferretry/protocol';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { daemonRequest } from '../../lib/daemon-transport.ts';
import { DaemonResponseError, type DaemonFetch } from '../../lib/runtime-models.ts';

const attentionPath = (sessionId: string): string => `/v1/sessions/${encodeURIComponent(sessionId)}/attention`;

const responseError = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

const requestAttention = async (
  connection: DaemonConnection,
  sessionId: string,
  init: RequestInit = {},
  fetcher: DaemonFetch = fetch,
): Promise<AttentionSnapshot> => {
  const request = daemonRequest(connection, attentionPath(sessionId), init);
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  const snapshot = AttentionSnapshotSchema.parse(await response.json());
  if (snapshot.sessionId !== sessionId) throw new Error('daemon returned attention for another session');
  return snapshot;
};

/** Fetches a complete attention ledger from exactly the paired daemon. */
export const fetchAttention = (
  connection: DaemonConnection,
  sessionId: string,
  fetcher: DaemonFetch = fetch,
): Promise<AttentionSnapshot> => requestAttention(connection, sessionId, {}, fetcher);

/** Resolves or dismisses an item and returns the daemon's new authoritative ledger. */
export const actOnAttention = (
  connection: DaemonConnection,
  sessionId: string,
  action: AttentionActionRequest,
  fetcher: DaemonFetch = fetch,
): Promise<AttentionSnapshot> =>
  requestAttention(
    connection,
    sessionId,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kteam-request-id': crypto.randomUUID() },
      body: JSON.stringify(action),
    },
    fetcher,
  );
