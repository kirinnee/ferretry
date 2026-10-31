/**
 * The browser's half of the input bridge: read the open requests, deliver one, cancel one.
 *
 * Every call goes through a connection-bound client and nothing is cached at module scope: a request
 * belongs to one machine's session. The deliver body is the only place a value travels, padded, and this
 * module never keeps it. The carrier-routed client answers a step-up refusal itself (it asks for a passkey
 * and sends the request again), so a deliver that needs one needs no code here.
 */

import {
  type IFyApiClient,
  type InputDeliverBody,
  InputDeliverBodySchema,
  type InputDeliverResult,
  InputDeliverResultSchema,
  type InputRequest,
  type InputRequestList,
  InputRequestListSchema,
  type InputShot,
  InputShotSchema,
} from '@ferretry/protocol';
import { z } from 'zod';

export type InputClient = Pick<IFyApiClient, 'request'>;

const sessionPath = (sessionId: string): string => `/v1/sessions/${encodeURIComponent(sessionId)}/input-requests`;

async function listSessionInputRequests(client: InputClient, sessionId: string): Promise<InputRequestList> {
  return await client.request(sessionPath(sessionId), InputRequestListSchema);
}

/** The request an `input` agenda item points at, or `undefined` once the daemon no longer lists it. */
export async function readInputRequest(
  client: InputClient,
  sessionId: string,
  requestId: string,
): Promise<InputRequest | undefined> {
  const { requests } = await listSessionInputRequests(client, sessionId);
  return requests.find(request => request.id === requestId);
}

export async function deliverInput(
  client: InputClient,
  request: Pick<InputRequest, 'id' | 'sessionId'>,
  body: InputDeliverBody,
): Promise<InputDeliverResult> {
  return await client.request(
    `${sessionPath(request.sessionId)}/${encodeURIComponent(request.id)}/deliver`,
    InputDeliverResultSchema,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(InputDeliverBodySchema.parse(body)),
    },
  );
}

/** The picture of a page request's fields, taken before anything was typed. Only a request marked `pictured` has one. */
export async function readInputShot(
  client: InputClient,
  request: Pick<InputRequest, 'id' | 'sessionId'>,
): Promise<InputShot> {
  return await client.request(
    `${sessionPath(request.sessionId)}/${encodeURIComponent(request.id)}/shot`,
    InputShotSchema,
    { method: 'GET' },
  );
}

export async function cancelInput(client: InputClient, request: Pick<InputRequest, 'id' | 'sessionId'>): Promise<void> {
  await client.request(`${sessionPath(request.sessionId)}/${encodeURIComponent(request.id)}/cancel`, z.unknown(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}
