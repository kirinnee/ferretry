import {
  type InputDeliverBody,
  InputDeliverBodySchema,
  type InputDeliverResult,
  InputDeliverResultSchema,
  type InputRequest,
  type InputRequestList,
  InputRequestListSchema,
  InputRequestSchema,
} from '@ferretry/protocol';
import { FY_CLIENT_HEADER, FY_CLIENT_NAME } from '../session/connection.ts';
import type { IInputGateway, InputApiClient } from './ports.ts';

/** The daemon route that lists one session's open input requests. */
export function inputRequestsPath(sessionId: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/input-requests`;
}

/** The daemon route that delivers a value to one request. */
export function inputDeliverPath(sessionId: string, requestId: string): string {
  return `${inputRequestsPath(sessionId)}/${encodeURIComponent(requestId)}/deliver`;
}

/** The daemon route that declines one request. */
export function inputCancelPath(sessionId: string, requestId: string): string {
  return `${inputRequestsPath(sessionId)}/${encodeURIComponent(requestId)}/cancel`;
}

/**
 * Speaks the input routes as the person at this machine. It never sends the session header: an input
 * request is the owner's to answer, and a call that names a ferret session is refused by the daemon.
 * Requests and replies are parsed against the protocol schemas; nothing here logs a body.
 */
export class ProtocolInputGateway implements IInputGateway {
  readonly #headers = { [FY_CLIENT_HEADER]: FY_CLIENT_NAME };

  constructor(private readonly client: InputApiClient) {}

  async list(sessionId: string): Promise<InputRequestList> {
    return await this.client.request(inputRequestsPath(sessionId), InputRequestListSchema, { headers: this.#headers });
  }

  async deliver(sessionId: string, requestId: string, body: InputDeliverBody): Promise<InputDeliverResult> {
    return await this.client.request(inputDeliverPath(sessionId, requestId), InputDeliverResultSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.#headers },
      body: JSON.stringify(InputDeliverBodySchema.parse(body)),
    });
  }

  async cancel(sessionId: string, requestId: string): Promise<InputRequest> {
    return await this.client.request(inputCancelPath(sessionId, requestId), InputRequestSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.#headers },
      body: JSON.stringify({}),
    });
  }
}
