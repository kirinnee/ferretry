import { describe, expect, test } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { AUDIT_KINDS, AUDIT_MAX_LIMIT, DEFAULT_SECURITY_SETTINGS } from '../../../contract/index.ts';
import cli, { parseLimit, parseSettingValue, parseSkip } from '../../../cli/index.ts';
import manifest from '../../../manifest.ts';
import { describeActor, renderAudit } from '../../../cli/lib/render.ts';

function run(answer: unknown) {
  const calls: { route: string; init?: unknown }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const client: PluginClient = {
    call: async (route, init) => {
      calls.push({ route, init });
      return answer as never;
    },
    subscribe: () => () => undefined,
  };
  const half = cli.build?.({ manifest, client, io: { out: t => out.push(t), err: t => err.push(t), isTty: false } });
  if (half === undefined) throw new Error('the cli half is real');
  return { verbs: half.verbs, calls, out, err };
}

const view = {
  settings: DEFAULT_SECURITY_SETTINGS,
  source: 'defaults' as const,
  mayWiden: true,
  widenCommand: 'fy daemon security set',
};

describe('fy daemon audit', () => {
  test('V-0225 a limit is capped at the most the daemon serves; a typo is refused', () => {
    expect(parseLimit(undefined)).toBe(50);
    expect(parseLimit('9999')).toBe(AUDIT_MAX_LIMIT);
    expect(parseLimit('0')).toBeUndefined();
    expect(parseLimit('ten')).toBeUndefined();
    expect(parseSkip('3')).toBe(3);
    expect(parseSkip('-1')).toBeUndefined();
  });

  test('V-0225 reads GET /v1/audit and prints security changes before activity', async () => {
    const reading = {
      records: [],
      kept: [
        {
          at: '2026-11-07T12:00:00.000Z',
          event: AUDIT_KINDS['device.paired'],
          actor: { kind: 'host' },
          subject: 'dev',
          outcome: 'succeeded',
        },
      ],
      keptTotal: 1,
      unreadable: 2,
    };
    const { verbs, calls, out } = run(reading);
    expect(await verbs['daemon audit']({ args: [], options: { limit: '5' } })).toBe(0);
    expect(calls).toEqual([{ route: 'GET /v1/audit', init: { query: { limit: '5', keptOffset: '0' } } }]);
    expect(out[0]).toContain('A device was paired (dev)  by this computer');
    expect(out[0]).toContain('2 lines of the log could not be read');
  });

  test('a device name is never said where the fixed actors are', () => {
    expect(describeActor({ kind: 'device', deviceId: 'abcdef123456', deviceName: 'this computer' })).toBe(
      'device “this computer” (…123456)',
    );
    expect(renderAudit({ records: [], kept: [], keptTotal: 0, unreadable: 0 })).toBe(
      'no security events have been recorded',
    );
  });
});

describe('fy daemon security', () => {
  test('V-0240 show prints every setting with its bounds', async () => {
    const { verbs, out } = run(view);
    expect(await verbs['daemon security show']({ args: [], options: {} })).toBe(0);
    expect(out[0]).toContain('unlockValidityHours');
    expect(out[0]).toContain('(1-168)');
  });

  test('V-0239 set parses only the shape and lets the daemon judge the bounds', async () => {
    expect(parseSettingValue('stepUpOnActions', 'on')).toEqual({ stepUpOnActions: true });
    expect(parseSettingValue('unlockValidityHours', '999')).toEqual({ unlockValidityHours: 999 });
    expect(parseSettingValue('unlockValidityHours', 'lots')).toContain('takes a whole number');
    const { verbs, calls, err } = run({ view, devicesExpiring: 0 });
    expect(await verbs['daemon security set <field> <value>']({ args: ['nope', '1'], options: {} })).toBe(1);
    expect(err[0]).toContain('is not a security setting');
    expect(await verbs['daemon security set <field> <value>']({ args: ['idleExpiryDays', '14'], options: {} })).toBe(0);
    expect(calls).toEqual([{ route: 'PATCH /v1/security', init: { body: { idleExpiryDays: 14 } } }]);
  });
});
