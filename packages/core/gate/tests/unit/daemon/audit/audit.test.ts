import { describe, expect, test } from 'bun:test';
import { AUDIT_KINDS, type AuditRecord } from '../../../../contract/index.ts';
import {
  AUDIT_KEPT_DAILY_ALLOWANCE,
  AUDIT_INVALID_TEXT,
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
