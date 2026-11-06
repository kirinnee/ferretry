import {
  AGENDA_CHANNEL_HEADER,
  AGENDA_CHANNEL_VERSION,
  type AgendaActionRequest,
  AgendaActionRequestSchema,
  type AgendaClearAgentsResult,
  AgendaClearAgentsResultSchema,
  type AgendaListSnapshot,
  AgendaListSnapshotSchema,
  type AgendaReadItem,
  AgendaReadItemSchema,
  isMachineAgendaId,
} from '@ferretry/protocol';
import { readDaemonFeatures } from '../daemon/features.ts';
import { FY_CLIENT_HEADER, FY_CLIENT_NAME, FY_SESSION_ID_HEADER } from '../session/connection.ts';
import type { AgendaApiClient, IAgendaGateway } from './ports.ts';

/** The daemon route that owns one session's agenda. */
export function agendaBoardPath(sessionId: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionAgendaId(sessionId))}/agenda`;
}

/** The daemon route that delivers a ferret's held answers now ("Send now"). */
export function agendaRepliesPath(sessionId: string): string {
  return `${agendaBoardPath(sessionId)}/replies`;
}

/** The reserved ledger has no session path, including for callers of the path builders above. */
function sessionAgendaId(sessionId: string): string {
  if (isMachineAgendaId(sessionId)) throw new Error('use /v1/machine/agenda for the machine agenda');
  return sessionId;
}

/** The route that owns one board: the machine ledger's own, or the session's agenda. */
export function boardPath(sessionId: string): string {
  return isMachineAgendaId(sessionId) ? '/v1/machine/agenda' : agendaBoardPath(sessionId);
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
  return {
    [FY_CLIENT_HEADER]: FY_CLIENT_NAME,
    [AGENDA_CHANNEL_HEADER]: AGENDA_CHANNEL_VERSION,
    ...(own === '' ? {} : { [FY_SESSION_ID_HEADER]: own }),
  };
}

/**
 * Speaks the agenda routes through the protocol client.
 *
 * Requests and responses are both parsed against the protocol schemas. kteam cast the response
 * (`response as AgendaListSnapshot`), so a daemon answering with an error envelope produced a crash
 * inside rendering rather than a stated failure.
 */
export class ProtocolAgendaGateway implements IAgendaGateway {
  readonly #headers: Record<string, string>;

  constructor(
    private readonly client: AgendaApiClient,
    /** `FY_SESSION_ID`: the ferret this CLI runs inside, absent at the person's own shell. */
    ownSessionId?: string,
  ) {
    this.#headers = attributionHeaders(ownSessionId);
  }

  async snapshot(sessionId: string): Promise<AgendaListSnapshot> {
    this.requireMachineOwner(sessionId);
    return await this.client.request(boardPath(sessionId), AgendaListSnapshotSchema, { headers: this.#headers });
  }

  async readItem(sessionId: string, id: string): Promise<AgendaReadItem> {
    this.requireMachineOwner(sessionId);
    const item = await this.client.request(`${boardPath(sessionId)}/${encodeURIComponent(id)}`, AgendaReadItemSchema, {
      headers: this.#headers,
    });
    if (item.id !== id) throw new Error('daemon returned another agenda item');
    return item;
  }

  async apply(sessionId: string, request: AgendaActionRequest): Promise<AgendaListSnapshot> {
    this.requireMachineOwner(sessionId);
    const body = AgendaActionRequestSchema.parse(request);
    return await this.client.request(boardPath(sessionId), AgendaListSnapshotSchema, jsonPost(body, this.#headers));
  }

  async sendReplies(sessionId: string): Promise<AgendaListSnapshot> {
    this.requireMachineOwner(sessionId);
    if (isMachineAgendaId(sessionId)) throw new Error('the machine agenda has no replies; use /v1/machine/agenda');
    return await this.client.request(
      agendaRepliesPath(sessionId),
      AgendaListSnapshotSchema,
      jsonPost({}, this.#headers),
    );
  }

  async clearAgents(dryRun: boolean): Promise<AgendaClearAgentsResult> {
    return await this.client.request(
      '/v1/agenda/clear-agents',
      AgendaClearAgentsResultSchema,
      jsonPost(dryRun ? { dryRun: true } : {}, this.#headers),
    );
  }

  async features(): Promise<readonly string[]> {
    return await readDaemonFeatures(this.client);
  }

  private requireMachineOwner(sessionId: string): void {
    if (isMachineAgendaId(sessionId) && this.#headers[FY_SESSION_ID_HEADER] !== undefined)
      throw new Error("the machine agenda is the owner's; ask them");
  }
}
