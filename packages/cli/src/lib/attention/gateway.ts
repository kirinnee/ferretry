import {
  type AttentionActionRequest,
  AttentionActionRequestSchema,
  type AttentionSnapshot,
  AttentionSnapshotSchema,
  type DirectNotificationRequest,
  DirectNotificationRequestSchema,
  type DirectNotificationResponse,
  DirectNotificationResponseSchema,
} from '@ferretry/protocol';
import type { AttentionApiClient, IAttentionGateway } from './ports.ts';

/** The daemon route that owns one session's attention board. */
export function attentionBoardPath(sessionId: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/attention`;
}

/** The daemon route that pushes a direct notification to the human's devices. */
export function notifyPath(sessionId: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/notify`;
}

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * Speaks the attention routes through the protocol client.
 *
 * Requests and responses are both parsed against the protocol schemas. kteam cast the response
 * (`response as AttentionSnapshot`), so a daemon answering with an error envelope produced a crash
 * inside rendering rather than a stated failure.
 */
export class ProtocolAttentionGateway implements IAttentionGateway {
  constructor(private readonly client: AttentionApiClient) {}

  async snapshot(sessionId: string): Promise<AttentionSnapshot> {
    return await this.client.request(attentionBoardPath(sessionId), AttentionSnapshotSchema);
  }

  async apply(sessionId: string, request: AttentionActionRequest): Promise<AttentionSnapshot> {
    const body = AttentionActionRequestSchema.parse(request);
    return await this.client.request(attentionBoardPath(sessionId), AttentionSnapshotSchema, jsonPost(body));
  }

  async notify(sessionId: string, request: DirectNotificationRequest): Promise<DirectNotificationResponse> {
    const body = DirectNotificationRequestSchema.parse(request);
    return await this.client.request(notifyPath(sessionId), DirectNotificationResponseSchema, jsonPost(body));
  }
}
