import {
  AGENDA_SCHEMA_VERSION,
  type AgendaItem,
  AgendaItemSchema,
  type SessionView,
  SessionViewSchema,
} from '@ferretry/protocol';
import type {
  ConnectorAccess,
  ConnectorApiAnswer,
  ConnectorApiCall,
  ConnectorApiDispatch,
  ConnectorAuditEvent,
} from '../../../src/lib/connector/ports.ts';

export const NOW = Date.parse('2026-11-24T12:00:00.000Z');

export interface ViewSpec {
  readonly id: string;
  readonly callsign: string;
  readonly task: string;
  readonly status?: string;
  readonly turnState?: 'working' | 'your-turn' | 'needs-input';
  readonly lastActivityAt?: string;
  readonly reason?: string;
}

/** A schema-valid session view, so a fixture that drifts from the protocol fails here, loudly. */
export function sessionView(spec: ViewSpec): SessionView {
  return SessionViewSchema.parse({
    config: {
      id: spec.id,
      incarnation: 'i1',
      runtimeGeneration: 1,
      name: spec.task,
      teammate: spec.callsign,
      agent: 'claude',
      harness: 'claude',
      modelHint: '',
      mode: 'auto',
      remoteControl: false,
      harnessFlags: [],
      cwd: '/work/project',
      createdAt: '2026-11-24T10:00:00.000Z',
      updatedAt: '2026-11-24T11:00:00.000Z',
      turn: 1,
      intervalSeconds: 5,
      timeoutSeconds: 0,
      nudgeAfterSeconds: 0,
      killAfterSeconds: 0,
      directSendMaxChars: 1000,
      resumeMenuChoice: 'full',
      maxSnapshots: 5,
      retry: { transientAttempts: 1, stalledAttempts: 1, waitForQuotaReset: false, allowAccountFailover: false },
    },
    state: {
      id: spec.id,
      status: spec.status ?? 'running',
      turn: 1,
      ...(spec.turnState === undefined ? {} : { turnState: spec.turnState }),
      lastActivityAt: spec.lastActivityAt ?? '2026-11-24T11:55:00.000Z',
      ...(spec.reason === undefined ? {} : { reason: spec.reason }),
    },
    directory: '/state/sessions/x',
  });
}

export interface AgendaSpec {
  readonly id: string;
  readonly subject: string;
  readonly why: string;
  readonly raisedBySession?: string;
  readonly ask?: Record<string, unknown>;
  readonly kind?: string;
}

export function agendaItem(spec: AgendaSpec): AgendaItem {
  return AgendaItemSchema.parse({
    id: spec.id,
    source: 'agent-raised',
    sourceRef: null,
    subject: spec.subject,
    why: spec.why,
    waitingSince: '2026-11-24T11:00:00.000Z',
    howToResolve: 'Answer it.',
    raisedBy: 'agent',
    raisedBySession: spec.raisedBySession ?? 'mwuanehg-4531fa9e',
    raisedByName: 'lizzette',
    ...(spec.ask === undefined ? {} : { ask: spec.ask }),
    ...(spec.kind === undefined ? {} : { kind: spec.kind }),
  });
}

export const READ_ACCESS: ConnectorAccess = {
  grantId: 'cg_aaaaaaaaaa',
  tokenId: '0123456789ab',
  scopes: ['fleet:read'],
  clientName: 'Claude',
};
export const WRITE_ACCESS: ConnectorAccess = { ...READ_ACCESS, scopes: ['fleet:read', 'fleet:write'] };

export type Handler = (call: ConnectorApiCall) => ConnectorApiAnswer | undefined;

/** A dispatch that answers from `handlers` and remembers every call, so a test can say what the tool asked. */
export class FakeDispatch implements ConnectorApiDispatch {
  readonly calls: { grantId: string; call: ConnectorApiCall }[] = [];
  constructor(private readonly handlers: Handler[] = []) {}
  on(handler: Handler): this {
    this.handlers.push(handler);
    return this;
  }
  async call(grantId: string, call: ConnectorApiCall): Promise<ConnectorApiAnswer> {
    this.calls.push({ grantId, call });
    for (const handler of this.handlers) {
      const answer = handler(call);
      if (answer !== undefined) return answer;
    }
    return { status: 404, body: JSON.stringify({ error: 'no such route in the fake', code: 'not_found' }) };
  }
}

export const ok = (value: unknown): ConnectorApiAnswer => ({ status: 200, body: JSON.stringify(value) });
export const text = (value: string): ConnectorApiAnswer => ({ status: 200, body: value });
export const refuse = (status: number, error: string): ConnectorApiAnswer => ({
  status,
  body: JSON.stringify({ error, code: 'refused' }),
});

export class AuditSpy {
  readonly events: ConnectorAuditEvent[] = [];
  async record(event: ConnectorAuditEvent): Promise<void> {
    this.events.push(event);
  }
}

/** What the agenda route answers after a resolve: a valid, empty board snapshot. */
export const snapshot = (sessionId: string) =>
  ({
    v: AGENDA_SCHEMA_VERSION,
    sessionId,
    items: [],
    resolved: [],
    count: 0,
    parseErrors: 0,
    updatedAt: '2026-11-24T12:00:00.000Z',
  }) as const;
