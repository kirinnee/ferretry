import { describe, it } from 'bun:test';
import should from 'should';
import type { SpeedupStatus, SpeedupTestResult } from '../../src/lib/index.ts';
import * as speedups from '../../src/lib/speedups.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const testResult = {
  provider: 'groq',
  secretName: 'GROQ_API_KEY',
  ok: true,
  code: 'ok',
  message: 'The key works.',
  latencyMs: 140,
  at: '2026-10-16T10:00:00.000Z',
} satisfies SpeedupTestResult;

const status = {
  provider: 'groq',
  label: 'Groq',
  purpose: 'Cleans up dictated text.',
  costNote: 'Well under a cent.',
  privacyNote: 'Only text leaves.',
  keyUrl: 'https://console.groq.com/keys',
  testNote: 'Free.',
  secretName: 'GROQ_API_KEY',
  set: true,
  secretUpdatedAt: '2026-10-15T10:00:00.000Z',
  lastTest: testResult,
  testStale: false,
} satisfies SpeedupStatus;

const cases: SchemaCase[] = [
  { name: 'provider', schema: speedups.SpeedupProviderSchema, value: 'jev' },
  { name: 'test code', schema: speedups.SpeedupTestCodeSchema, value: 'vault_damaged' },
  { name: 'test result', schema: speedups.SpeedupTestResultSchema, value: testResult },
  { name: 'status', schema: speedups.SpeedupStatusSchema, value: status },
  { name: 'view', schema: speedups.SpeedupsViewSchema, value: { providers: [status], vault: 'ok' } },
];

describe('speed-up schemas', () => {
  it('should round-trip every public speed-up schema', () => {
    assertRoundTrips(cases);
    assertCoversEverySchema(speedups, cases);
  });

  it('should refuse a field it does not name — a key smuggled into a status included', () => {
    assertRejects([
      { name: 'status with a value', schema: speedups.SpeedupStatusSchema, value: { ...status, value: 'gsk-live' } },
      { name: 'result with a body', schema: speedups.SpeedupTestResultSchema, value: { ...testResult, body: '{}' } },
      { name: 'unknown provider', schema: speedups.SpeedupProviderSchema, value: 'openai' },
    ]);
  });

  it('should name the status address', () => {
    should(speedups.SPEEDUPS_PATH).equal('/v1/speedups');
  });
});
