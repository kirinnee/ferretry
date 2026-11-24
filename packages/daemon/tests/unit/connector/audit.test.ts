import { describe, it } from 'bun:test';
import should from 'should';
import type { AuditEntry } from '../../../src/lib/audit/types.ts';
import { SecurityLogConnectorAudit } from '../../../src/lib/connector/audit.ts';
import type { ConnectorAuditEvent } from '../../../src/lib/connector/ports.ts';

const recorded = async (event: ConnectorAuditEvent): Promise<AuditEntry | undefined> => {
  const entries: AuditEntry[] = [];
  await new SecurityLogConnectorAudit({ record: async entry => void entries.push(entry) }).record(event);
  return entries[0];
};

describe('SecurityLogConnectorAudit', () => {
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

  it('says a connector revoked its own grant, and a person revoked one', async () => {
    should(
      (await recorded({ kind: 'connector.grant.revoked', grantId: 'cg_1', actor: 'connector:cg_1' }))?.actor,
    ).deepEqual({ kind: 'connector' });
    should((await recorded({ kind: 'connector.grant.revoked', grantId: 'cg_1', actor: 'device:d2' }))?.actor).deepEqual(
      {
        kind: 'device',
        deviceId: 'd2',
      },
    );
  });

  it('records a refresh reuse as a refusal and a tool call by tool and ferret', async () => {
    should(await recorded({ kind: 'connector.refresh.reused', grantId: 'cg_1' })).deepEqual({
      event: 'connector.refresh-reused',
      actor: { kind: 'anonymous' },
      subject: 'cg_1',
      outcome: 'refused',
    });
    should(await recorded({ kind: 'connector.tool', grantId: 'cg_1', tool: 'stop_ferret', sessionId: 's1' })).deepEqual(
      {
        event: 'connector.tool',
        actor: { kind: 'connector' },
        subject: 's1',
        outcome: 'succeeded',
        detail: { grant: 'cg_1', tool: 'stop_ferret' },
      },
    );
    should((await recorded({ kind: 'connector.tool', grantId: 'cg_1', tool: 'spawn_ferret' }))?.subject).be.undefined();
  });

  it('records how a tool call ended: ok and unrecorded read as succeeded, an error as failed, a refusal as refused', async () => {
    const base = { kind: 'connector.tool', grantId: 'cg_1', tool: 'stop_ferret', sessionId: 's1' } as const;
    should((await recorded({ ...base, outcome: 'ok' }))?.outcome).equal('succeeded');
    should((await recorded(base))?.outcome).equal('succeeded');
    should((await recorded({ ...base, outcome: 'error' }))?.outcome).equal('failed');
    should((await recorded({ ...base, outcome: 'refused' }))?.outcome).equal('refused');
  });

  it('never throws into a request when the log cannot write', async () => {
    await new SecurityLogConnectorAudit({
      record: async () => {
        throw new Error('disk full');
      },
    }).record({ kind: 'connector.refresh.reused', grantId: 'cg_1' });
  });
});
