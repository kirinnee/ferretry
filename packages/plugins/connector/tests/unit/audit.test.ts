import { describe, it } from 'bun:test';
import should from 'should';
import type { AuditDraft } from '@ferretry/core-gate/contract';
import { GateConnectorAudit } from '../../daemon/lib/audit.ts';
import type { ConnectorAuditEvent } from '../../daemon/lib/ports.ts';

const recorded = async (event: ConnectorAuditEvent): Promise<AuditDraft | undefined> => {
  const drafts: AuditDraft[] = [];
  await new GateConnectorAudit({ audit: async draft => void drafts.push(draft) }).record(event);
  return drafts[0];
};

describe('GateConnectorAudit', () => {
  it('names an anonymous client registration by its id and a one-line name', async () => {
    should(
      await recorded({ kind: 'connector.client.registered', clientId: 'fycl_1', clientName: ' Claude\u0007\n ' }),
    ).deepEqual({
      event: 'connector.client-registered',
      actor: { kind: 'anonymous' },
      subject: 'fycl_1',
      outcome: 'succeeded',
      detail: { client: 'Claude' },
    });
    should(
      (await recorded({ kind: 'connector.client.registered', clientId: 'c', clientName: '\u0000' }))?.detail,
    ).deepEqual({ client: 'unnamed' });
  });

  it('records the approving device, or this computer', async () => {
    should(
      (await recorded({ kind: 'connector.grant.approved', grantId: 'cg_1', clientName: 'Claude', actor: 'device:d1' }))
        ?.actor,
    ).deepEqual({ kind: 'device', deviceId: 'd1' });
    should(
      (await recorded({ kind: 'connector.grant.denied', requestId: 'cr_1', clientName: 'Claude', actor: 'admin-cli' }))
        ?.actor,
    ).deepEqual({ kind: 'host' });
    should(
      (await recorded({ kind: 'connector.grant.denied', requestId: 'cr_1', clientName: 'C', actor: 'device:' }))?.actor,
    ).deepEqual({ kind: 'host' });
  });

  it('says a person revoked a grant, and never reads an unknown actor as a device', async () => {
    should((await recorded({ kind: 'connector.grant.revoked', grantId: 'cg_1', actor: 'device:d2' }))?.actor).deepEqual(
      {
        kind: 'device',
        deviceId: 'd2',
      },
    );
    should(
      (await recorded({ kind: 'connector.grant.revoked', grantId: 'cg_1', actor: 'connector:cg_1' }))?.actor,
    ).deepEqual({
      kind: 'host',
    });
  });

  it('says who ended a grant when it was not an owner act: the client itself, or a reuse detection', async () => {
    should(
      await recorded({ kind: 'connector.grant.revoked', grantId: 'cg_1', actor: 'client:fycl_1', initiator: 'client' }),
    ).deepEqual({
      event: 'connector.grant-revoked',
      actor: { kind: 'anonymous' },
      subject: 'cg_1',
      outcome: 'succeeded',
      detail: { via: 'oauth-revoke' },
    });
    should(
      await recorded({
        kind: 'connector.grant.revoked',
        grantId: 'cg_1',
        actor: 'refresh-reuse',
        initiator: 'reuse-detected',
      }),
    ).deepEqual({
      event: 'connector.grant-revoked',
      actor: { kind: 'anonymous' },
      subject: 'cg_1',
      outcome: 'succeeded',
      detail: { via: 'reuse' },
    });
    should(
      (await recorded({ kind: 'connector.grant.revoked', grantId: 'cg_1', actor: 'device:d3', initiator: 'owner' }))
        ?.actor,
    ).deepEqual({ kind: 'device', deviceId: 'd3' });
  });

  it('records a refresh reuse as a refusal', async () => {
    should(await recorded({ kind: 'connector.refresh.reused', grantId: 'cg_1' })).deepEqual({
      event: 'connector.refresh-reused',
      actor: { kind: 'anonymous' },
      subject: 'cg_1',
      outcome: 'refused',
    });
  });

  it('never throws into a request when the log cannot write', async () => {
    await new GateConnectorAudit({
      audit: async () => {
        throw new Error('disk full');
      },
    }).record({ kind: 'connector.refresh.reused', grantId: 'cg_1' });
  });
});
