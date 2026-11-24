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

/**
 * A failure a tool reports as its result, in a sentence a person hears.
 *
 * `code` is the daemon's own error code when it sent one (`ask_changed`), so a tool can react to it without
 * parsing a sentence. `refused` says the act was REFUSED (the daemon or the tool said "not you, not this") as
 * against failing, so the record can say which: a refusal of something the owner must do themselves matters to
 * whoever reads the security log. `sessionId` names the ferret the act was aimed at, when the tool knew it, so a
 * refusal is in the log against the right ferret.
 */
export class ToolFailure extends Error {
  readonly code: string | undefined;
  readonly refused: boolean;
  readonly sessionId: string | undefined;
  constructor(
    message: string,
    options: { readonly code?: string; readonly refused?: boolean; readonly sessionId?: string } = {},
  ) {
    super(message);
    this.name = 'ToolFailure';
    this.code = options.code;
    this.refused = options.refused === true;
    this.sessionId = options.sessionId;
  }

  /** The same failure, aimed at a ferret. */
  aimedAt(sessionId: string): ToolFailure {
    return new ToolFailure(this.message, {
      ...(this.code === undefined ? {} : { code: this.code }),
      refused: this.refused,
      sessionId,
    });
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

  /**
   * Resolve one agenda item with the owner's answer, through the same route the app and `fy agenda done` use.
   * `askVersion` is the version of the ask the item SHOWED when the answer was shaped: the daemon refuses
   * `ask_changed` (a {@link ToolFailure} with that `code`) if the ferret has replaced the ask since, instead of
   * applying the answer to a question nobody saw.
   */
  async resolveAgenda(
    sessionId: string,
    id: string,
    askVersion: number,
    response?: AgendaResponse,
    note?: string,
  ): Promise<void> {
    const body = AgendaActionRequestSchema.parse({
      action: 'resolve',
      id,
      askVersion,
      ...(response === undefined ? {} : { response }),
      ...(note === undefined ? {} : { note }),
    });
    await this.json({ method: 'POST', path: agendaPath(sessionId), body }, AgendaListSnapshotSchema);
  }

  /**
   * Put one open agenda item away until `until` (an ISO instant still ahead), through the same route and action the
   * app's Snooze uses. The daemon's own timer brings it back then, fresh; nothing here runs a second clock.
   */
  async snoozeAgenda(sessionId: string, id: string, until: string): Promise<void> {
    const body = AgendaActionRequestSchema.parse({ action: 'snooze', id, until });
    await this.json({ method: 'POST', path: agendaPath(sessionId), body }, AgendaListSnapshotSchema);
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
    throw refusalOf(answer);
  }
}

/** The agenda route of the board that holds an item: the machine ledger has its own reserved id and route. */
const agendaPath = (sessionId: string): string =>
  isMachineAgendaId(sessionId) ? '/v1/machine/agenda' : `/v1/sessions/${encodeURIComponent(sessionId)}/agenda`;

/** The daemon's own sentence and code when it sent them; otherwise a plain sentence by status. */
function refusalOf(answer: ConnectorApiAnswer): ToolFailure {
  const refused = answer.status === 403 || answer.status === 401;
  try {
    const parsed = ApiErrorResponseSchema.safeParse(JSON.parse(answer.body));
    if (parsed.success && parsed.data.error.trim() !== '')
      return new ToolFailure(parsed.data.error.trim(), {
        ...(parsed.data.code === undefined ? {} : { code: parsed.data.code }),
        refused,
      });
  } catch {
    // not JSON: fall through to the status sentence
  }
  if (answer.status === 404) return new ToolFailure('The daemon does not know that.');
  if (refused) return new ToolFailure('The daemon refused that request.', { refused });
  if (answer.status === 429) return new ToolFailure('The daemon is busy right now. Try again in a moment.');
  return new ToolFailure(`The daemon could not do that (status ${answer.status}).`);
}
