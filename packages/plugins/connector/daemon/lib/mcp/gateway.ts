/**
 * The tools' only way to the daemon: typed requests to its OWN route table through the kernel's delegated dispatch
 * (`kernel.delegate`, U2 — the real dispatcher and Gate on every call, as the owner's connector principal), every answer
 * parsed with the contract schemas of the plugin that owns the route. A shape the schema does not accept is a refusal in
 * plain words, never a guess — and no path or query here is built from a caller's string except through
 * `encodeURIComponent` of an id the daemon itself listed.
 *
 * WHAT THIS NEVER SENDS: the agenda routes also accept `dismiss`, `unsnooze` and every other ask action, and the
 * machine agenda a few more. The two methods below send `resolve` and `snooze` and nothing else, so what the connector
 * can do to the agenda is exactly v4's two tools.
 */
import {
  AgendaActionRequestSchema,
  AgendaListSnapshotSchema,
  MACHINE_AGENDA_ID,
  isMachineAgendaId,
} from '@ferretry/core-asks/contract';
import type { AgendaItem, AgendaResponse } from '@ferretry/core-asks/contract';
import {
  type FerretSummary,
  FerretSummarySchema,
  RestartResultSchema,
  type RestartResult,
} from '@ferretry/core-ferrets/contract';
import { SendResultSchema, type SendResult } from '@ferretry/core-mailbox/contract';
import { AgendaOpenPageSchema } from '@ferretry/plugin-agenda/contract';
import { type ProjectInfo, ProjectListSchema } from '@ferretry/plugin-projects/contract';
import type { DelegateRequest, DelegateResponse } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { ConnectorDelegate, ConnectorServing } from './ports.ts';

/**
 * A failure a tool reports as its result, in a sentence a person hears.
 *
 * `code` is the daemon's own error code when it sent one (`ask_changed`), so a tool can react to it without parsing a
 * sentence. `refused` says the act was REFUSED (the daemon or the tool said "not you, not this") as against failing, so the
 * record can say which: a refusal of something the owner must do themselves matters to whoever reads the security log.
 * `sessionId` names the ferret the act was aimed at, when the tool knew it, so a refusal is in the log against the right ferret.
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

/** One open agenda item and the ferret whose board holds it (the machine ledger has its own reserved id). */
export interface OpenAgendaItem {
  readonly sessionId: string;
  readonly item: AgendaItem;
}

const ErrorBodySchema = z.object({ error: z.string(), code: z.string().optional() });
const StopResultSchema = z.object({ id: z.string().min(1) });
const StartResultSchema = z.object({ id: z.string().min(1) });

/** The registered project a start may run in: its path comes from the daemon's own list, never from a caller. */
export type StartFolder = Pick<ProjectInfo, 'path'>;

export class FleetGateway {
  constructor(
    private readonly delegate: ConnectorDelegate,
    private readonly grantId: string,
    private readonly newRequestId: () => string,
    /** Whether the connector is still on: asked before EVERY call, so a request in flight cannot cross an off (S17). */
    private readonly serving: ConnectorServing,
  ) {}

  /**
   * Cleans a text of secrets. Set by the toolbox before a tool runs: every ferret-written text read here is cleaned BEFORE
   * any tool cuts it short, because a cut that lands inside a secret leaves a fragment no pattern can recognise.
   */
  clean: ((text: string) => Promise<string>) | undefined;

  async ferrets(): Promise<readonly FerretSummary[]> {
    const views = await this.json({ method: 'GET', path: '/v1/ferrets' }, z.array(FerretSummarySchema));
    return await Promise.all(views.map(async view => await this.cleaned(view)));
  }

  async ferret(id: string): Promise<FerretSummary> {
    return await this.cleaned(
      await this.json({ method: 'GET', path: `/v1/ferrets/${encodeURIComponent(id)}` }, FerretSummarySchema),
    );
  }

  private async cleaned(view: FerretSummary): Promise<FerretSummary> {
    const clean = this.clean;
    if (clean === undefined) return view;
    return {
      ...view,
      name: await clean(view.name),
      ...(view.title === undefined ? {} : { title: await clean(view.title) }),
      ...(view.waiting?.condition === undefined
        ? {}
        : { waiting: { ...view.waiting, condition: await clean(view.waiting.condition) } }),
      ...(view.quota?.limitNotice === undefined
        ? {}
        : { quota: { ...view.quota, limitNotice: await clean(view.quota.limitNotice) } }),
    };
  }

  async projects(): Promise<readonly ProjectInfo[]> {
    return await this.json({ method: 'GET', path: '/v1/projects' }, ProjectListSchema);
  }

  /** The ferret's transcript tail as the daemon renders it (already masked by the daemon; scrubbed again by the tool). */
  async logs(id: string): Promise<string> {
    return (await this.call({ method: 'GET', path: `/v1/ferrets/${encodeURIComponent(id)}/logs` })).body;
  }

  async send(id: string, message: string): Promise<SendResult> {
    const requestId = this.newRequestId();
    return await this.json(
      {
        method: 'POST',
        path: `/v1/ferrets/${encodeURIComponent(id)}/send`,
        body: { message, sendId: requestId },
        requestId,
      },
      SendResultSchema,
    );
  }

  async stop(id: string): Promise<void> {
    await this.json(
      {
        method: 'POST',
        path: `/v1/ferrets/${encodeURIComponent(id)}/stop`,
        body: { reason: `stopped from the Claude connector (${this.grantId})` },
      },
      StopResultSchema,
    );
  }

  async restart(id: string): Promise<RestartResult> {
    return await this.json(
      {
        method: 'POST',
        path: '/v1/restarts',
        body: { scope: 'ids', ids: [id] },
        requestId: this.newRequestId(),
      },
      RestartResultSchema,
    );
  }

  /** Starts an automatic ferret on `task` in a REGISTERED project's folder, as the app's New ferret does; answers the new ferret. */
  async start(task: string, title: string | undefined, folder: StartFolder): Promise<FerretSummary> {
    const started = await this.json(
      {
        method: 'POST',
        path: '/v1/ferrets',
        body: { mode: 'auto', prompt: task, folder: folder.path, ...(title === undefined ? {} : { title }) },
        requestId: this.newRequestId(),
      },
      StartResultSchema,
    );
    return await this.ferret(started.id);
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
          ...(after === undefined ? {} : { query: new Map([['after', [after]]]) }),
        },
        AgendaOpenPageSchema,
      );
      for (const session of answer.sessions)
        for (const item of session.items) found.push({ sessionId: session.sessionId, item });
      if (answer.next === undefined) break;
      after = answer.next;
    }
    // The roll-up leaves out the machine's own list, so it is read from its own route; a failure there leaves the ferrets'
    // boards as they are, but "the connector is off" and a refusal are never swallowed.
    try {
      const machine = await this.json({ method: 'GET', path: '/v1/machine/agenda' }, AgendaListSnapshotSchema);
      for (const item of machine.items)
        if (!found.some(known => known.sessionId === MACHINE_AGENDA_ID && known.item.id === item.id))
          found.push({ sessionId: MACHINE_AGENDA_ID, item });
    } catch (error) {
      if (error instanceof ToolFailure && error.refused) throw error;
    }
    return found;
  }

  /**
   * Resolve one agenda item with the owner's answer, through the same route the app and `fy agenda done` use. `askVersion`
   * is the version of the ask the item SHOWED when the answer was shaped: the daemon refuses `ask_changed` (a
   * {@link ToolFailure} with that `code`) if the ferret has replaced the ask since, instead of applying the answer to a
   * question nobody saw. The machine ledger takes a bare `resolve` (an id and a note), so that is all it is sent.
   */
  async resolveAgenda(
    sessionId: string,
    id: string,
    askVersion: number,
    response?: AgendaResponse,
    note?: string,
  ): Promise<void> {
    const machine = isMachineAgendaId(sessionId);
    const body = machine
      ? { action: 'resolve', id, ...(note === undefined ? {} : { note }) }
      : AgendaActionRequestSchema.parse({
          action: 'resolve',
          id,
          askVersion,
          ...(response === undefined ? {} : { response }),
          ...(note === undefined ? {} : { note }),
        });
    await this.json({ method: 'POST', path: agendaPath(sessionId), body }, AgendaListSnapshotSchema);
  }

  /**
   * Put one open agenda item away until `until` (an ISO instant still ahead), through the same route and action the app's
   * Snooze uses. The daemon's own timer brings it back then, fresh; nothing here runs a second clock.
   */
  async snoozeAgenda(sessionId: string, id: string, until: string): Promise<void> {
    const body = isMachineAgendaId(sessionId)
      ? { action: 'snooze', id, until }
      : AgendaActionRequestSchema.parse({ action: 'snooze', id, until });
    await this.json({ method: 'POST', path: agendaPath(sessionId), body }, AgendaListSnapshotSchema);
  }

  private async json<T>(call: DelegateRequest, schema: z.ZodType<T>): Promise<T> {
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

  private async call(call: DelegateRequest): Promise<DelegateResponse> {
    if (!(await this.serving())) throw new ToolFailure('The connector is switched off.', { refused: true });
    let answer: DelegateResponse;
    try {
      answer = await this.delegate.call({ grant: this.grantId }, call);
    } catch {
      throw new ToolFailure('The daemon could not be reached just now.');
    }
    if (answer.status >= 200 && answer.status < 300) return answer;
    throw refusalOf(answer);
  }
}

/** The agenda route of the board that holds an item: the machine ledger has its own reserved id and route. */
const agendaPath = (sessionId: string): string =>
  isMachineAgendaId(sessionId) ? '/v1/machine/agenda' : `/v1/ferrets/${encodeURIComponent(sessionId)}/agenda`;

/** The daemon's own sentence and code when it sent them; otherwise a plain sentence by status. */
function refusalOf(answer: DelegateResponse): ToolFailure {
  const refused = answer.status === 403 || answer.status === 401;
  try {
    const parsed = ErrorBodySchema.safeParse(JSON.parse(answer.body));
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
