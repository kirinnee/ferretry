import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
import { AliasSchema, EnvSchema, RESERVED_ENV_NAMES, SafeNameSchema, UsageSchema } from '../../src/lib/config.ts';

const ID_ONE = '00000000-0000-4000-8000-000000000001';

/** Every issue message a failed parse produced, so a test can assert on cause not position. */
const messagesOf = (schema: z.ZodType, input: unknown): string[] => {
  const parsed = schema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
};

describe('SafeNameSchema', () => {
  it.each([
    ['plain', 'kirin'],
    ['hyphenated', 'crc-auto-atomi'],
  ])('should accept a %s name', (_label, name) => {
    should(messagesOf(SafeNameSchema, name)).deepEqual([]);
  });

  it.each([
    ['surrounding whitespace', ' kirin', /whitespace/],
    ['a path separator', 'a/b', /path separator/],
    ['a traversal segment', '..', /traversal/],
    ['a control character', 'a\u0007b', /control characters/],
  ])('should refuse a name with %s', (_label, name, expected) => {
    should(messagesOf(SafeNameSchema, name)).matchAny(expected);
  });
});

describe('EnvSchema', () => {
  it('should accept literals, environment references and secret references', () => {
    // Arrange
    const input = {
      A: 'literal',
      B: '$HOME',
      ANTHROPIC_API_KEY: '${secret:WORK_KEY}',
      AUTH: 'Bearer ${secret:WORK_KEY}',
    };

    // Act / Assert
    should(messagesOf(EnvSchema, input)).deepEqual([]);
  });

  it('should refuse a malformed secret reference rather than accept it as a literal', () => {
    // Act
    const actual = messagesOf(EnvSchema, { ANTHROPIC_API_KEY: '${secret:work_key}' });

    // Assert
    should(actual).matchAny(/is not a secret reference/);
    should(actual).matchAny(/\$\{secret:WORK_KEY\}/);
  });

  it('should reject an environment name that is not a POSIX identifier', () => {
    should(messagesOf(EnvSchema, { 'NOT-POSIX': 'x' })).matchAny(/POSIX/);
  });

  it.each([...RESERVED_ENV_NAMES])('should refuse to let configuration assign %s', reserved => {
    should(messagesOf(EnvSchema, { [reserved]: '${secret:WORK_KEY}' })).matchAny(/is reserved/);
  });

  it('should say why the credential store variable is reserved', () => {
    should(messagesOf(EnvSchema, { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/x' })).matchAny(
      /"CLAUDE_SECURESTORAGE_CONFIG_DIR" is reserved — Ferretry sets it to the runtime's own credential/,
    );
  });
});

describe('AliasSchema', () => {
  it('should require an alias to list flags for at least one harness', () => {
    should(messagesOf(AliasSchema, {})).matchAny(/at least one harness/);
    should(messagesOf(AliasSchema, { claude: '--chrome --rc' })).deepEqual([]);
  });
});

describe('UsageSchema', () => {
  it('should default every field when the block is absent', () => {
    // Act
    const actual = UsageSchema.parse(undefined);

    // Assert
    should(actual.enabled).be.true();
    should(actual.cliProxy).deepEqual([]);
  });

  it('should require exactly one management key source on a proxy pool', () => {
    // Arrange
    const pool = { url: 'http://127.0.0.1:8317', accounts: [ID_ONE] };

    // Act / Assert
    should(messagesOf(UsageSchema, { cliProxy: [pool] })).matchAny(/exactly one of managementKey/);
    should(messagesOf(UsageSchema, { cliProxy: [{ ...pool, managementKeyFile: '~/key' }] })).deepEqual([]);
  });
});
