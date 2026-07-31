import type { AttentionId, AttentionResponse, AttentionSnapshot, AttentionSource } from '@ferretry/protocol';
import {
  applyAttentionCommandToSession,
  attentionSnapshot,
  emptyAttentionLedger,
  type AttentionActor,
  type AttentionFailure,
  type AttentionLedger,
  type AttentionMutation,
  type RaiseAttentionRequest,
} from './state-machine.ts';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export interface AttentionClock {
  now(): string;
}

/** The adapter must serialize each callback with every other callback for the same session. */
export interface AttentionLedgerRepository {
  read(sessionId: string): Promise<AttentionLedger | null>;
  transact(
    sessionId: string,
    apply: (current: AttentionLedger | null) => AttentionMutation,
  ): Promise<AttentionMutation>;
}

export type AttentionQueryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AttentionFailure };

export function isAttentionSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

export class AttentionService {
  constructor(
    private readonly repository: AttentionLedgerRepository,
    private readonly clock: AttentionClock,
  ) {}

  async list(sessionId: string): Promise<AttentionQueryResult<AttentionSnapshot>> {
    const invalid = invalidSession(sessionId);
    if (invalid !== null) return { ok: false, error: invalid };
    const current = await this.repository.read(sessionId);
    return {
      ok: true,
      value: attentionSnapshot(current ?? emptyAttentionLedger(sessionId, this.clock.now())),
    };
  }

  async count(sessionId: string): Promise<AttentionQueryResult<number>> {
    const listed = await this.list(sessionId);
    return listed.ok ? { ok: true, value: listed.value.count } : listed;
  }

  async raise(sessionId: string, request: RaiseAttentionRequest, actor: AttentionActor): Promise<AttentionMutation> {
    return this.apply(sessionId, { action: 'raise', actor, request, at: this.clock.now() });
  }

  async answer(
    sessionId: string,
    id: AttentionId,
    response: AttentionResponse,
    actor: AttentionActor,
    note?: string | null,
  ): Promise<AttentionMutation> {
    return this.apply(sessionId, { action: 'answer', actor, id, response, note, at: this.clock.now() });
  }

  async resolve(
    sessionId: string,
    id: AttentionId,
    actor: AttentionActor,
    note?: string | null,
  ): Promise<AttentionMutation> {
    return this.apply(sessionId, { action: 'resolve', actor, id, note, at: this.clock.now() });
  }

  async dismiss(
    sessionId: string,
    id: AttentionId,
    actor: AttentionActor,
    note?: string | null,
  ): Promise<AttentionMutation> {
    return this.apply(sessionId, { action: 'dismiss', actor, id, note, at: this.clock.now() });
  }

  /** Trusted source reconciliation; transport-facing composition must never expose this directly. */
  async resolveSource(
    sessionId: string,
    source: AttentionSource,
    sourceRef: string,
    actor: AttentionActor,
    note?: string | null,
  ): Promise<AttentionMutation> {
    return this.apply(sessionId, {
      action: 'resolve-source',
      actor,
      source,
      sourceRef,
      note,
      at: this.clock.now(),
    });
  }

  private async apply(
    sessionId: string,
    command: Parameters<typeof applyAttentionCommandToSession>[2],
  ): Promise<AttentionMutation> {
    const invalid = invalidSession(sessionId);
    if (invalid !== null) return { ok: false, error: invalid };
    return this.repository.transact(sessionId, current => applyAttentionCommandToSession(current, sessionId, command));
  }
}

function invalidSession(sessionId: string): AttentionFailure | null {
  return isAttentionSessionId(sessionId)
    ? null
    : { code: 'invalid', message: `not a valid attention session id: ${sessionId}` };
}
