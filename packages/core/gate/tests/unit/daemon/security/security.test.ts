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

/** A device holding ONE fresh proof, claimed atomically as Access claims it: of any number of claims exactly one is `true`. */
function oneProof() {
  const state = { fresh: true, claims: 0 };
  const claimFreshPasskey = () => {
    state.claims += 1;
    if (!state.fresh) return false;
    state.fresh = false;
    return true;
  };
  return { state, caller: { ...phone, claimFreshPasskey } };
}
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
    const proof = oneProof();
    const outcome = await svc.patch({ unlockValidityHours: 24 }, proof.caller);
    expect(outcome.ok).toBe(true);
    expect(proof.state).toEqual({ fresh: false, claims: 1 });
    expect(writes.at(-1)?.unlockValidityHours).toBe(24);
    expect(audits.at(-1)?.changes).toEqual(['security.unlockValidityHours=8->24', PASSKEY_WIDEN_JOURNAL_LINE]);
    expect(audits.at(-1)?.actor).toBe('device:phone');
  });

  test('G115 without the proof a raise is refused naming the act; with it, it applies, spends the proof and is journaled', async () => {
    const { svc, writes, audits } = service();
    const refused = await svc.patch({ unlockValidityHours: 12 }, phone);
    expect(refused).toEqual({ ok: false, refusal: 'passkey-required', fields: ['unlockValidityHours'] });
    expect(writes).toEqual([]);
    const proof = oneProof();
    const applied = await svc.patch({ unlockValidityHours: 12 }, proof.caller);
    expect(applied.ok).toBe(true);
    expect(proof.state).toEqual({ fresh: false, claims: 1 });
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
    let claims = 0;
    const atHost = await svc.patch(
      { unlockValidityHours: 24 },
      {
        ...host,
        claimFreshPasskey: () => {
          claims += 1;
          return true;
        },
      },
    );
    expect(atHost.ok).toBe(true);
    expect(claims).toBe(0);
  });

  test('F-0296 F-0406 a remote tightening applies at once and is what the settings document then reads', async () => {
    const { svc, writes } = service();
    const outcome = await svc.patch({ unlockValidityHours: 2 }, phone);
    expect(outcome.ok).toBe(true);
    expect(writes.at(-1)).toEqual({ ...DEFAULT_SECURITY_SETTINGS, unlockValidityHours: 2 });
  });

  test('G114 G115 two raises admitted on ONE proof: the proof is claimed in the queue, so exactly one raises and the other asks again', async () => {
    const { svc, writes } = service();
    const proof = oneProof();
    const [first, second] = await Promise.all([
      svc.patch({ unlockValidityHours: 12 }, proof.caller),
      svc.patch({ unlockValidityHours: 24 }, proof.caller),
    ]);
    expect([first.ok, second]).toEqual([
      true,
      { ok: false, refusal: 'passkey-required', fields: ['unlockValidityHours'] },
    ]);
    expect(writes.map(written => written.unlockValidityHours)).toEqual([12]);
    expect(proof.state.claims).toBe(2);
  });

  test('G114 a raise whose write fails has used the proof up: it is claimed before the write, with no restore', async () => {
    const proof = oneProof();
    const failing = new SecuritySettingsService({
      document: {
        read: () => ({ kind: 'defaults' }),
        write: async () => {
          throw new Error('disk full');
        },
      },
      history: {
        record: async () => undefined,
        recent: async () => ({ entries: [], unreadable: 0, truncated: false }),
      },
      clock: { now: () => '2026-11-07T12:00:00.000Z' },
      widenCommand: 'fy daemon security set',
    });
    await expect(failing.patch({ unlockValidityHours: 24 }, proof.caller)).rejects.toThrow('disk full');
    expect(proof.state).toEqual({ fresh: false, claims: 1 });
  });

  test('G112 G114 a refused widen takes nothing: a widen no passkey could buy never claims, and neither does a tightening', async () => {
    const { svc } = service();
    const proof = oneProof();
    expect((await svc.patch({ stepUpWindowMinutes: 30 }, proof.caller)).ok).toBe(false);
    expect((await svc.patch({ unlockValidityHours: 24, unlockOnOpen: false }, proof.caller)).ok).toBe(false);
    expect((await svc.patch({ unlockValidityHours: 2 }, proof.caller)).ok).toBe(true);
    expect(proof.state).toEqual({ fresh: true, claims: 0 });
  });

  test('a document that cannot be read at all is a damaged one: the narrowest settings, and only the machine may replace it', async () => {
    const svc = new SecuritySettingsService({
      document: {
        read: () => {
          throw new Error('gate.yaml is unreadable');
        },
        write: async () => {},
      },
      history: { record: async () => {}, recent: async () => ({ entries: [], unreadable: 0, truncated: false }) },
      clock: { now: () => '2026-11-07T12:00:00.000Z' },
      widenCommand: 'fy daemon security set',
    });
    expect(svc.current()).toEqual(DAMAGED_SECURITY_SETTINGS);
    expect(svc.view(phone).source).toBe('damaged');
    expect(await svc.patch({ unlockValidityHours: 2 }, phone)).toEqual({ ok: false, refusal: 'unavailable' });
  });

  test('the view says when the document was last written, for the person who asks', () => {
    const at = '2026-11-06T08:00:00.000Z';
    const { svc } = service({ kind: 'document', settings: DEFAULT_SECURITY_SETTINGS, updatedAt: at });
    expect(svc.view(host)).toMatchObject({ source: 'document', updatedAt: at, mayWiden: true });
    expect(service({ kind: 'defaults' }).svc.view(phone)).not.toHaveProperty('updatedAt');
  });

  test('a damaged document is read strictly, and only the machine may replace it', async () => {
    const { svc } = service({ kind: 'damaged' });
    expect(svc.current()).toEqual(DAMAGED_SECURITY_SETTINGS);
    expect(await svc.patch({ unlockValidityHours: 2 }, phone)).toEqual({ ok: false, refusal: 'unavailable' });
    expect((await svc.patch({ unlockValidityHours: 2 }, host)).ok).toBe(true);
  });
});
