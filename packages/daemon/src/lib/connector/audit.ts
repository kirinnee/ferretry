import type { AuditActor } from '@ferretry/protocol';
import { parseActor } from '../api/actor.ts';
import type { AuditEntry, AuditSink } from '../audit/types.ts';
import type { ConnectorAuditEvent, ConnectorAuditSink, ConnectorToolOutcome } from './ports.ts';

/**
 * The connector's events, written to the machine's security log (docs/audit.md, docs/mcp-connector.md "Storage").
 * Names and ids only: a client's chosen name, a grant id, a tool name, a ferret's session id.
 *
 * WHO is the route's actor where a person acted (`device:<id>` is that device, `admin-cli`/`admin-ui` this
 * computer), the connector itself where a grant acted, and nobody (`anonymous`) where an unauthenticated OAuth
 * client did — a registration, or a rotated-away refresh token presented again. Never throws into a request.
 */
export class SecurityLogConnectorAudit implements ConnectorAuditSink {
  constructor(private readonly log: AuditSink) {}

  async record(event: ConnectorAuditEvent): Promise<void> {
    try {
      await this.log.record(entryOf(event));
    } catch {
      // The security log reports its own write failures (`auditWriteFailed`); a connector request never fails for one.
    }
  }
}

const ANONYMOUS: AuditActor = { kind: 'anonymous' };
const CONNECTOR: AuditActor = { kind: 'connector' };
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

function entryOf(event: ConnectorAuditEvent): AuditEntry {
  switch (event.kind) {
    case 'connector.client.registered':
      return {
        event: 'connector.client-registered',
        actor: ANONYMOUS,
        subject: event.clientId,
        outcome: 'succeeded',
        detail: { client: name(event.clientName) },
      };
    case 'connector.grant.approved':
      return {
        event: 'connector.grant-approved',
        actor: personOf(event.actor),
        subject: event.grantId,
        outcome: 'succeeded',
        detail: { client: name(event.clientName) },
      };
    case 'connector.grant.denied':
      return {
        event: 'connector.grant-denied',
        actor: personOf(event.actor),
        subject: event.requestId,
        outcome: 'succeeded',
        detail: { client: name(event.clientName) },
      };
    case 'connector.grant.revoked':
      // The OAuth client's own revocation and a reuse detection are nobody's owner act: say so, never `host`.
      if (event.initiator === 'client' || event.initiator === 'reuse-detected')
        return {
          event: 'connector.grant-revoked',
          actor: ANONYMOUS,
          subject: event.grantId,
          outcome: 'succeeded',
          detail: { via: event.initiator === 'client' ? 'oauth-revoke' : 'reuse' },
        };
      return {
        event: 'connector.grant-revoked',
        actor: event.actor.startsWith('connector:') ? CONNECTOR : personOf(event.actor),
        subject: event.grantId,
        outcome: 'succeeded',
      };
    case 'connector.refresh.reused':
      return { event: 'connector.refresh-reused', actor: ANONYMOUS, subject: event.grantId, outcome: 'refused' };
    case 'connector.tool':
      return {
        event: 'connector.tool',
        actor: CONNECTOR,
        ...(event.sessionId === undefined ? {} : { subject: event.sessionId }),
        outcome: toolOutcome(event.outcome),
        detail: { grant: event.grantId, tool: event.tool },
      };
  }
}

/** A tool call's outcome in the security log's words: it did it, it could not, or it was refused. */
function toolOutcome(outcome: ConnectorToolOutcome | undefined): AuditEntry['outcome'] {
  if (outcome === 'error') return 'failed';
  if (outcome === 'refused') return 'refused';
  return 'succeeded';
}
