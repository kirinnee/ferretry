import type { AuditActor, AuditDraft, GateApi } from '@ferretry/core-gate/contract';
import { parseActor } from '@ferretry/core-gate/contract';
import { CONNECTOR_AUDIT, SECURITY_CHANGED } from '../../contract/index.ts';
import type { ConnectorAuditEvent, ConnectorAuditSink } from './ports.ts';

/**
 * The connector's events, written to the machine's security log through Gate (docs/audit.md, docs/mcp-connector.md
 * "Storage"). Names and ids only: a client's chosen name, a grant id.
 *
 * WHO is the route's actor where a person acted (`device:<id>` is that device, `admin-cli`/`admin-ui` this computer),
 * and nobody (`anonymous`) where an unauthenticated OAuth client did — a registration, a client's own revocation, a
 * rotated-away refresh token presented again. Never throws into a request.
 */
export class GateConnectorAudit implements ConnectorAuditSink {
  constructor(private readonly gate: Pick<GateApi, 'audit'>) {}

  async record(event: ConnectorAuditEvent): Promise<void> {
    try {
      await this.gate.audit(draftOf(event));
    } catch {
      // Gate reports its own write failures; a connector request never fails for one.
    }
  }
}

const ANONYMOUS: AuditActor = { kind: 'anonymous' };
const SECURITY_CHANGED_KIND = SECURITY_CHANGED.record;
/** Untrusted text, one line, within the log's 160-character field. */
const name = (text: string): string =>
  text
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .trim()
    .slice(0, 100) || 'unnamed';

function personOf(actor: string): AuditActor {
  const parsed = parseActor(actor);
  if (parsed.kind === 'device' && parsed.id !== undefined && parsed.id !== '')
    return { kind: 'device', deviceId: parsed.id };
  return { kind: 'host' };
}

function draftOf(event: ConnectorAuditEvent): AuditDraft {
  switch (event.kind) {
    case 'connector.client.registered':
      return {
        event: CONNECTOR_AUDIT.clientRegistered,
        actor: ANONYMOUS,
        subject: event.clientId,
        outcome: 'succeeded',
        detail: { client: name(event.clientName) },
      };
    case 'connector.grant.approved':
      return {
        event: CONNECTOR_AUDIT.grantApproved,
        actor: personOf(event.actor),
        subject: event.grantId,
        outcome: 'succeeded',
        detail: { client: name(event.clientName) },
      };
    case 'connector.grant.denied':
      return {
        event: CONNECTOR_AUDIT.grantDenied,
        actor: personOf(event.actor),
        subject: event.requestId,
        outcome: 'succeeded',
        detail: { client: name(event.clientName) },
      };
    case 'connector.grant.revoked':
      // The OAuth client's own revocation and a reuse detection are nobody's owner act: say so, never `host`.
      if (event.initiator === 'client' || event.initiator === 'reuse-detected')
        return {
          event: CONNECTOR_AUDIT.grantRevoked,
          actor: ANONYMOUS,
          subject: event.grantId,
          outcome: 'succeeded',
          detail: { via: event.initiator === 'client' ? 'oauth-revoke' : 'reuse' },
        };
      return {
        event: CONNECTOR_AUDIT.grantRevoked,
        actor: personOf(event.actor),
        subject: event.grantId,
        outcome: 'succeeded',
      };
    case 'connector.switched':
      return {
        event: SECURITY_CHANGED_KIND,
        actor: personOf(event.actor),
        subject: 'connector',
        outcome: 'succeeded',
        detail: { enabled: event.enabled },
      };
    case 'connector.refresh.reused':
      return {
        event: CONNECTOR_AUDIT.refreshReused,
        actor: ANONYMOUS,
        subject: event.grantId,
        outcome: 'refused',
      };
  }
}
