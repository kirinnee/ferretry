/**
 * The tools' only way to the daemon: typed requests to its OWN route table through `ConnectorApiDispatch`,
 * every answer parsed with the protocol package's schemas. A shape the schema does not accept is a refusal
 * in plain words, never a guess — and no path or query here is built from a caller's string except through
 * `encodeURIComponent` of an id the daemon itself listed.
 */

import {
  AgendaActionRequestSchema,
  AgendaListSnapshotSchema,
  type AgendaItem,
  AgendaOpenPageSchema,
  ApiErrorResponseSchema,
  FY_REQUEST_ID_HEADER,
  isMachineAgendaId,
  type ProjectInfo,
  ProjectListSchema,
  RestartResultSchema,
  type RestartResult,
  type AgendaResponse,
  SessionListSchema,
  type SessionView,
  SessionViewSchema,
  SendResultSchema,
  type SendResult,
} from '@ferretry/protocol';
import type { z } from 'zod';
import type { ConnectorApiAnswer, ConnectorApiCall, ConnectorApiDispatch } from '../ports.ts';

/** A failure a tool reports as its result, in a sentence a person hears. */
export class ToolFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolFailure';
  }
}

/** One open agenda item and the session whose board holds it (the machine ledger has its own reserved id). */
export interface OpenAgendaItem {
  readonly sessionId: string;
  readonly item: AgendaItem;
}

export class FleetGateway {
  constructor(
    private readonly dispatch: ConnectorApiDispatch,
    private readonly grantId: string,
    private readonly newRequestId: () => string,
  ) {}

  async sessions(): Promise<readonly SessionView[]> {
    return await this.json({ method: 'GET', path: '/v1/sessions' }, SessionListSchema);
  }

  async projects(): Promise<readonly ProjectInfo[]> {
    return await this.json({ method: 'GET', path: '/v1/projects' }, ProjectListSchema);
  }

  /** The session's transcript tail as the daemon renders it (already scrubbed by the daemon; scrubbed again by the tool). */
  async logs(sessionId: string): Promise<string> {
    const answer = await this.call({ method: 'GET', path: `/v1/sessions/${encodeURIComponent(sessionId)}/logs` });
    return answer.body;
  }

  async send(sessionId: string, message: string): Promise<SendResult> {
    return await this.json(
      {
        method: 'POST',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/send`,
        body: { message },
        headers: { [FY_REQUEST_ID_HEADER]: this.newRequestId() },
      },
      SendResultSchema,
    );
  }

  async stop(sessionId: string): Promise<SessionView> {
    return await this.json(
      {
        method: 'POST',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/stop`,
        body: { reason: `stopped from the Claude connector (${this.grantId})` },
      },
      SessionViewSchema,
    );
  }

  async restart(sessionId: string): Promise<RestartResult> {
    return await this.json(
      {
        method: 'POST',
        path: '/v1/restarts',
        body: { scope: 'ids', ids: [sessionId] },
        headers: { [FY_REQUEST_ID_HEADER]: this.newRequestId() },
      },
      RestartResultSchema,
    );
  }

  /** Starts an automatic ferret on `task` in a REGISTERED project's folder, as the app's New ferret does. */
  async start(task: string, name: string | undefined, cwd: string): Promise<SessionView> {
    return await this.json(
      {
        method: 'POST',
        path: '/v1/sessions',
        body: { mode: 'auto', prompt: task, cwd, ...(name === undefined ? {} : { name }) },
        headers: { [FY_REQUEST_ID_HEADER]: this.newRequestId() },
      },
      SessionViewSchema,
    );
  }

  /** Every open or parked agenda item on this machine, paged until the daemon says there is no more (bounded). */
  async openAgenda(): Promise<readonly OpenAgendaItem[]> {
    const found: OpenAgendaItem[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const answer = await this.json(
        {
          method: 'GET',
          path: '/v1/agenda/open',
          ...(after === undefined ? {} : { query: { after } }),
        },
        AgendaOpenPageSchema,
      );
      for (const session of answer.sessions)
        for (const item of session.items) found.push({ sessionId: session.sessionId, item });
      if (answer.next === undefined) break;
      after = answer.next;
    }
    return found;
  }

  /** Resolve one agenda item with the owner's answer, through the same route the app and `fy agenda done` use. */
  async resolveAgenda(sessionId: string, id: string, response?: AgendaResponse, note?: string): Promise<void> {
    const path = isMachineAgendaId(sessionId)
      ? '/v1/machine/agenda'
      : `/v1/sessions/${encodeURIComponent(sessionId)}/agenda`;
    const body = AgendaActionRequestSchema.parse({
      action: 'resolve',
      id,
      ...(response === undefined ? {} : { response }),
      ...(note === undefined ? {} : { note }),
    });
    await this.json({ method: 'POST', path, body }, AgendaListSnapshotSchema);
  }

  private async json<T>(call: ConnectorApiCall, schema: z.ZodType<T>): Promise<T> {
    const answer = await this.call(call);
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer.body);
    } catch {
      throw new ToolFailure('The daemon answered in a form I could not read.');
    }
    const result = schema.safeParse(parsed);
    if (!result.success)
      throw new ToolFailure('The daemon answered in a shape I did not expect, so I am not acting on it.');
    return result.data;
  }

  private async call(call: ConnectorApiCall): Promise<ConnectorApiAnswer> {
    let answer: ConnectorApiAnswer;
    try {
      answer = await this.dispatch.call(this.grantId, call);
    } catch {
      throw new ToolFailure('The daemon could not be reached just now.');
    }
    if (answer.status >= 200 && answer.status < 300) return answer;
    throw new ToolFailure(refusalSentence(answer));
  }
}

/** The daemon's own sentence when it sent one; otherwise a plain one by status. */
function refusalSentence(answer: ConnectorApiAnswer): string {
  try {
    const parsed = ApiErrorResponseSchema.safeParse(JSON.parse(answer.body));
    if (parsed.success && parsed.data.error.trim() !== '') return parsed.data.error.trim();
  } catch {
    // not JSON: fall through to the status sentence
  }
  if (answer.status === 404) return 'The daemon does not know that.';
  if (answer.status === 403 || answer.status === 401) return 'The daemon refused that request.';
  if (answer.status === 429) return 'The daemon is busy right now. Try again in a moment.';
  return `The daemon could not do that (status ${answer.status}).`;
}
