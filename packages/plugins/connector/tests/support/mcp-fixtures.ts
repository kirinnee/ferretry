import {
  AGENDA_SCHEMA_VERSION,
  type AgendaItem,
  AgendaItemSchema,
  AgendaListSnapshotSchema,
} from '@ferretry/core-asks/contract';
import { type FerretSummary, FerretSummarySchema } from '@ferretry/core-ferrets/contract';
import type { DelegateRequest, DelegateResponse } from '@ferretry/kernel/contract';
import type { ConnectorAccess, ConnectorAuditEvent } from '../../daemon/lib/ports.ts';

export const NOW = Date.parse('2026-11-24T12:00:00.000Z');

export interface FerretSpec {
  readonly id: string;
  readonly callsign: string;
  /** The task title (`title`); absent reads as none. */
  readonly task?: string;
  readonly state?: 'starting' | 'working' | 'idle' | 'stopped';
  readonly stateAt?: string;
  /** Any other field of the summary (a wait, a cause, a task card, a quota…), merged last and still schema-checked. */
  readonly extra?: Record<string, unknown>;
}

/** A schema-valid ferret summary, so a fixture that drifts from the contract fails here, loudly. */
export function ferretView(spec: FerretSpec): FerretSummary {
  return FerretSummarySchema.parse({
    id: spec.id,
    name: spec.callsign,
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    folder: '/work/project',
    state: spec.state ?? 'working',
    createdAt: '2026-11-24T10:00:00.000Z',
    stateAt: spec.stateAt ?? '2026-11-24T11:55:00.000Z',
    ...(spec.task === undefined ? {} : { title: spec.task, titleSource: 'owner' }),
    ...spec.extra,
  });
}

export interface AgendaSpec {
  readonly id: string;
  readonly subject: string;
  readonly why: string;
  readonly raisedBySession?: string;
  readonly ask?: Record<string, unknown>;
  readonly kind?: string;
  readonly askVersion?: number;
  /** Any other field of the item (a confirmation, a plan …), merged last and still schema-checked. */
  readonly extra?: Record<string, unknown>;
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
    ...(spec.askVersion === undefined ? {} : { askVersion: spec.askVersion }),
    ...spec.extra,
  });
}

export const READ_ACCESS: ConnectorAccess = {
  grantId: 'cg_aaaaaaaaaa',
  tokenId: '0123456789ab',
  scopes: ['fleet:read'],
  clientName: 'Claude',
};
export const WRITE_ACCESS: ConnectorAccess = { ...READ_ACCESS, scopes: ['fleet:read', 'fleet:write'] };

export type Handler = (call: DelegateRequest) => DelegateResponse | undefined;

/** A delegate that answers from `handlers` and remembers every call, so a test can say what the tool asked. */
export class FakeDelegate {
  readonly calls: { grant: string; call: DelegateRequest }[] = [];
  constructor(private readonly handlers: Handler[] = []) {}
  on(handler: Handler): this {
    this.handlers.push(handler);
    return this;
  }
  async call(principal: { readonly grant: string }, call: DelegateRequest): Promise<DelegateResponse> {
    this.calls.push({ grant: principal.grant, call });
    for (const handler of this.handlers) {
      const answer = handler(call);
      if (answer !== undefined) return answer;
    }
    return reply(404, JSON.stringify({ error: 'no such route in the fake', code: 'not_found' }));
  }
}

const reply = (status: number, body: string): DelegateResponse => ({ status, headers: new Map(), body });
export const ok = (value: unknown): DelegateResponse => reply(200, JSON.stringify(value));
export const text = (value: string): DelegateResponse => reply(200, value);
export const refuse = (status: number, error: string, code = 'refused'): DelegateResponse =>
  reply(status, JSON.stringify({ error, code }));

export class AuditSpy {
  readonly events: ConnectorAuditEvent[] = [];
  async record(event: ConnectorAuditEvent): Promise<void> {
    this.events.push(event);
  }
}

/** What the agenda route answers after a resolve: a valid, empty board snapshot. */
export const snapshot = (sessionId: string) =>
  AgendaListSnapshotSchema.parse({
    v: AGENDA_SCHEMA_VERSION,
    sessionId,
    items: [],
    resolved: [],
    count: 0,
    parseErrors: 0,
    updatedAt: '2026-11-24T12:00:00.000Z',
  });
