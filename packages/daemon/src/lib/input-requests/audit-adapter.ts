import type { AuditActor, AuditDetail, PhoneApproval } from '@ferretry/protocol';
import type { AuditSink } from '../audit/types.ts';
import type { PhoneApprovalAudit, PhoneApprovalAuditEvent } from './phone-approval.ts';
import type { InputAudit, InputAuditEntry, InputSaveAuditEntry, InputStoreAuditEntry } from './ports.ts';

/**
 * Writes an input request's audit record to the daemon's audit log: the event, who acted and names and
 * flags. `detail` is the already-bounded {@link InputAuditEntry} detail plus the request id; there is no
 * field here that could hold a value.
 *
 * An agent has no audit actor kind of its own, so it is recorded as the host the way every agent tool call
 * is, with `by: 'agent'` saying which. The daemon's own act (an expiry) is `cause: 'daemon'`.
 */
export class InputAuditAdapter implements InputAudit {
  constructor(private readonly sink: AuditSink) {}

  async record(entry: InputAuditEntry): Promise<void> {
    const actor: AuditActor = entry.actor.kind === 'device' ? entry.actor : { kind: 'host' };
    const detail: AuditDetail = {
      ...Object.fromEntries(Object.entries(entry.detail).filter(([, value]) => value !== undefined)),
      ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
      ...(entry.actor.kind === 'agent' ? { by: 'agent' } : {}),
      ...(entry.actor.kind === 'rule' ? { by: 'rule', rule: entry.actor.ruleId } : {}),
    };
    await this.sink.record({
      event: entry.event,
      actor,
      subject: entry.sessionId,
      outcome: entry.event === 'input.refused' ? 'refused' : 'succeeded',
      ...(entry.actor.kind === 'daemon' ? { cause: 'daemon' as const } : {}),
      detail,
    });
  }

  /**
   * "Save as" on a card is a change to the secret store, so it is KEPT exactly as `fy secret set` is: event
   * `secrets.changed`, the entry's handle as the subject, and which field — never the value.
   */
  async saved(entry: InputSaveAuditEntry): Promise<void> {
    await this.sink.record({
      event: 'secrets.changed',
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
    await this.sink.record({
      event: 'secrets.changed',
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

/**
 * An approve-on-phone card in the security log (docs/input-requests.md, "Approve on your phone"): which account, which
 * site, which ferret and how it ended, by the approval's own fields. NEVER THE NUMBER: it is on the card, and the log
 * outlives it.
 */
export class PhoneApprovalAuditAdapter implements PhoneApprovalAudit {
  constructor(private readonly sink: AuditSink) {}

  async record(entry: {
    readonly event: PhoneApprovalAuditEvent;
    readonly actor: Parameters<PhoneApprovalAudit['record']>[0]['actor'];
    readonly approval: PhoneApproval;
    readonly steered?: boolean;
  }): Promise<void> {
    const { approval } = entry;
    const site = approval.origin === undefined ? undefined : new URL(approval.origin).host;
    const detail: AuditDetail = {
      approval: approval.id,
      targetKind: approval.surface,
      ferret: approval.agentName,
      state: approval.state,
      ...(approval.account === undefined ? {} : { account: approval.account.id }),
      ...(approval.signIn === undefined ? {} : { signIn: approval.signIn }),
      ...(approval.via === undefined ? {} : { via: approval.via.id }),
      ...(site === undefined ? {} : { site }),
      ...(approval.number === undefined ? {} : { numberFrom: approval.number.from }),
      ...(approval.numberMissing === undefined ? {} : { numberMissing: approval.numberMissing }),
      ...(entry.steered === true ? { steered: true } : {}),
      ...(entry.actor.kind === 'agent' ? { by: 'agent' } : {}),
    };
    await this.sink.record({
      event: entry.event,
      actor: entry.actor.kind === 'device' ? entry.actor : { kind: 'host' },
      subject: approval.sessionId,
      outcome: entry.event === 'phone-approval.refused' ? 'refused' : 'succeeded',
      ...(entry.actor.kind === 'daemon' ? { cause: 'daemon' as const } : {}),
      detail,
    });
  }
}
