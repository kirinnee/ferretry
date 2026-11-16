import { describe, expect, test } from 'bun:test';
import type { AuditActor, AuditDetail } from '@ferretry/core-gate/contract';
import { PHONE_APPROVAL_UNAVAILABLE } from '@ferretry/core-vault/contract';
import type { AccessApi } from '@ferretry/plugin-access/contract';
import { fakeAccess } from '@ferretry/plugin-access/contract/testing';
import type { UsesHandle } from '@ferretry/kernel/manifest';
import { type PhoneApproval, PhoneApprovalSchema } from '../../../../contract/routes/index.ts';
import { PhoneApprovalAuditAdapter } from '../../../../daemon/adapters/phone-approval/audit.ts';
import { AccessPhoneApprovalPush, phoneApprovalTag } from '../../../../daemon/adapters/phone-approval/push.ts';
import { VaultPhoneLooks } from '../../../../daemon/adapters/phone-approval/vault-reach.ts';
import type { AuditEntry } from '../../../../daemon/lib/local-ports.ts';
import { PhoneApprovalError } from '../../../../daemon/lib/phone-approval/errors.ts';

/** The adapters under the approval service: the security log, the push through Access, the Vault's looks. */

const ID = 'pa_0123456789abcdef01234567';

const approval = (extra: Partial<PhoneApproval> = {}): PhoneApproval =>
  PhoneApprovalSchema.parse({
    id: ID,
    sessionId: 'lizzette',
    agentName: 'lizzette',
    surface: 'browser',
    origin: 'https://company.okta.com',
    signIn: 'si_0123456789abcdef',
    account: { id: 'OKTA', label: 'Okta' },
    username: 'me@company.test',
    number: { value: '42', from: 'okta', direction: 'tap-on-phone', readAt: '2026-11-10T12:00:00.000Z' },
    raisedAt: '2026-11-10T12:00:00.000Z',
    expiresAt: '2026-11-10T12:02:00.000Z',
    state: 'waiting',
    ...extra,
  });

function logged() {
  const entries: AuditEntry[] = [];
  return { entries, adapter: new PhoneApprovalAuditAdapter({ record: async entry => void entries.push(entry) }) };
}

describe('the security log of a phone approval', () => {
  test('I207 the log never records the number, a value or the username: ids and names only', async () => {
    const { entries, adapter } = logged();

    await adapter.record({ event: 'phone-approval.raised', actor: { kind: 'agent' }, approval: approval() });
    await adapter.record({
      event: 'phone-approval.settled',
      actor: { kind: 'daemon' },
      approval: approval({ state: 'moved-on' }),
    });

    expect(entries).toHaveLength(2);
    const text = JSON.stringify(entries);
    expect(text).not.toContain('"42"');
    expect(text).not.toMatch(/readAt|me@company\.test|"value"|"number"|tap-on-phone/u);
    for (const entry of entries) {
      const detail = entry.detail as AuditDetail;
      expect(Object.keys(detail).sort()).toEqual(
        ['account', 'approval', 'by', 'ferret', 'numberFrom', 'signIn', 'site', 'state', 'targetKind']
          .filter(key => key in detail)
          .sort(),
      );
      expect(detail.numberFrom).toBe('okta');
      expect(detail.site).toBe('company.okta.com');
    }
  });

  test('I207 an approval with no number logs why there is none, and still no number', async () => {
    const { entries, adapter } = logged();
    const terminal = approval({ surface: 'terminal', origin: undefined, number: undefined, numberMissing: 'terminal' });

    await adapter.record({ event: 'phone-approval.raised', actor: { kind: 'agent' }, approval: terminal });

    expect(entries[0]?.detail).toEqual({
      approval: ID,
      targetKind: 'terminal',
      ferret: 'lizzette',
      state: 'waiting',
      account: 'OKTA',
      signIn: 'si_0123456789abcdef',
      numberMissing: 'terminal',
      by: 'agent',
    });
  });

  test('the log says who: a paired device by its id, the machine as the host, the daemon as itself, refusals as refused', async () => {
    const { entries, adapter } = logged();
    const base = { approval: approval({ state: 'refused' }) };

    await adapter.record({
      ...base,
      event: 'phone-approval.refused',
      actor: { kind: 'device', deviceId: 'phone-1' },
    });
    await adapter.record({ ...base, event: 'phone-approval.refused', actor: { kind: 'host' } });
    await adapter.record({ ...base, event: 'phone-approval.settled', actor: { kind: 'daemon' }, steered: true });

    const actors = entries.map(entry => entry.actor as AuditActor);
    expect(actors).toEqual([{ kind: 'device', deviceId: 'phone-1' }, { kind: 'host' }, { kind: 'host' }]);
    expect(entries.map(entry => entry.outcome)).toEqual(['refused', 'refused', 'succeeded']);
    expect(entries[2]?.cause).toBe('daemon');
    expect((entries[2]?.detail as AuditDetail | undefined)?.steered).toBe(true);
    expect(entries.every(entry => entry.subject === 'lizzette')).toBe(true);
  });
});

const handle = (access: AccessApi | undefined): UsesHandle<AccessApi> => ({ current: () => access }) as never;

describe('the push of a phone approval, through Access', () => {
  const words = {
    id: ID,
    body: 'Tap 42 on your phone: your account on company.okta.com',
    sequence: 0,
    secondsLeft: 90,
  };

  test('I208 the push goes out under the tag pa-<id>, at high priority, naming its ferret for the hourly cap, held no longer than the card has left', async () => {
    const access = fakeAccess({ enrolments: 2 });

    await new AccessPhoneApprovalPush(handle(access)).push('lizzette', 'ask-1', words);

    expect(access.buzzes).toEqual([
      {
        tag: `pa-${ID}`,
        title: 'Approve on your phone',
        body: words.body,
        url: '/ferrets/lizzette/chat?ask=ask-1',
        urgency: 'high',
        ferret: 'lizzette',
        ttlSeconds: 90,
      },
    ]);
    expect(phoneApprovalTag(ID)).toBe(`pa-${ID}`);
  });

  test('I208 a new number is pushed under the same tag, so it replaces the last on the lock screen', async () => {
    const access = fakeAccess();
    const push = new AccessPhoneApprovalPush(handle(access));

    await push.push('lizzette', 'ask-1', words);
    await push.push('lizzette', 'ask-1', { ...words, body: 'Tap 77 on your phone', sequence: 1, secondsLeft: 60 });

    expect(access.buzzes.map(buzz => (buzz as { tag: string }).tag)).toEqual([`pa-${ID}`, `pa-${ID}`]);
  });

  test('I208 the push is taken down on every device when the card ends: a clear names the tag and nothing else', async () => {
    const access = fakeAccess({ enrolments: 2 });

    await new AccessPhoneApprovalPush(handle(access)).clear('lizzette', ID);

    expect(access.clears).toEqual([{ tags: [`pa-${ID}`], ferret: 'lizzette' }]);
  });

  test('I208 nothing is pushed once no time is left, and a push that cannot be sent ends nothing', async () => {
    const access = fakeAccess();
    const broken: AccessApi = {
      ...access,
      buzz: async () => {
        throw new Error('the push service is down');
      },
      clear: async () => {
        throw new Error('the push service is down');
      },
    };

    await new AccessPhoneApprovalPush(handle(access)).push('lizzette', 'ask-1', { ...words, secondsLeft: 0 });
    await new AccessPhoneApprovalPush(handle(broken)).push('lizzette', 'ask-1', words);
    await new AccessPhoneApprovalPush(handle(broken)).clear('lizzette', ID);

    expect(access.buzzes).toEqual([]);
  });

  test('I208 degrades, and says so: with no clear on the port the push stays up until the phone dismisses it, and nothing throws', async () => {
    const { clear: _clear, ...withoutClear } = fakeAccess({ enrolments: 1 });
    const access: AccessApi = withoutClear;

    await expect(new AccessPhoneApprovalPush(handle(access)).clear('lizzette', ID)).resolves.toBeUndefined();
    // The twin takes the line down: a port that cannot is the degraded case, and it is not this one.
    expect(typeof fakeAccess().clear).toBe('function');
    await expect(
      new AccessPhoneApprovalPush(handle(undefined)).push('lizzette', 'ask-1', words),
    ).resolves.toBeUndefined();
    await expect(new AccessPhoneApprovalPush(handle(undefined)).clear('lizzette', ID)).resolves.toBeUndefined();
  });
});

describe('the Vault’s looks, as an approval asks for them', () => {
  test('a look the Vault does not offer fails the approval closed, in the one fixed sentence', async () => {
    const looks = new VaultPhoneLooks(() => ({}));

    for (const work of [looks.look('lizzette', 'login'), looks.observe('lizzette', 'build')]) {
      const error = await work.then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(PhoneApprovalError);
      expect((error as PhoneApprovalError).code).toBe('unavailable');
      expect((error as PhoneApprovalError).message).toBe(PHONE_APPROVAL_UNAVAILABLE);
    }
  });

  test('F5 an absent tainted look refuses the approval, even when the page and terminal looks are offered', async () => {
    const looks = new VaultPhoneLooks(() => ({
      pushNumber: async () => undefined,
      observeTerminal: async () => ({ ok: false, reason: 'target_gone' }),
    }));

    for (const work of [looks.look('lizzette', 'login'), looks.observe('lizzette', 'build')]) {
      const error = await work.then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(PhoneApprovalError);
      expect((error as PhoneApprovalError).code).toBe('unavailable');
      expect((error as PhoneApprovalError).message).toBe(PHONE_APPROVAL_UNAVAILABLE);
    }
  });

  test('a ferret counts as having steered a surface when the Vault cannot say it did not', () => {
    expect(new VaultPhoneLooks(() => ({})).tainted('lizzette', 'browser', 10)).toBe(true);
    expect(new VaultPhoneLooks(() => ({})).tainted('lizzette', 'terminal', 10)).toBe(true);
  });

  test('a look the Vault offers is asked for the named ferret and surface, and its answer is the approval’s', async () => {
    const asked: unknown[][] = [];
    const looks = new VaultPhoneLooks(() => ({
      pushNumber: async (...args) => {
        asked.push(['page', ...args]);
        return undefined;
      },
      observeTerminal: async (...args) => {
        asked.push(['terminal', ...args]);
        return { ok: false, reason: 'target_gone' };
      },
      tainted: (...args) => {
        asked.push(['tainted', ...args]);
        return false;
      },
    }));

    expect(await looks.look('lizzette', 'login')).toBeUndefined();
    expect(await looks.observe('lizzette', 'build')).toEqual({ ok: false, reason: 'target_gone' });
    expect(looks.tainted('lizzette', 'browser', 5)).toBe(false);
    expect(asked).toEqual([
      ['page', 'lizzette', 'login'],
      ['terminal', 'lizzette', 'build'],
      ['tainted', 'lizzette', 'browser', 5],
    ]);
  });
});
