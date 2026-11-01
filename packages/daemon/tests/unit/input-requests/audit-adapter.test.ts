import { describe, it } from 'bun:test';
import should from 'should';
import type { AuditEntry } from '../../../src/lib/audit/types.ts';
import { InputAuditAdapter } from '../../../src/lib/input-requests/audit-adapter.ts';
import type { InputAuditEntry } from '../../../src/lib/input-requests/ports.ts';

const entry = (over: Partial<InputAuditEntry>): InputAuditEntry => ({
  event: 'input.delivered',
  sessionId: 's1',
  actor: { kind: 'host' },
  requestId: 'r'.repeat(32),
  detail: { targetKind: 'terminal', consumer: 'sudo', sensitivity: 'secret', submitted: true },
  ...over,
});

async function written(over: Partial<InputAuditEntry>): Promise<AuditEntry> {
  const records: AuditEntry[] = [];
  await new InputAuditAdapter({ record: async record => void records.push(record) }).record(entry(over));
  const [record] = records;
  if (record === undefined) throw new Error('nothing written');
  return record;
}

describe('InputAuditAdapter', () => {
  it('should record the owner at the machine as the host, with names and flags only', async () => {
    const record = await written({});

    should(record).eql({
      event: 'input.delivered',
      actor: { kind: 'host' },
      subject: 's1',
      outcome: 'succeeded',
      detail: {
        targetKind: 'terminal',
        consumer: 'sudo',
        sensitivity: 'secret',
        submitted: true,
        requestId: 'r'.repeat(32),
      },
    });
  });

  it("should record a fill under a task-plan line as the host's, with the plan, the line and the sign-in, never a value", async () => {
    const record = await written({
      actor: { kind: 'plan', planId: 'ab'.repeat(16), line: 1 },
      detail: {
        targetKind: 'browser',
        sensitivity: 'secret',
        submitted: true,
        signIn: 'si_0123456789abcdef01234567',
        source: 'saved',
        entry: 'GITHUB',
      },
    });

    should(record).eql({
      event: 'input.delivered',
      actor: { kind: 'host' },
      subject: 's1',
      outcome: 'succeeded',
      detail: {
        targetKind: 'browser',
        sensitivity: 'secret',
        submitted: true,
        signIn: 'si_0123456789abcdef01234567',
        source: 'saved',
        entry: 'GITHUB',
        requestId: 'r'.repeat(32),
        by: 'plan',
        plan: 'ab'.repeat(16),
        line: 1,
      },
    });
  });

  it('should record a paired device by its id', async () => {
    const record = await written({ actor: { kind: 'device', deviceId: 'phone-1' } });

    should(record.actor).eql({ kind: 'device', deviceId: 'phone-1' });
  });

  it('should record an agent as the host and say it was an agent', async () => {
    const record = await written({ event: 'input.cancelled', actor: { kind: 'agent' } });

    should(record.actor).eql({ kind: 'host' });
    should(record.detail?.by).equal('agent');
  });

  it('should record an expiry as the daemon acting on its own, and a refusal as refused', async () => {
    const expired = await written({ event: 'input.expired', actor: { kind: 'daemon' } });
    const refused = await written({
      event: 'input.refused',
      detail: { targetKind: 'terminal', sensitivity: 'secret', reason: 'target_changed' },
    });

    should(expired.cause).equal('daemon');
    should(refused.outcome).equal('refused');
    should(refused.detail?.reason).equal('target_changed');
  });
});

describe('InputAuditAdapter, saving a typed value to a saved login', () => {
  it('should write the KEPT secrets.changed record fy secret set writes, by handle and field only', async () => {
    const records: AuditEntry[] = [];
    const adapter = new InputAuditAdapter({ record: async record => void records.push(record) });
    await adapter.saved({
      sessionId: 's1',
      requestId: 'r'.repeat(32),
      actor: { kind: 'device', deviceId: 'phone-1' },
      entry: 'SUDO_KIRIN_BOX',
      field: 'password',
    });
    await adapter.saved({
      sessionId: 's1',
      requestId: 'r'.repeat(32),
      actor: { kind: 'host' },
      entry: 'U',
      field: 'username',
    });

    should(records).eql([
      {
        event: 'secrets.changed',
        actor: { kind: 'device', deviceId: 'phone-1' },
        subject: 'SUDO_KIRIN_BOX',
        outcome: 'succeeded',
        detail: { action: 'login-save', field: 'password', requestId: 'r'.repeat(32), session: 's1' },
      },
      {
        event: 'secrets.changed',
        actor: { kind: 'host' },
        subject: 'U',
        outcome: 'succeeded',
        detail: { action: 'login-save', field: 'username', requestId: 'r'.repeat(32), session: 's1' },
      },
    ]);
  });
});

describe('InputAuditAdapter, a secure copy pasted into the secret store', () => {
  it('should write the KEPT secrets.changed record by the secret NAME, saying whether it replaced one and by whose leave', async () => {
    const records: AuditEntry[] = [];
    const adapter = new InputAuditAdapter({ record: async record => void records.push(record) });
    const base = { sessionId: 's1', requestId: 'r'.repeat(32), name: 'VERCEL_TOKEN' } as const;

    await adapter.stored({ ...base, actor: { kind: 'device', deviceId: 'phone-1' }, replaced: false });
    await adapter.stored({ ...base, actor: { kind: 'rule', ruleId: 'f'.repeat(32) }, replaced: true });

    should(records).eql([
      {
        event: 'secrets.changed',
        actor: { kind: 'device', deviceId: 'phone-1' },
        subject: 'VERCEL_TOKEN',
        outcome: 'succeeded',
        detail: { action: 'paste', requestId: 'r'.repeat(32), session: 's1' },
      },
      {
        event: 'secrets.changed',
        actor: { kind: 'host' },
        subject: 'VERCEL_TOKEN',
        outcome: 'succeeded',
        detail: { action: 'paste-replace', requestId: 'r'.repeat(32), session: 's1', by: 'rule', rule: 'f'.repeat(32) },
      },
    ]);
  });
});
