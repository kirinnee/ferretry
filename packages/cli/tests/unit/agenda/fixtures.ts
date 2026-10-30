import type {
  AgendaActionRequest,
  AgendaAsk,
  AgendaBrief,
  AgendaId,
  AgendaItem,
  AgendaResponse,
  AgendaSnapshot,
  ResolvedAgendaItem,
} from '@ferretry/protocol';
import type { IAgendaGateway, IAgendaOutput } from '../../../src/lib/agenda/ports';

export const SESSION = 'ms8kkfyd-95b7037e';

/** An item a human raised. */
export function humanItem(id: AgendaId, subject: string, overrides: Partial<HumanItemFields> = {}): AgendaItem {
  return {
    id,
    source: 'question',
    sourceRef: null,
    subject,
    why: 'the release is blocked on it',
    howToResolve: 'say yes or no',
    waitingSince: '2026-07-31T09:00:00.000Z',
    raisedBy: 'human',
    raisedBySession: null,
    raisedByName: null,
    ...overrides,
  };
}

interface HumanItemFields extends AgendaBrief {
  stepsDone: number[];
  source: AgendaItem['source'];
  sourceRef: string | null;
  why: string;
  context: string | null;
  howToResolve: string;
  waitingSince: string;
  waitingOn: 'ferret';
  notice: true;
  ping: true;
  waitingFor: 'info' | 'discussion';
  askedAt: string;
  ask: AgendaAsk;
  title: string;
  kind: NonNullable<AgendaItem['kind']>;
  answers: NonNullable<AgendaItem['answers']>;
}

/** An item an agent raised, which is what the CLI's `add` produces. */
export function agentItem(
  id: AgendaId,
  subject: string,
  overrides: Partial<HumanItemFields & { raisedByName: string | null }> = {},
): AgendaItem {
  const { raisedByName = 'sol', ...rest } = overrides;
  return {
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject,
    why: 'nothing else can proceed',
    howToResolve: 'answer on the board',
    waitingSince: '2026-07-31T09:05:00.000Z',
    raisedBy: 'agent',
    raisedBySession: 'agent-session',
    raisedByName,
    ...rest,
  };
}

export function resolvedItem(
  id: AgendaId,
  subject: string,
  overrides: Partial<{
    disposition: ResolvedAgendaItem['disposition'];
    resolvedAt: string;
    resolutionNote: string | null;
    response: AgendaResponse;
    ask: AgendaAsk;
    resolvedByName: string | null;
    resolvedBy: 'human' | 'agent';
  }> = {},
): ResolvedAgendaItem {
  const { resolvedBy = 'human', resolvedByName = null, ...rest } = overrides;
  const provenance =
    resolvedBy === 'human'
      ? { resolvedBy: 'human' as const, resolvedBySession: null, resolvedByName: null }
      : { resolvedBy: 'agent' as const, resolvedBySession: 'agent-session', resolvedByName };
  return {
    ...humanItem(id, subject),
    resolvedAt: '2026-07-31T10:00:00.000Z',
    resolutionNote: null,
    disposition: 'done',
    ...provenance,
    ...rest,
  };
}

export function snapshot(
  items: readonly AgendaItem[],
  overrides: Partial<{ resolved: readonly ResolvedAgendaItem[]; parseErrors: number; sessionId: string }> = {},
): AgendaSnapshot {
  const { resolved = [], parseErrors = 0, sessionId = SESSION } = overrides;
  return {
    v: 1,
    sessionId,
    items: [...items],
    resolved: [...resolved],
    count: items.length,
    parseErrors,
    updatedAt: '2026-07-31T10:05:00.000Z',
  };
}

/** Records every call so a test can assert the request the controller decided to send. */
export class RecordingAgendaGateway implements IAgendaGateway {
  readonly read: string[] = [];
  readonly applied: Array<{ sessionId: string; request: AgendaActionRequest }> = [];
  readonly flushed: string[] = [];

  constructor(
    private readonly board: AgendaSnapshot,
    private readonly result: AgendaSnapshot = board,
  ) {}

  snapshot(sessionId: string): Promise<AgendaSnapshot> {
    this.read.push(sessionId);
    return Promise.resolve(this.board);
  }

  apply(sessionId: string, request: AgendaActionRequest): Promise<AgendaSnapshot> {
    this.applied.push({ sessionId, request });
    return Promise.resolve(this.result);
  }

  sendReplies(sessionId: string): Promise<AgendaSnapshot> {
    this.flushed.push(sessionId);
    return Promise.resolve(this.result);
  }
}

/** Captures what the controller printed. */
export class CapturingOutput implements IAgendaOutput {
  readonly messages: string[] = [];
  readonly diagnostics: string[] = [];

  success(message: string): void {
    this.messages.push(message);
  }

  diagnostic(message: string): void {
    this.diagnostics.push(message);
  }
}
