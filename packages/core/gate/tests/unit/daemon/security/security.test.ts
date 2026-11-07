import { describe, expect, test } from 'bun:test';
import {
  AUDIT_KINDS,
  DEFAULT_SECURITY_SETTINGS,
  type GrantAuditEntryView,
  type SecuritySettings,
} from '../../../../contract/index.ts';
import manifest from '../../../../manifest.ts';
import {
  DAMAGED_SECURITY_SETTINGS,
  PASSKEY_WIDEN_JOURNAL_LINE,
  type SecurityDocument,
  SecuritySettingsService,
} from '../../../../daemon/lib/security/service.ts';

function service(start: SecurityDocument = { kind: 'defaults' }) {
  let document = start;
  const writes: SecuritySettings[] = [];
  const audits: GrantAuditEntryView[] = [];
  const svc = new SecuritySettingsService({
    document: {
      read: () => document,
      write: async settings => {
        writes.push(settings);
        document = { kind: 'document', settings };
      },
    },
    history: {
      record: async entry => {
        audits.push(entry);
      },
      recent: async () => ({ entries: [], unreadable: 0, truncated: false }),
    },
    clock: { now: () => '2026-11-07T12:00:00.000Z' },
    widenCommand: 'fy daemon security set',
  });
  return { svc, writes, audits };
}

const host = { hostLocal: true, actor: 'admin-cli' };
const phone = { hostLocal: false, actor: 'device:phone' };
const routeOf = (key: string) => manifest.actions.routes.find(route => route.key === key);

describe('security settings', () => {
  test('G111 PATCH /v1/security demands pairing.configure and is person-only', () => {
    expect(routeOf('PATCH /v1/security')).toMatchObject({
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'pairing', axis: 'configure' },
    });
  });

  test('G113 GET /v1/security needs no capability and is served before the unlock', () => {
    const route = routeOf('GET /v1/security');
    expect(route?.capability).toBeUndefined();
    expect(route).toMatchObject({ minimum: 'operator', caller: 'any', unlockExempt: true });
  });

  test('G115 PATCH /v1/security is recorded as security.changed for every outcome by its descriptor, and only there', () => {
    expect(routeOf('PATCH /v1/security')?.audit).toEqual({ record: AUDIT_KINDS['security.changed'] });
  });

  test('G115 the service keeps its change lines in the grant journal, an attempt that moved nothing included, and refusals not at all', async () => {
    const { svc, audits } = service();
    await svc.patch({ stepUpWindowMinutes: 30 }, phone);
    expect(audits).toEqual([]);
    await svc.patch({}, host);
    expect(audits.map(entry => ({ ...entry, at: String(entry.at) }))).toEqual([
      { at: '2026-11-07T12:00:00.000Z', actor: 'admin-cli', changes: [] },
    ]);
  });

  test('G169 GET /v1/audit is gated by pairing.configure', () => {
    expect(routeOf('GET /v1/audit')).toMatchObject({
      caller: 'person',
      capability: { capability: 'pairing', axis: 'configure' },
    });
  });

  test('G112 a remote widen is refused, naming the host command, and nothing is written', async () => {
    const { svc, writes } = service();
    const outcome = await svc.patch({ stepUpWindowMinutes: 30 }, phone);
    expect(outcome).toEqual({ ok: false, refusal: 'widen-remote', fields: ['stepUpWindowMinutes'] });
    expect(writes).toEqual([]);
    expect(svc.view(phone).widenCommand).toBe('fy daemon security set');
  });

  test('G113 a patch is judged field by field and refused whole if any field widens', async () => {
    const { svc, writes } = service();
    const outcome = await svc.patch(
      { unlockValidityHours: 4, stepUpOnActions: false, deviceKeyRotationDays: 60 },
      phone,
    );
    expect(outcome.ok).toBe(false);
    expect(writes).toEqual([]);
  });

  test('G114 G115 F-0295 a device may raise unlockValidityHours with a passkey proved for it, journaled as such', async () => {
    const { svc, writes, audits } = service();
    expect(await svc.patch({ unlockValidityHours: 24 }, phone)).toEqual({
      ok: false,
      refusal: 'passkey-required',
      fields: ['unlockValidityHours'],
    });
    const outcome = await svc.patch({ unlockValidityHours: 24 }, { ...phone, freshPasskey: true });
    expect(outcome.ok && outcome.spentPasskey).toBe(true);
    expect(writes.at(-1)?.unlockValidityHours).toBe(24);
    expect(audits.at(-1)?.changes).toEqual(['security.unlockValidityHours=8->24', PASSKEY_WIDEN_JOURNAL_LINE]);
    expect(audits.at(-1)?.actor).toBe('device:phone');
  });

  test('G115 without the proof a raise is refused naming the act; with it, it applies, spends the proof and is journaled', async () => {
    const { svc, writes, audits } = service();
    const refused = await svc.patch({ unlockValidityHours: 12 }, phone);
    expect(refused).toEqual({ ok: false, refusal: 'passkey-required', fields: ['unlockValidityHours'] });
    expect(writes).toEqual([]);
    const applied = await svc.patch({ unlockValidityHours: 12 }, { ...phone, freshPasskey: true });
    expect(applied.ok && applied.spentPasskey).toBe(true);
    expect(writes.at(-1)?.unlockValidityHours).toBe(12);
    const changes = audits.at(-1)?.changes ?? [];
    expect(changes).toContain(PASSKEY_WIDEN_JOURNAL_LINE);
    expect(changes).toContain('security.unlockValidityHours=8->12');
  });

  test('G116 a raise combined with any other loosening is refused whole without asking a passkey; the host is not asked', async () => {
    const { svc } = service();
    expect(await svc.patch({ unlockValidityHours: 24, unlockOnOpen: false }, phone)).toEqual({
      ok: false,
      refusal: 'widen-remote',
      fields: ['unlockOnOpen', 'unlockValidityHours'],
    });
    const atHost = await svc.patch({ unlockValidityHours: 24 }, host);
    expect(atHost.ok && atHost.spentPasskey).toBe(false);
  });

  test('F-0296 F-0406 a remote tightening applies at once and is what the settings document then reads', async () => {
    const { svc, writes } = service();
    const outcome = await svc.patch({ unlockValidityHours: 2 }, phone);
    expect(outcome.ok).toBe(true);
    expect(writes.at(-1)).toEqual({ ...DEFAULT_SECURITY_SETTINGS, unlockValidityHours: 2 });
  });

  test('a damaged document is read strictly, and only the machine may replace it', async () => {
    const { svc } = service({ kind: 'damaged' });
    expect(svc.current()).toEqual(DAMAGED_SECURITY_SETTINGS);
    expect(await svc.patch({ unlockValidityHours: 2 }, phone)).toEqual({ ok: false, refusal: 'unavailable' });
    expect((await svc.patch({ unlockValidityHours: 2 }, host)).ok).toBe(true);
  });
});
