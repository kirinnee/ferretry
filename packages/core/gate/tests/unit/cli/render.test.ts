import { describe, expect, test } from 'bun:test';
import { instantFromEpochMs } from '@ferretry/std';
import { AUDIT_KINDS, type AuditView } from '../../../contract/index.ts';
import { describeActor, renderAudit, renderGrantHistory } from '../../../cli/lib/render.ts';

describe('how the audit names its actors', () => {
  test('a device without a name is its short id; with neither it is a paired device', () => {
    expect(describeActor({ kind: 'device', deviceId: 'abcdef123456' })).toBe('device …123456');
    expect(describeActor({ kind: 'device' })).toBe('a paired device');
  });

  test('a device name without an id is quoted with no id after it', () => {
    expect(describeActor({ kind: 'device', deviceName: 'phone' })).toBe('device “phone”');
  });
});

describe('an audit record says what it carried', () => {
  const record = (detail?: Record<string, string | number | boolean>) => ({
    at: instantFromEpochMs(Date.UTC(2026, 10, 7, 12)),
    event: AUDIT_KINDS['device.paired'],
    actor: { kind: 'host' as const },
    outcome: 'succeeded' as const,
    ...(detail === undefined ? {} : { detail }),
  });
  const view = (records: readonly ReturnType<typeof record>[]): AuditView => ({
    records: [...records],
    kept: [],
    keptTotal: 0,
    unreadable: 0,
  });

  test('details are listed in key order after the outcome', () => {
    const text = renderAudit(view([record({ zone: 'b', count: 2, ok: true })]));
    expect(text).toContain('succeeded  [count=2 ok=true zone=b]');
  });

  test('a record with no details, or an empty set of them, prints no bracket', () => {
    expect(renderAudit(view([record()]))).not.toContain('[');
    expect(renderAudit(view([record({})]))).not.toContain('[');
  });
});

describe('the grant history', () => {
  test('entries are listed with the actors lined up, and a short journal tail is said out loud', () => {
    const text = renderGrantHistory({
      entries: [
        { at: '2026-11-07T12:00:00.000Z', actor: 'this computer', changes: ['fleet.use=off', 'fleet.configure=on'] },
        { at: '2026-11-06T09:00:00.000Z', actor: 'phone', changes: ['terminal.use=on'] },
      ],
      unreadable: 0,
      truncated: true,
    });
    expect(text.split('\n')).toEqual([
      '2026-11-07T12:00:00.000Z  this computer  fleet.use=off, fleet.configure=on',
      '2026-11-06T09:00:00.000Z  phone          terminal.use=on',
      '',
      'older records exist; this is the tail of the journal',
    ]);
  });

  test('damage is counted in the plural', () => {
    const text = renderGrantHistory({ entries: [], unreadable: 2, truncated: false });
    expect(text).toContain('! 2 lines in this window could not be read as a record');
  });
});
