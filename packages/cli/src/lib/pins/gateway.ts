import { type PinActionRequest, PinActionRequestSchema, type PinSnapshot, PinSnapshotSchema } from '@ferretry/protocol';
import type { IPinGateway, PinApiClient } from './ports.ts';

/** The daemon route that owns one session's pin board. */
export function pinBoardPath(sessionId: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/pins`;
}

/**
 * Speaks the pin routes through the protocol client.
 *
 * Both directions are parsed against the protocol schema rather than cast: kteam's `renderPinCli`
 * took `response as PinSnapshot`, so a daemon that answered with an error envelope or an older
 * shape surfaced as `undefined.length` deep inside rendering instead of a stated failure.
 */
export class ProtocolPinGateway implements IPinGateway {
  constructor(private readonly client: PinApiClient) {}

  async list(sessionId: string): Promise<PinSnapshot> {
    return await this.client.request(pinBoardPath(sessionId), PinSnapshotSchema);
  }

  async apply(sessionId: string, request: PinActionRequest): Promise<PinSnapshot> {
    return await this.client.request(pinBoardPath(sessionId), PinSnapshotSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PinActionRequestSchema.parse(request)),
    });
  }
}
