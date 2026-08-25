import { describe, expect, it } from 'bun:test';
import {
  MAX_SECRET_NAME_LENGTH,
  MIN_SECRET_VALUE_LENGTH,
  PutSecretRequestSchema,
  SECRET_SCHEMA_VERSION,
  SECRET_USE_DEFAULT_TIMEOUT_MS,
  SecretListSchema,
  SecretNameSchema,
  SecretSummarySchema,
  SecretUseRequestSchema,
  SecretUseResultSchema,
  SecretValueSchema,
  malformedSecretReference,
  secretMask,
  secretReference,
  secretReferencePattern,
  secretReferencesIn,
} from '../../src/lib/secrets.ts';

const AT = '2026-08-05T10:00:00.000Z';

describe('secret names', () => {
  it('accepts an environment-shaped name', () => {
    expect(SecretNameSchema.parse('ANTHROPIC_API_KEY')).toBe('ANTHROPIC_API_KEY');
    expect(SecretNameSchema.parse('A')).toBe('A');
    expect(SecretNameSchema.parse('A1_B2')).toBe('A1_B2');
  });

  it('refuses a name a shell could not export', () => {
    for (const bad of ['lower', '1LEAD', 'HAS-DASH', 'HAS SPACE', '', '_LEAD'])
      expect(SecretNameSchema.safeParse(bad).success).toBe(false);
  });

  it('bounds the name', () => {
    expect(SecretNameSchema.safeParse('A'.repeat(MAX_SECRET_NAME_LENGTH)).success).toBe(true);
    expect(SecretNameSchema.safeParse('A'.repeat(MAX_SECRET_NAME_LENGTH + 1)).success).toBe(false);
  });
});

describe('secret values', () => {
  it('refuses a value too short to redact safely', () => {
    expect(SecretValueSchema.safeParse('a'.repeat(MIN_SECRET_VALUE_LENGTH - 1)).success).toBe(false);
    expect(SecretValueSchema.safeParse('a'.repeat(MIN_SECRET_VALUE_LENGTH)).success).toBe(true);
  });

  it('does not trim, because whitespace can be load-bearing in a credential', () => {
    expect(SecretValueSchema.parse('  padded-secret  ')).toBe('  padded-secret  ');
  });

  it('parses a put request', () => {
    expect(PutSecretRequestSchema.parse({ name: 'TOKEN', value: 'sk-live-abcdef' })).toEqual({
      name: 'TOKEN',
      value: 'sk-live-abcdef',
    });
    expect(PutSecretRequestSchema.safeParse({ name: 'TOKEN', value: 'sk-live-abcdef', extra: 1 }).success).toBe(false);
  });
});

describe('the summary carries no value', () => {
  it('parses name and timestamps only', () => {
    const summary = SecretSummarySchema.parse({ name: 'TOKEN', createdAt: AT, updatedAt: AT });
    expect(Object.keys(summary).sort()).toEqual(['createdAt', 'name', 'updatedAt']);
  });

  it('refuses a summary that smuggles a value, a length or a digest', () => {
    for (const extra of [{ value: 'x' }, { length: 12 }, { digest: 'abc' }])
      expect(SecretSummarySchema.safeParse({ name: 'TOKEN', createdAt: AT, updatedAt: AT, ...extra }).success).toBe(
        false,
      );
  });
});

describe('the list distinguishes damaged from empty', () => {
  it('parses a ready store', () => {
    const list = SecretListSchema.parse({
      v: SECRET_SCHEMA_VERSION,
      health: 'ready',
      secrets: [{ name: 'TOKEN', createdAt: AT, updatedAt: AT }],
      references: [{ name: 'TOKEN', origin: 'config/daemon.json', resolved: true }],
    });
    expect(list.health).toBe('ready');
    expect(list.references[0]?.resolved).toBe(true);
  });

  it('parses a damaged store with its diagnosis', () => {
    const list = SecretListSchema.parse({
      v: SECRET_SCHEMA_VERSION,
      health: 'damaged',
      diagnosis: 'the vault key is missing while ciphertext remains',
      secrets: [],
      references: [],
    });
    expect(list.diagnosis).toContain('vault key');
  });

  it('refuses an unknown health', () => {
    expect(
      SecretListSchema.safeParse({ v: SECRET_SCHEMA_VERSION, health: 'fine', secrets: [], references: [] }).success,
    ).toBe(false);
  });
});

describe('the one reference grammar', () => {
  it('spells a reference', () => {
    expect(secretReference('TOKEN')).toBe('${secret:TOKEN}');
  });

  it('finds every distinct reference in first-appearance order', () => {
    expect(secretReferencesIn('Bearer ${secret:B} and ${secret:A} and ${secret:B}')).toEqual(['B', 'A']);
  });

  it('finds nothing in a value that only looks like one', () => {
    expect(secretReferencesIn('${SECRET:TOKEN} ${secret:lower} $secret:TOKEN {secret:TOKEN}')).toEqual([]);
  });

  it('hands out a fresh matcher so lastIndex is never shared', () => {
    const first = secretReferencePattern();
    first.exec('${secret:TOKEN}');
    expect(first.lastIndex).toBeGreaterThan(0);
    expect(secretReferencePattern().lastIndex).toBe(0);
  });

  it('masks by name, because the name is not the secret', () => {
    expect(secretMask('TOKEN')).toBe('[redacted:TOKEN]');
  });
});

/**
 * The near miss is the way this grammar actually breaks: a reference that matches nothing stays a
 * literal, is exported into a child verbatim, and the child authenticates with the text of it. Every
 * failure after that names a remote service and nothing anybody could have looked at.
 */
describe('a value that only looks like a reference', () => {
  it('names the malformed opener so a configuration can refuse it with the text of it', () => {
    expect(malformedSecretReference('${secret:work_key}')).toBe('${secret:work_key}');
  });

  it('is not excused by a well-formed reference beside it', () => {
    expect(malformedSecretReference('Bearer ${secret:GOOD} ${secret:bad}')).toBe('${secret:bad}');
  });

  it('catches an opener that was never closed', () => {
    expect(malformedSecretReference('${secret:UNCLOSED')).toBe('${secret:UNCLOSED');
  });

  it('says nothing about a value whose openers are all well formed', () => {
    expect(malformedSecretReference('Bearer ${secret:A} ${secret:B}')).toBeUndefined();
  });

  it('says nothing about a value with no opener at all, including one that resembles the tag', () => {
    expect(malformedSecretReference('${SECRET:TOKEN} $secret:TOKEN {secret:TOKEN}')).toBeUndefined();
  });
});

describe('the use request names secrets and never carries one', () => {
  it('defaults the optional half of a request', () => {
    const parsed = SecretUseRequestSchema.parse({ command: ['curl', 'https://example.test'], cwd: '/tmp' });
    expect(parsed.secrets).toEqual([]);
    expect(parsed.env).toEqual({});
    expect(parsed.timeoutMs).toBe(SECRET_USE_DEFAULT_TIMEOUT_MS);
  });

  it('carries names and reference-bearing env', () => {
    const parsed = SecretUseRequestSchema.parse({
      command: ['curl', '-H', 'Authorization: Bearer $TOKEN', 'https://example.test'],
      cwd: '/srv',
      secrets: ['TOKEN'],
      env: { AUTH: 'Bearer ${secret:TOKEN}' },
      timeoutMs: 1_000,
    });
    expect(parsed.secrets).toEqual(['TOKEN']);
    expect(secretReferencesIn(parsed.env.AUTH ?? '')).toEqual(['TOKEN']);
  });

  it('refuses an empty command and a bad env name', () => {
    expect(SecretUseRequestSchema.safeParse({ command: [], cwd: '/tmp' }).success).toBe(false);
    expect(SecretUseRequestSchema.safeParse({ command: ['env'], cwd: '/tmp', env: { 'BAD-NAME': 'x' } }).success).toBe(
      false,
    );
  });
});

describe('the use result', () => {
  it('parses a redacted result', () => {
    const result = SecretUseResultSchema.parse({
      outcome: 'exited',
      exitCode: 0,
      stdout: '[redacted:TOKEN]\n',
      stderr: '',
      truncated: false,
      used: ['TOKEN'],
    });
    expect(result.stdout).toBe('[redacted:TOKEN]\n');
  });

  it('allows a timeout with no exit code', () => {
    const result = SecretUseResultSchema.parse({
      outcome: 'timeout',
      stdout: '',
      stderr: '',
      truncated: false,
      used: [],
    });
    expect(result.exitCode).toBeUndefined();
  });
});
