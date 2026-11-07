/**
 * THE KEPT RECORD OF A 2FA KEY CHANGE (S102; today's `lib/audit/routes.ts`, the factor rows): one `secrets.changed`
 * record by account id, the action, the key's or stage's id, and for a seed save `proof: passkey`. The route records it
 * itself, through Gate (`GateApi.audit`), because Gate's generic route record names only a sole path parameter and these
 * routes carry two. It never carries a value: ids and fixed words only. A refusal is recorded as refused, with its code.
 */
import type { AuditActor, AuditDetail } from '@ferretry/core-gate/contract';
import { ApiError, type CallContext, decodeParameter } from '@ferretry/kernel/contract';
import type { AuditSink } from '../lib/local-ports.ts';

/** What one route records: the action's fixed name, whether a passkey proved it, and the ids a success names. */
export interface FactorAuditShape {
  readonly action: string;
  readonly proof?: 'passkey';
  /** The ids a success names, from the route's answer and its path. */
  readonly ids?: (call: CallContext, answer: unknown) => Readonly<Record<string, string | undefined>>;
}

/** The two moments a route reports: it answered, or it did not. Total: an audit write never decides an answer. */
export interface FactorAudit {
  answered(call: CallContext, answer: unknown): Promise<void>;
  refused(call: CallContext, error: unknown, code?: string): Promise<void>;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\p{Cc}\p{Cf}]/u.test(value)
    ? value
    : undefined;

/** The id under `path` of a JSON-shaped answer, or undefined. */
export function idAt(answer: unknown, ...path: readonly string[]): string | undefined {
  let at: unknown = answer;
  for (const key of path) {
    if (typeof at !== 'object' || at === null) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return text(at);
}

/** A path parameter, decoded; undefined when it is missing or unusable. */
export const paramOf = (call: CallContext, name: string): string | undefined => {
  try {
    return text(decodeParameter(call.params.get(name) ?? ''));
  } catch {
    return undefined;
  }
};

const actorOf = (call: CallContext): AuditActor =>
  call.credential?.tokenClass === 'device'
    ? { kind: 'device', deviceId: call.credential.principal.holder }
    : { kind: 'host' };

export function factorAudit(sink: AuditSink | undefined, shape: FactorAuditShape): FactorAudit {
  const write = async (
    call: CallContext,
    outcome: 'succeeded' | 'refused' | 'failed',
    extra: Readonly<Record<string, string | undefined>>,
  ): Promise<void> => {
    if (sink === undefined) return;
    const detail: Record<string, string> = { action: shape.action };
    for (const [key, value] of Object.entries(extra)) if (value !== undefined) detail[key] = value;
    if (outcome === 'succeeded' && shape.proof !== undefined) detail['proof'] = shape.proof;
    const subject = paramOf(call, 'id');
    try {
      await sink.record({
        event: 'secrets.changed',
        actor: actorOf(call),
        ...(subject === undefined ? {} : { subject }),
        outcome,
        detail: detail as AuditDetail,
      });
    } catch {
      // An audit write never decides an answer.
    }
  };
  return {
    answered: async (call, answer) => await write(call, 'succeeded', shape.ids?.(call, answer) ?? {}),
    refused: async (call, error, code) => {
      const status = error instanceof ApiError ? error.status : 500;
      const why = code ?? (error instanceof ApiError ? text(error.code) : undefined);
      await write(call, status >= 500 ? 'failed' : 'refused', { code: why });
    },
  };
}
