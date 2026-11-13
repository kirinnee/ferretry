import type { AuditDetail } from '@ferretry/core-gate/contract';
import type { PhoneApproval } from '../../../contract/routes/index.ts';
import type { AuditSink } from '../../lib/local-ports.ts';
import type { PhoneApprovalAudit, PhoneApprovalAuditEvent } from '../../lib/phone-approval/ports.ts';

/**
 * An approve-on-phone card in the security log (docs/input-requests.md, "Approve on your phone"): which account, which
 * site, which ferret and how it ended, by the approval's own fields. NEVER THE NUMBER (I207): it is on the card, and
 * the log outlives it. Names and ids only, so no field that holds a value, a code or a token is ever copied here.
 * Copied from today's `PhoneApprovalAuditAdapter` (`input-requests/audit-adapter.ts`, bb89d054d).
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
      actor: entry.actor.kind === 'device' ? { kind: 'device', deviceId: entry.actor.deviceId } : { kind: 'host' },
      subject: approval.sessionId,
      outcome: entry.event === 'phone-approval.refused' ? 'refused' : 'succeeded',
      ...(entry.actor.kind === 'daemon' ? { cause: 'daemon' as const } : {}),
      detail,
    });
  }
}
