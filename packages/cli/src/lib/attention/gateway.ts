import {
  type AttentionActionRequest,
  AttentionActionRequestSchema,
  type AttentionSnapshot,
  AttentionSnapshotSchema,
} from '@ferretry/protocol';
import { FY_CLIENT_HEADER, FY_CLIENT_NAME, FY_SESSION_ID_HEADER } from '../session/connection.ts';
import type { AttentionApiClient, IAttentionGateway } from './ports.ts';

/** The daemon route that owns one session's attention board. */
export function attentionBoardPath(sessionId: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/attention`;
}

/** The daemon route that delivers a ferret's held answers now ("Send now"). */
export function repliesPath(sessionId: string): string {
  return `${attentionBoardPath(sessionId)}/replies`;
}

const jsonPost = (body: unknown, headers: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

/**
 * Who is calling: the CLI, and — inside a ferret's pane — which ferret.
 *
 * WITHOUT THE SESSION HEADER A FERRET'S RAISE IS THE HUMAN'S. The daemon attributes an admin-token call
 * to the pane it names (`peer:<id>`), and to the person at the shell when it names none. An item a
 * ferret raised and the board recorded as the human's is one whose answer is never delivered back —
 * the daemon tells only the ferret that asked — so the owner answered and the ferret never heard.
 */
function attributionHeaders(ownSessionId: string | undefined): Record<string, string> {
  const own = ownSessionId?.trim() ?? '';
  return { [FY_CLIENT_HEADER]: FY_CLIENT_NAME, ...(own === '' ? {} : { [FY_SESSION_ID_HEADER]: own }) };
}

/**
 * Speaks the attention routes through the protocol client.
 *
 * Requests and responses are both parsed against the protocol schemas. kteam cast the response
 * (`response as AttentionSnapshot`), so a daemon answering with an error envelope produced a crash
 * inside rendering rather than a stated failure.
 */
export class ProtocolAttentionGateway implements IAttentionGateway {
  readonly #headers: Record<string, string>;

  constructor(
    private readonly client: AttentionApiClient,
    /** `FY_SESSION_ID`: the ferret this CLI runs inside, absent at the person's own shell. */
    ownSessionId?: string,
  ) {
    this.#headers = attributionHeaders(ownSessionId);
  }

  async snapshot(sessionId: string): Promise<AttentionSnapshot> {
    return await this.client.request(attentionBoardPath(sessionId), AttentionSnapshotSchema, {
      headers: this.#headers,
    });
  }

  async apply(sessionId: string, request: AttentionActionRequest): Promise<AttentionSnapshot> {
    const body = AttentionActionRequestSchema.parse(request);
    return await this.client.request(
      attentionBoardPath(sessionId),
      AttentionSnapshotSchema,
      jsonPost(body, this.#headers),
    );
  }

  async sendReplies(sessionId: string): Promise<AttentionSnapshot> {
    return await this.client.request(repliesPath(sessionId), AttentionSnapshotSchema, jsonPost({}, this.#headers));
  }
}
