import { describe, expect, test } from 'bun:test';
import type { GateApi } from '@ferretry/core-gate/contract';
import { InputGateAudit } from '../../../../daemon/adapters/inputs/audit.ts';
import type {
  InputAuditEntry,
  InputSaveAuditEntry,
  InputStoreAuditEntry,
} from '../../../../daemon/lib/inputs/ports.ts';

const VALUE = 'hunter2-the-owners-password';
const REQUEST = 'a'.repeat(32);

/** What Gate was handed, read as plain data: the event names are policy refs the test compares by spelling. */
interface Seen {
  readonly event: string;
  readonly actor: unknown;
  readonly subject?: string;
  readonly outcome?: string;
  readonly detail?: unknown;
}

function audited() {
  const drafts: Seen[] = [];
  const audit = new InputGateAudit({
    audit: async draft => {
      drafts.push(draft as unknown as Seen);
    },
  } as Pick<GateApi, 'audit'>);
  return { audit, drafts };
}

const entry = (over: Partial<InputAuditEntry> = {}): InputAuditEntry =>
  ({
    event: 'input.requested',
    sessionId: 'f1',
    actor: { kind: 'host' },
    requestId: REQUEST,
    detail: { targetKind: 'terminal', consumer: undefined },
    ...over,
  }) as InputAuditEntry;

describe('an input event in Gate’s audit', () => {
  test('is the event, the session as its subject, who did it, and the names and flags it carries, never a value', async () => {
    const { audit, drafts } = audited();
    await audit.record(entry());
    expect(drafts).toEqual([
      {
        event: 'input.requested',
        actor: { kind: 'host' },
        subject: 'f1',
        outcome: 'succeeded',
        detail: { targetKind: 'terminal', requestId: REQUEST },
      },
    ]);
    expect(JSON.stringify(drafts)).not.toContain(VALUE);
  });

  test('a refusal is a refused outcome, and a hold’s two events keep Gate’s spelling of a hold', async () => {
    const { audit, drafts } = audited();
    await audit.record(entry({ event: 'input.refused' }));
    await audit.record(entry({ event: 'input.quarantine_ended', requestId: undefined }));
    await audit.record(entry({ event: 'input.quarantine_revealed' }));
    expect(drafts.map(draft => [draft.event, draft.outcome])).toEqual([
      ['input.refused', 'refused'],
      ['input.hold-ended', 'succeeded'],
      ['input.hold-revealed', 'succeeded'],
    ]);
    expect(drafts[1]?.detail).toEqual({ targetKind: 'terminal' });
  });

  test('an owner’s device is the actor as it is; every other actor is the host, with a detail saying which', async () => {
    const { audit, drafts } = audited();
    const as = async (actor: InputAuditEntry['actor']) => await audit.record(entry({ actor }));
    await as({ kind: 'device', deviceId: 'd1' });
    await as({ kind: 'agent' });
    await as({ kind: 'rule', ruleId: 'b'.repeat(32) });
    await as({ kind: 'plan', planId: 'plan1', line: 4 } as never);
    await as({ kind: 'sign-in-rule', rule: 'rule1', revision: 2 } as never);
    await as({ kind: 'daemon' });
    expect(drafts.map(draft => draft.actor)).toEqual([
      { kind: 'device', deviceId: 'd1' },
      { kind: 'host' },
      { kind: 'host' },
      { kind: 'host' },
      { kind: 'host' },
      { kind: 'host' },
    ]);
    expect(drafts.map(draft => draft.detail)).toEqual([
      { targetKind: 'terminal', requestId: REQUEST },
      { targetKind: 'terminal', requestId: REQUEST, by: 'agent' },
      { targetKind: 'terminal', requestId: REQUEST, by: 'rule', rule: 'b'.repeat(32) },
      { targetKind: 'terminal', requestId: REQUEST, by: 'plan', plan: 'plan1', line: 4 },
      { targetKind: 'terminal', requestId: REQUEST, by: 'rule', signInRule: 'rule1', revision: 2 },
      { targetKind: 'terminal', requestId: REQUEST, cause: 'daemon' },
    ]);
  });
});

describe('a change to the secret store made from a card', () => {
  test('saving a typed value into a saved login is kept as a secrets change, naming the entry and the field', async () => {
    const { audit, drafts } = audited();
    const saved: InputSaveAuditEntry = {
      sessionId: 'f1',
      requestId: REQUEST,
      actor: { kind: 'device', deviceId: 'd1' },
      entry: 'login-1' as InputSaveAuditEntry['entry'],
      field: 'password' as InputSaveAuditEntry['field'],
    };
    await audit.saved(saved);
    await audit.saved({ ...saved, actor: { kind: 'host' } });
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
        detail: { action: 'login-save', field: 'password', requestId: REQUEST, session: 'f1' },
      },
    ]);
  });

  test('a paste is kept by the secret’s name, as a replace or not, and a cut-off write is kept as uncertain', async () => {
    const { audit, drafts } = audited();
    const stored: InputStoreAuditEntry = {
      sessionId: 'f1',
      requestId: REQUEST,
      actor: { kind: 'host' },
      name: 'API_TOKEN',
      replaced: false,
    };
    await audit.stored(stored);
    await audit.stored({ ...stored, replaced: true, actor: { kind: 'device', deviceId: 'd1' } });
    await audit.stored({ ...stored, uncertain: true });
    await audit.stored({ ...stored, actor: { kind: 'rule', ruleId: 'c'.repeat(32) } });
    expect(drafts.map(draft => [draft.actor, draft.subject, draft.outcome, draft.detail])).toEqual([
      [{ kind: 'host' }, 'API_TOKEN', 'succeeded', { action: 'paste', requestId: REQUEST, session: 'f1' }],
      [
        { kind: 'device', deviceId: 'd1' },
        'API_TOKEN',
        'succeeded',
        { action: 'paste-replace', requestId: REQUEST, session: 'f1' },
      ],
      [{ kind: 'host' }, 'API_TOKEN', 'failed', { action: 'paste-uncertain', requestId: REQUEST, session: 'f1' }],
      [
        { kind: 'host' },
        'API_TOKEN',
        'succeeded',
        { action: 'paste', requestId: REQUEST, session: 'f1', by: 'rule', rule: 'c'.repeat(32) },
      ],
    ]);
  });
});
