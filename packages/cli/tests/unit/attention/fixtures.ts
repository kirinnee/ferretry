import type {
  AttentionActionRequest,
  AttentionAsk,
  AttentionId,
  AttentionItem,
  AttentionResponse,
  AttentionSnapshot,
  DirectNotificationRequest,
  DirectNotificationResponse,
  ResolvedAttentionItem,
} from '@ferretry/protocol';
import type { IAttentionGateway, IAttentionOutput } from '../../../src/lib/attention/ports';

export const SESSION = 'ms8kkfyd-95b7037e';

/** An item a human raised. */
export function humanItem(id: AttentionId, subject: string, overrides: Partial<HumanItemFields> = {}): AttentionItem {
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

interface HumanItemFields {
  source: AttentionItem['source'];
  sourceRef: string | null;
  why: string;
  context: string | null;
  howToResolve: string;
  waitingSince: string;
  ask: AttentionAsk;
}

/** An item an agent raised, which is what the CLI's `add` produces. */
export function agentItem(
  id: AttentionId,
  subject: string,
  overrides: Partial<HumanItemFields & { raisedByName: string | null }> = {},
): AttentionItem {
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
  id: AttentionId,
  subject: string,
  overrides: Partial<{
    disposition: ResolvedAttentionItem['disposition'];
    resolvedAt: string;
    resolutionNote: string | null;
    response: AttentionResponse;
    ask: AttentionAsk;
    resolvedByName: string | null;
    resolvedBy: 'human' | 'agent';
  }> = {},
): ResolvedAttentionItem {
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
  items: readonly AttentionItem[],
  overrides: Partial<{ resolved: readonly ResolvedAttentionItem[]; parseErrors: number; sessionId: string }> = {},
): AttentionSnapshot {
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
export class RecordingAttentionGateway implements IAttentionGateway {
  readonly read: string[] = [];
  readonly applied: Array<{ sessionId: string; request: AttentionActionRequest }> = [];
  readonly notified: Array<{ sessionId: string; request: DirectNotificationRequest }> = [];

  constructor(
    private readonly board: AttentionSnapshot,
    private readonly result: AttentionSnapshot = board,
    private readonly delivered = 2,
  ) {}

  snapshot(sessionId: string): Promise<AttentionSnapshot> {
    this.read.push(sessionId);
    return Promise.resolve(this.board);
  }

  apply(sessionId: string, request: AttentionActionRequest): Promise<AttentionSnapshot> {
    this.applied.push({ sessionId, request });
    return Promise.resolve(this.result);
  }

  notify(sessionId: string, request: DirectNotificationRequest): Promise<DirectNotificationResponse> {
    this.notified.push({ sessionId, request });
    return Promise.resolve({ sessionId, delivered: this.delivered });
  }
}

/** Captures what the controller printed. */
export class CapturingOutput implements IAttentionOutput {
  readonly messages: string[] = [];

  success(message: string): void {
    this.messages.push(message);
  }
}
