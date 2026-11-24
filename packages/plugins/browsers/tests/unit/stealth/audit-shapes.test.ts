import { describe, expect, test } from 'bun:test';
import { AuditDetailSchema, AuditRecordSchema } from '@ferretry/core-gate/contract';
import { AUDIT, StealthAuditDetailSchemas } from '../../../contract/index.ts';

const SECRETS = [
  '${secret:CAPSOLVER_KEY}',
  'CAP-0123456789ABCDEF0123456789ABCDEF',
  '0x4AAAAAAAdemoSiteKeyForTurnstile',
  'https://app.example.com/#/login?token=abc',
  'someone@example.com',
  'session=abc123; Path=/',
];

describe('stealth audit records hold no secret', () => {
  const valid = {
    switched: { from: 'off', to: 'on' },
    session: {
      identity: 'work',
      engine: 'chromium',
      fingerprint: '0123456789abcdef',
      proxyHost: 'isp.example.net',
      proxyCountry: 'US',
      phase: 'started',
    },
    captchaSolve: {
      identity: 'id-0123456789abcdef',
      siteHost: 'app.example.com',
      kind: 'turnstile',
      vendor: 'capsolver',
      outcome: 'solved',
      ms: 4200,
      estimatedCostMicros: 1200,
    },
    captchaCapReached: { vendor: 'capsolver', capMicros: 5_000_000 },
  } as const;

  test('each shape accepts its record and fits the audit log’s own detail rules', () => {
    for (const [name, detail] of Object.entries(valid)) {
      const schema = StealthAuditDetailSchemas[name as keyof typeof valid];
      expect(schema.safeParse(detail).success).toBe(true);
      expect(AuditDetailSchema.safeParse(detail).success).toBe(true);
    }
  });

  test('a full audit record of each kind parses', () => {
    const kinds = {
      switched: AUDIT.stealthSwitched,
      session: AUDIT.stealthSession,
      captchaSolve: AUDIT.captchaSolve,
      captchaCapReached: AUDIT.captchaCapReached,
    } as const;
    for (const [name, detail] of Object.entries(valid))
      expect(
        AuditRecordSchema.safeParse({
          format: 1,
          at: '2026-11-24T09:00:00.000Z',
          event: kinds[name as keyof typeof kinds],
          actor: { kind: 'host' },
          outcome: 'succeeded',
          detail,
        }).success,
      ).toBe(true);
  });

  test('no field name can carry a secret, and a shape takes no field it did not declare', () => {
    const forbidden = /token|secret|key|password|cookie|page|url|content|email|credential/iu;
    for (const schema of Object.values(StealthAuditDetailSchemas))
      for (const field of Object.keys(schema.shape)) expect(field).not.toMatch(forbidden);
    for (const [name, detail] of Object.entries(valid)) {
      const schema = StealthAuditDetailSchemas[name as keyof typeof valid];
      for (const extra of ['token', 'siteKey', 'cookie', 'url', 'apiKey'])
        expect(schema.safeParse({ ...detail, [extra]: 'x' }).success).toBe(false);
    }
  });

  test('a secret-shaped value fits no text field of any shape', () => {
    const textFields = [
      ['session', 'identity'],
      ['session', 'engine'],
      ['session', 'fingerprint'],
      ['session', 'proxyHost'],
      ['session', 'proxyCountry'],
      ['captchaSolve', 'identity'],
      ['captchaSolve', 'siteHost'],
      ['captchaSolve', 'vendor'],
      ['captchaCapReached', 'vendor'],
    ] as const;
    for (const [name, field] of textFields)
      for (const secret of SECRETS) {
        const schema = StealthAuditDetailSchemas[name];
        expect(schema.safeParse({ ...valid[name], [field]: secret }).success).toBe(false);
      }
  });
});
