import { describe, expect, test } from 'bun:test';
import type { GateApi } from '@ferretry/core-gate/contract';
import { InputGateAudit } from '../../../../daemon/adapters/inputs/audit.ts';
import type { InputSaveAuditEntry } from '../../../../daemon/lib/inputs/ports.ts';

/**
 * A "Save as" on a card is a change to the secret store, so Gate keeps it as one (I150): the event `secrets.changed`,
 * the entry's handle as the subject and which field, never the value. These use a fake Gate that records what it is
 * handed; the adapter is the real one.
 */

const REQUEST = 'a'.repeat(32);

function audited() {
  const drafts: unknown[] = [];
  const audit = new InputGateAudit({
    audit: async draft => {
      drafts.push(draft);
    },
  } as Pick<GateApi, 'audit'>);
  return { audit, drafts };
}

describe('a change to the secret store made from a card', () => {
  test('I150 a save is kept as a secrets change naming the entry and the field, never the value', async () => {
    const { audit, drafts } = audited();
    const saved: InputSaveAuditEntry = {
      sessionId: 'f1',
      requestId: REQUEST,
      actor: { kind: 'device', deviceId: 'd1' },
      entry: 'login-1' as InputSaveAuditEntry['entry'],
      field: 'password' as InputSaveAuditEntry['field'],
    };

    await audit.saved(saved);
    await audit.saved({ ...saved, actor: { kind: 'host' }, field: 'username' as InputSaveAuditEntry['field'] });

    expect(drafts).toEqual([
      {
        event: 'secrets.changed',
        actor: { kind: 'device', deviceId: 'd1' },
        subject: 'login-1',
        outcome: 'succeeded',
        detail: { action: 'login-save', field: 'password', requestId: REQUEST, session: 'f1' },
      },
      {
        event: 'secrets.changed',
        actor: { kind: 'host' },
        subject: 'login-1',
        outcome: 'succeeded',
        detail: { action: 'login-save', field: 'username', requestId: REQUEST, session: 'f1' },
      },
    ]);
    expect(JSON.stringify(drafts)).not.toContain('fake-pw-000');
  });
});
