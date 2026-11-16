import { describe, expect, test } from 'bun:test';
import { AUDIT_KINDS, type AuditRecord } from '../../../../contract/index.ts';
import {
  AUDIT_KEPT_DAILY_ALLOWANCE,
  AUDIT_INVALID_TEXT,
  auditActorOf,
  auditFoldKey,
  auditOutcomeOf,
  withinAuditBounds,
} from '../../../../daemon/lib/audit/policy.ts';
import {
  AUDIT_FOLD_WINDOW_MS,
  AuditLog,
  type AuditJournalPort,
  type AuditRotation,
  type AuditStore,
} from '../../../../daemon/lib/audit/service.ts';

class MemoryJournal implements AuditJournalPort {
  readonly lines: { record: AuditRecord; store: AuditStore; rotation: AuditRotation }[] = [];
  full = false;
  async append(record: AuditRecord, store: AuditStore, rotation: AuditRotation = 'rotate'): Promise<boolean> {
    if (this.full && store === 'kept' && rotation === 'never') return false;
    this.lines.push({ record, store, rotation });
    return true;
  }
  async recent() {
    return { records: [], kept: [], keptTotal: 0, unreadable: 0 };
  }
}

function log() {
  let ms = Date.UTC(2026, 10, 7, 12);
  const journal = new MemoryJournal();
  const failures: string[] = [];
  const audit = new AuditLog({
    journal,
    clock: { now: () => new Date(ms).toISOString(), nowMs: () => ms },
    failures: message => failures.push(message),
  });
  return { audit, journal, failures, advance: (by: number) => (ms += by) };
}

const refused = {
  event: AUDIT_KINDS['pairing.refused'],
  actor: { kind: 'anonymous' as const },
  outcome: 'refused' as const,
};
const paired = (actor: 'host' | 'device') => ({
  event: AUDIT_KINDS['device.paired'],
  actor: actor === 'host' ? { kind: 'host' as const } : { kind: 'device' as const, deviceId: 'd1' },
  subject: 'dev-x',
  outcome: 'succeeded' as const,
});

describe('the audit log', () => {
  test('J-0004 J-0114 repeats of one refusal fold into one counted line, written at the window flush', async () => {
    const { audit, journal, advance } = log();
    for (let i = 0; i < 5; i += 1) await audit.record({ ...refused, subject: `guess-${i}` });
    expect(journal.lines).toHaveLength(1);
    advance(AUDIT_FOLD_WINDOW_MS);
    await audit.flush();
    expect(journal.lines).toHaveLength(2);
    expect(journal.lines[1]?.record.detail).toEqual({ repeats: 4 });
    expect(journal.lines[1]?.record.subject).toBeUndefined();
  });

  test('a kept event is never folded and goes to the kept store', async () => {
    const { audit, journal } = log();
    await audit.record(paired('host'));
    await audit.record(paired('host'));
    expect(journal.lines.map(line => line.store)).toEqual(['kept', 'kept']);
    expect(auditFoldKey(paired('host'))).toBeUndefined();
  });

  test('a device’s kept records are rationed per day and never rotate the kept store', async () => {
    const { audit, journal } = log();
    for (let i = 0; i < AUDIT_KEPT_DAILY_ALLOWANCE + 3; i += 1) await audit.record(paired('device'));
    const kept = journal.lines.filter(line => line.store === 'kept');
    expect(kept).toHaveLength(AUDIT_KEPT_DAILY_ALLOWANCE + 1);
    expect(kept.every(line => line.rotation === 'never')).toBe(true);
    expect(kept.at(-1)?.record.detail).toEqual({ keptAllowanceSpent: true });
  });

  test('a full kept store sends a device’s record to the general store, said out loud', async () => {
    const { audit, journal, failures } = log();
    journal.full = true;
    await audit.record(paired('device'));
    expect(journal.lines.map(line => line.store)).toEqual(['general']);
    expect(failures).toHaveLength(1);
  });

  test('a subject the contract would refuse is replaced, never dropped with the event', () => {
    const entry = withinAuditBounds({ ...refused, subject: 'x'.repeat(200) });
    expect(entry.subject).toBe(AUDIT_INVALID_TEXT);
    expect(entry.detail).toEqual({ subjectLength: 200 });
  });

  test('a status says the outcome: 4xx refused, 5xx or none failed', () => {
    expect(auditOutcomeOf(200)).toBe('succeeded');
    expect(auditOutcomeOf(403)).toBe('refused');
    expect(auditOutcomeOf(500)).toBe('failed');
    expect(auditOutcomeOf(undefined)).toBe('failed');
  });
});

describe('who the log says acted', () => {
  test('a warden’s token is the warden, a device is named by its id, nobody is anonymous', () => {
    expect(auditActorOf({ kind: 'authenticated', tokenClass: 'warden' })).toEqual({ kind: 'warden' });
    expect(auditActorOf({ kind: 'authenticated', tokenClass: 'admin' })).toEqual({ kind: 'host' });
    expect(auditActorOf(undefined)).toEqual({ kind: 'anonymous' });
  });
});

describe('a repeated act of activity folds by everything it said', () => {
  const opened = (detail: Record<string, string | number | boolean>) => ({
    event: AUDIT_KINDS['terminal.opened'],
    actor: { kind: 'host' as const },
    subject: 't1',
    outcome: 'succeeded' as const,
    detail,
  });

  test('the fold key does not depend on the order the details were written in', () => {
    expect(auditFoldKey(opened({ b: 2, a: 1 }))).toBe(auditFoldKey(opened({ a: 1, b: 2 })));
    expect(auditFoldKey(opened({ a: 1 }))).not.toBe(auditFoldKey(opened({ a: 2 })));
    expect(auditFoldKey({ ...opened({}), detail: undefined })).toBe(auditFoldKey(opened({})));
  });

  test('J-0004 the same act twice in the window is one line and a count', async () => {
    const { audit, journal, advance } = log();
    await audit.record(opened({ mode: 'new' }));
    await audit.record(opened({ mode: 'new' }));
    await audit.record(opened({ mode: 'other' }));
    expect(journal.lines).toHaveLength(2);
    advance(AUDIT_FOLD_WINDOW_MS);
    await audit.flush();
    expect(journal.lines.at(-1)?.record).toMatchObject({ subject: 't1', detail: { mode: 'new', repeats: 1 } });
  });
});

describe('a record that cannot be written is a gap said out loud, never a thrown error', () => {
  test('a journal that fails does not fail the act it describes', async () => {
    const { audit, journal, failures } = log();
    journal.append = async () => {
      throw new Error('the disk is full');
    };
    await audit.record(paired('host'));
    await audit.record(refused);
    expect(failures).toEqual([
      'the audit could not record a device.paired event, so it has a gap: the disk is full',
      'the audit could not record a pairing.refused event, so it has a gap: the disk is full',
    ]);
  });

  test('a failure that is not an Error is still said, as text', async () => {
    const { audit, journal, failures } = log();
    journal.append = async () => {
      throw 'the disk is full';
    };
    await audit.record(refused);
    expect(failures[0]).toContain('so it has a gap: the disk is full');
  });
});

describe('a device past its kept allowance is folded and counted, not lost', () => {
  const DAY = 86_400_000;
  const spendAllowance = async (audit: AuditLog, subject: string) => {
    for (let i = 0; i < AUDIT_KEPT_DAILY_ALLOWANCE; i += 1) await audit.record({ ...paired('device'), subject });
  };

  test('J-0114 the first overspend opens a window, and the next day’s flush writes its count and subjects', async () => {
    const { audit, journal, advance } = log();
    await spendAllowance(audit, 'dev-x');
    await audit.record({ ...paired('device'), subject: 'dev-a' });
    await audit.record({ ...paired('device'), subject: 'dev-b' });
    await audit.record({ ...paired('device'), subject: 'dev-c' });
    const before = journal.lines.length;
    advance(DAY);
    await audit.flush();
    expect(journal.lines).toHaveLength(before + 1);
    expect(journal.lines.at(-1)).toMatchObject({
      store: 'kept',
      record: {
        event: AUDIT_KINDS['device.paired'],
        actor: { kind: 'device' },
        detail: { keptAllowanceSpent: true, repeats: 2, subjects: 'dev-b,dev-c' },
      },
    });
  });

  test('subjects past the bound of one field are counted as +N rather than listed', async () => {
    const { audit, journal, advance } = log();
    await spendAllowance(audit, 'dev-x');
    await audit.record({ ...paired('device'), subject: 'first' });
    await audit.record({ ...paired('device'), subject: 'a'.repeat(100) });
    await audit.record({ ...paired('device'), subject: 'b'.repeat(100) });
    await audit.record({
      event: AUDIT_KINDS['device.paired'],
      actor: { kind: 'device', deviceId: 'd1' },
      outcome: 'succeeded',
    });
    advance(DAY);
    await audit.flush();
    expect(journal.lines.at(-1)?.record.detail).toEqual({
      keptAllowanceSpent: true,
      repeats: 3,
      subjects: `${'a'.repeat(100)},+2`,
    });
  });

  test('an overspend that repeated nothing writes no closing line', async () => {
    const { audit, journal, advance } = log();
    await spendAllowance(audit, 'dev-x');
    await audit.record({ ...paired('device'), subject: 'dev-a' });
    const before = journal.lines.length;
    advance(DAY);
    await audit.flush();
    expect(journal.lines).toHaveLength(before);
  });

  test('a repeat that carried no subject at all closes with a count and no subject list', async () => {
    const { audit, journal, advance } = log();
    await spendAllowance(audit, 'dev-x');
    const bare = {
      event: AUDIT_KINDS['device.paired'],
      actor: { kind: 'device' as const, deviceId: 'd1' },
      outcome: 'succeeded' as const,
    };
    await audit.record(bare);
    await audit.record(bare);
    advance(DAY);
    await audit.flush();
    expect(journal.lines.at(-1)?.record.detail).toEqual({ keptAllowanceSpent: true, repeats: 1 });
  });

  test('an overspend on a later day closes the earlier day’s window before opening its own', async () => {
    const { audit, journal, advance } = log();
    await spendAllowance(audit, 'dev-x');
    await audit.record({ ...paired('device'), subject: 'dev-a' });
    await audit.record({ ...paired('device'), subject: 'dev-b' });
    advance(DAY);
    await spendAllowance(audit, 'dev-y');
    const before = journal.lines.length;
    await audit.record({ ...paired('device'), subject: 'dev-c' });
    const closing = journal.lines.slice(before).filter(line => line.record.detail?.repeats !== undefined);
    expect(closing).toHaveLength(1);
    expect(closing[0]?.record.detail).toEqual({ keptAllowanceSpent: true, repeats: 1, subjects: 'dev-b' });
  });
});

describe('reading the audit back', () => {
  test('the log asks its journal for the window the reader named and returns it unchanged', async () => {
    const asked: [number, number][] = [];
    const reading = { records: [], kept: [], keptTotal: 4, unreadable: 1 };
    const audit = new AuditLog({
      journal: {
        append: async () => true,
        recent: async (limit, keptOffset) => {
          asked.push([limit, keptOffset]);
          return reading;
        },
      },
      clock: { now: () => '2026-11-07T12:00:00.000Z', nowMs: () => 0 },
      failures: () => undefined,
    });
    expect(await audit.recent(20, 5)).toBe(reading);
    expect(await audit.recent(7)).toBe(reading);
    expect(asked).toEqual([
      [20, 5],
      [7, 0],
    ]);
  });
});
