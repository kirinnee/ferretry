import { describe, expect, test } from 'bun:test';
import { instantFromEpochMs } from '@ferretry/std';
import { AUDIT_KINDS, type AuditView, DEFAULT_SECURITY_SETTINGS } from '../../../contract/index.ts';
import {
  describeActor,
  grantDifference,
  renderAudit,
  renderGrantHistory,
  renderGrants,
  renderSecurityChange,
} from '../../../cli/lib/render.ts';

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

describe('a page of the security changes', () => {
  const kept = (count: number) =>
    Array.from({ length: count }, (_unused, index) => ({
      at: instantFromEpochMs(Date.UTC(2026, 10, 7, 12, index)),
      event: AUDIT_KINDS['device.paired'],
      actor: { kind: 'host' as const },
      outcome: 'succeeded' as const,
    }));

  test('a page that is not all of them says which ones it shows and how to reach the older', () => {
    const text = renderAudit({ records: [], kept: kept(2), keptTotal: 7, unreadable: 0 }, 2);
    expect(text).toContain('Security changes — who may reach this machine (3–4 of 7):');
    expect(text).toContain('… 3 older — run with --kept-skip 4 to see them');
  });

  test('the last page names no older ones', () => {
    const text = renderAudit({ records: [], kept: kept(2), keptTotal: 4, unreadable: 0 }, 2);
    expect(text).toContain('(3–4 of 4):');
    expect(text).not.toContain('older — run with');
  });
});

describe('the security settings change report', () => {
  const view = (idleExpiryDays: number) => ({
    settings: { ...DEFAULT_SECURITY_SETTINGS, idleExpiryDays },
    source: 'document' as const,
    mayWiden: true,
    widenCommand: 'fy daemon security set idleExpiryDays 90',
  });

  test('a shortened idle period names how many paired devices it will unpair', () => {
    expect(renderSecurityChange('idleExpiryDays', { view: view(3), devicesExpiring: 2 })).toBe(
      'idleExpiryDays = 3\n2 paired device(s) will be unpaired at the next check',
    );
  });

  test('a change that unpairs nobody prints only the new value', () => {
    expect(renderSecurityChange('idleExpiryDays', { view: view(60), devicesExpiring: 0 })).toBe('idleExpiryDays = 60');
  });
});

describe('the grant report and what one change moved', () => {
  const entry = (capability: string, use: boolean, configure: boolean) => ({
    capability,
    configure,
    granted: { use, configure },
    configureRefusal: 'step-up-required',
    origin: 'default',
  });

  test('a granted configure that is not usable right now is explained, with the step-up sentence in plain words', () => {
    const text = renderGrants({ capabilities: [{ ...entry('fleet', true, true), configure: false }] }, 'fy');
    expect(text).toContain('(configure needs a passkey confirmation from a paired device right now)');
  });

  test('a granted configure refused for another reason carries that reason', () => {
    const text = renderGrants(
      {
        capabilities: [{ ...entry('fleet', true, true), configure: false, configureRefusal: 'the unlock has lapsed' }],
      },
      'fy',
    );
    expect(text).toContain('(configure the unlock has lapsed right now)');
  });

  test('only the axes that moved are named, and a capability the earlier report lacked is skipped', () => {
    const before = { capabilities: [entry('fleet', true, true), entry('terminal', false, false)] };
    const after = {
      capabilities: [entry('fleet', false, true), entry('terminal', false, true), entry('browser', true, true)],
    };
    expect(grantDifference(before, after)).toEqual(['fleet.use=off', 'terminal.configure=on']);
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
