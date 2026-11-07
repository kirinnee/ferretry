import { type AuditActor, type AuditDetail, type AuditDraft, auditKind, type GateApi } from '@ferretry/core-gate/contract';
import type { InputAudit, InputAuditEntry, InputSaveAuditEntry, InputStoreAuditEntry } from '../../lib/inputs/ports.ts';

/**
 * Today's audit event names for a hold, as Gate's audit kinds spell them (§1: hold). Every other input event keeps
 * its name.
 */
const GATE_KIND: Readonly<Record<string, string>> = {
  'input.quarantine_ended': 'input.hold-ended',
  'input.quarantine_revealed': 'input.hold-revealed',
};

const kindOf = (event: string): AuditDraft['event'] => auditKind(GATE_KIND[event] ?? event);

/** A detail Gate's audit record can hold: the twelve-key, one-line limit is Gate's to enforce. */
const detailOf = (detail: Readonly<Record<string, string | number | boolean | undefined>>): AuditDetail =>
  Object.fromEntries(Object.entries(detail).filter(([, value]) => value !== undefined)) as AuditDetail;

/**
 * Writes an input request's audit record through Gate (today's `InputAuditAdapter` over the audit log): the event,
 * who acted and names and flags. There is no field here that could hold a value.
 *
 * An agent has no audit actor kind of its own, so it is recorded as the host the way every agent tool call is, with
 * `by: 'agent'` saying which. The daemon's own act (an expiry) is `cause: 'daemon'`, carried as a detail: Gate's
 * record has no `cause` field.
 */
export class InputGateAudit implements InputAudit {
  constructor(private readonly gate: Pick<GateApi, 'audit'>) {}

  async record(entry: InputAuditEntry): Promise<void> {
    const actor: AuditActor = entry.actor.kind === 'device' ? entry.actor : { kind: 'host' };
    const detail: AuditDetail = detailOf({
      ...Object.fromEntries(Object.entries(entry.detail).filter(([, value]) => value !== undefined)),
      ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
      ...(entry.actor.kind === 'agent' ? { by: 'agent' } : {}),
      ...(entry.actor.kind === 'rule' ? { by: 'rule', rule: entry.actor.ruleId } : {}),
      ...(entry.actor.kind === 'plan' ? { by: 'plan', plan: entry.actor.planId, line: entry.actor.line } : {}),
      ...(entry.actor.kind === 'sign-in-rule'
        ? { by: 'rule', signInRule: entry.actor.rule, revision: entry.actor.revision }
        : {}),
      ...(entry.actor.kind === 'daemon' ? { cause: 'daemon' } : {}),
    });
    await this.gate.audit({
      event: kindOf(entry.event),
      actor,
      subject: entry.sessionId,
      outcome: entry.event === 'input.refused' ? 'refused' : 'succeeded',

      detail,
    });
  }

  /**
   * "Save as" on a card is a change to the secret store, so it is KEPT exactly as `fy secret set` is: event
   * `secrets.changed`, the entry's handle as the subject, and which field — never the value.
   */
  async saved(entry: InputSaveAuditEntry): Promise<void> {
    await this.gate.audit({
      event: kindOf('secrets.changed'),
      actor: entry.actor.kind === 'device' ? entry.actor : { kind: 'host' },
      subject: entry.entry,
      outcome: 'succeeded',
      detail: { action: 'login-save', field: entry.field, requestId: entry.requestId, session: entry.sessionId },
    });
  }

  /**
   * A secure copy pasted into the secret store is a change to it, so it is KEPT exactly as `fy secret set` is: event
   * `secrets.changed`, the secret's NAME as the subject, and whether it replaced one; never the value. A paste the
   * owner approved in advance is recorded as the rule's; a write that was cut off is kept too, as `paste-uncertain`,
   * because the store may hold the copy now.
   */
  async stored(entry: InputStoreAuditEntry): Promise<void> {
    await this.gate.audit({
      event: kindOf('secrets.changed'),
      actor: entry.actor.kind === 'device' ? entry.actor : { kind: 'host' },
      subject: entry.name,
      outcome: entry.uncertain === true ? 'failed' : 'succeeded',
      detail: {
        action: entry.uncertain === true ? 'paste-uncertain' : entry.replaced ? 'paste-replace' : 'paste',
        requestId: entry.requestId,
        session: entry.sessionId,
        ...(entry.actor.kind === 'rule' ? { by: 'rule', rule: entry.actor.ruleId } : {}),
      },
    });
  }
}
