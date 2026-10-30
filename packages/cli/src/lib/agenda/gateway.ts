import {
  type AgendaActionRequest,
  AgendaActionRequestSchema,
  type AgendaClearAgentsResult,
  AgendaClearAgentsResultSchema,
  type AgendaSnapshot,
  AgendaSnapshotSchema,
  HealthViewSchema,
} from '@ferretry/protocol';
import { requestWithRouteFallback } from '../agenda-wire/route-fallback.ts';
import { FY_CLIENT_HEADER, FY_CLIENT_NAME, FY_SESSION_ID_HEADER } from '../session/connection.ts';
import type { AgendaApiClient, IAgendaGateway } from './ports.ts';

/** The daemon route that owns one session's agenda. */
export function agendaBoardPath(sessionId: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/agenda`;
}

/** The daemon route that delivers a ferret's held answers now ("Send now"). */
export function agendaRepliesPath(sessionId: string): string {
  return `${agendaBoardPath(sessionId)}/replies`;
}

/** The daemon's health report, which lists the features it offers. */
export const DAEMON_HEALTH_PATH = '/v1/health';

/** The older spelling of the agenda route, which a daemon that predates `agenda.wire.1` still answers. */
export function legacyAttentionBoardPath(sessionId: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/attention`;
}

/** The older spelling of the replies route. */
export function repliesPath(sessionId: string): string {
  return `${legacyAttentionBoardPath(sessionId)}/replies`;
}

/** The agenda route and the older one an older daemon answers instead. */
export function boardRoutes(sessionId: string): { readonly current: string; readonly legacy: string } {
  return { current: agendaBoardPath(sessionId), legacy: legacyAttentionBoardPath(sessionId) };
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
 * Speaks the agenda routes (older daemons: the agenda routes) through the protocol client.
 *
 * Requests and responses are both parsed against the protocol schemas. kteam cast the response
 * (`response as AgendaSnapshot`), so a daemon answering with an error envelope produced a crash
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

  async snapshot(sessionId: string): Promise<AgendaSnapshot> {
    return await requestWithRouteFallback(this.client, boardRoutes(sessionId), AgendaSnapshotSchema, {
      headers: this.#headers,
    });
  }

  async apply(sessionId: string, request: AgendaActionRequest): Promise<AgendaSnapshot> {
    const body = AgendaActionRequestSchema.parse(request);
    return await requestWithRouteFallback(
      this.client,
      boardRoutes(sessionId),
      AgendaSnapshotSchema,
      jsonPost(body, this.#headers),
    );
  }

  async sendReplies(sessionId: string): Promise<AgendaSnapshot> {
    return await requestWithRouteFallback(
      this.client,
      { current: agendaRepliesPath(sessionId), legacy: repliesPath(sessionId) },
      AgendaSnapshotSchema,
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
    const health = await this.client.request(DAEMON_HEALTH_PATH, HealthViewSchema).catch(() => undefined);
    return health?.features ?? [];
  }
}
