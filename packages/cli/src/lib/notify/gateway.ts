import {
  AttentionSnapshotSchema,
  SessionAgendaModePatchSchema,
  SessionAgendaModeSchema,
  type SessionAgendaMode,
} from '@ferretry/protocol';
import { attentionBoardPath } from '../attention/gateway.ts';
import { FY_CLIENT_HEADER, FY_CLIENT_NAME, FY_SESSION_ID_HEADER } from '../session/connection.ts';
import type { INotifyGateway, NotifyApiClient } from './ports.ts';
import { type NoticeRequest, NoticeRequestSchema } from './request.ts';

/** The daemon route that reads and switches one session's agenda mode. */
export function agendaModePath(sessionId: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/agenda-mode`;
}

/**
 * Who is calling: the CLI, and — inside a ferret's pane — which ferret. Without the session header a
 * ferret's notification would be recorded as the person's own, so it is always sent when known.
 */
function attributionHeaders(ownSessionId: string | undefined): Record<string, string> {
  const own = ownSessionId?.trim() ?? '';
  return { [FY_CLIENT_HEADER]: FY_CLIENT_NAME, ...(own === '' ? {} : { [FY_SESSION_ID_HEADER]: own }) };
}

/** Speaks the board and agenda-mode routes through the protocol client; requests and replies are both parsed. */
export class ProtocolNotifyGateway implements INotifyGateway {
  readonly #headers: Record<string, string>;

  constructor(
    private readonly client: NotifyApiClient,
    ownSessionId?: string,
  ) {
    this.#headers = attributionHeaders(ownSessionId);
  }

  async raise(sessionId: string, request: NoticeRequest): Promise<void> {
    const body = NoticeRequestSchema.parse(request);
    await this.client.request(attentionBoardPath(sessionId), AttentionSnapshotSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.#headers },
      body: JSON.stringify(body),
    });
  }

  async agendaMode(sessionId: string): Promise<SessionAgendaMode> {
    return await this.client.request(agendaModePath(sessionId), SessionAgendaModeSchema, { headers: this.#headers });
  }

  async setAgendaMode(sessionId: string, enabled: boolean): Promise<SessionAgendaMode> {
    const body = SessionAgendaModePatchSchema.parse({ enabled });
    return await this.client.request(agendaModePath(sessionId), SessionAgendaModeSchema, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...this.#headers },
      body: JSON.stringify(body),
    });
  }
}
