/**
 * The browser's half of "Compact memory at" (docs/compact-at.md): read and set where one ferret squeezes its
 * conversation, through the fetch a screen passes (`useDaemonFetch`), so a daemon only the relay reaches is reached
 * and nothing here carries a credential.
 */

import {
  type CompactAt,
  FY_REQUEST_ID_HEADER,
  type SessionCompactAt,
  type SessionCompactAtPatchResult,
  SessionCompactAtPatchResultSchema,
  SessionCompactAtSchema,
} from '@ferretry/protocol';
import type { DaemonConnection } from './daemon-connection.ts';
import { daemonRequest } from './daemon-transport.ts';
import { type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

const pathFor = (sessionId: string): string => `/v1/sessions/${encodeURIComponent(sessionId)}/compact-at`;

/** The daemon's refusal, in its own words when it gave any. */
const refusal = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

/** The value a launch would use now, and the model's window it is checked against. */
export const getSessionCompactAt = async (
  daemon: DaemonConnection,
  sessionId: string,
  fetcher: DaemonFetch,
): Promise<SessionCompactAt> => {
  const request = daemonRequest(daemon, pathFor(sessionId));
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await refusal(response);
  return SessionCompactAtSchema.parse(await response.json());
};

/** Sets it (`inherit` drops the ferret's own value); a running ferret takes it at its next launch. */
export const patchSessionCompactAt = async (
  daemon: DaemonConnection,
  sessionId: string,
  compactAt: CompactAt | 'inherit',
  fetcher: DaemonFetch,
): Promise<SessionCompactAtPatchResult> => {
  const request = daemonRequest(daemon, pathFor(sessionId), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', [FY_REQUEST_ID_HEADER]: crypto.randomUUID() },
    body: JSON.stringify({ compactAt }),
  });
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await refusal(response);
  return SessionCompactAtPatchResultSchema.parse(await response.json());
};
