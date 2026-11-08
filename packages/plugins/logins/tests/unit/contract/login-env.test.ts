import { describe, it } from 'bun:test';
import should from 'should';
import {
  LoginChangeSchema,
  LoginFileSchema,
  LoginHalfSchema,
  RESERVED_LOGIN_ENV_NAMES,
} from '../../../contract/index.ts';

// (no guarantees row) A login's environment may not set a variable Ferretry sets, nor hold a malformed secret reference.

const SECRET_VALUE = 'sk-live-should-never-be-echoed';

const refusal = (result: {
  success: boolean;
  error?: { issues: readonly { message: string; path: PropertyKey[] }[] };
}) => {
  should(result.success).be.false();
  return result.error?.issues ?? [];
};

describe('a login environment', () => {
  for (const name of RESERVED_LOGIN_ENV_NAMES) {
    it(`should refuse ${name} in a login file, a harness half, login.add and login.env, naming the key only`, () => {
      const env = { [name]: SECRET_VALUE };
      const results = [
        LoginFileSchema.safeParse({ harness: 'claude-code', store: 'environment', env }),
        LoginHalfSchema.safeParse({ env }),
        LoginChangeSchema.safeParse({
          kind: 'login.add',
          id: 'work',
          harness: 'claude-code',
          store: 'environment',
          env,
        }),
        LoginChangeSchema.safeParse({ kind: 'login.env', id: 'work', env }),
      ];
      for (const result of results) {
        const issues = refusal(result);
        should(issues.some(issue => issue.message.includes(`"${name}" is reserved`))).be.true();
        should(JSON.stringify(issues)).not.containEql(SECRET_VALUE);
      }
    });
  }

  it('should refuse a malformed secret reference everywhere, naming the key and not the value', () => {
    const env = { API_KEY: '${secret:work_key}' };
    const results = [
      LoginFileSchema.safeParse({ harness: 'claude-code', store: 'environment', env }),
      LoginHalfSchema.safeParse({ env }),
      LoginChangeSchema.safeParse({ kind: 'login.add', id: 'work', harness: 'claude-code', store: 'environment', env }),
      LoginChangeSchema.safeParse({ kind: 'login.env', id: 'work', env }),
    ];
    for (const result of results) {
      const issues = refusal(result);
      should(issues.some(issue => issue.message.includes('"API_KEY" holds a malformed secret reference'))).be.true();
      should(JSON.stringify(issues)).not.containEql('work_key');
    }
  });

  it('should refuse a non-POSIX name in a login file, a harness half, login.add and login.env, naming the key only', () => {
    for (const bad of ['BAD-NAME', 'A=B', '1ST']) {
      const env = { [bad]: SECRET_VALUE };
      const results = [
        LoginFileSchema.safeParse({ harness: 'claude-code', store: 'environment', env }),
        LoginHalfSchema.safeParse({ env }),
        LoginChangeSchema.safeParse({
          kind: 'login.add',
          id: 'work',
          harness: 'claude-code',
          store: 'environment',
          env,
        }),
        LoginChangeSchema.safeParse({ kind: 'login.env', id: 'work', env }),
      ];
      for (const result of results) {
        const issues = refusal(result);
        should(issues.some(issue => issue.message === `"${bad}" must be a POSIX environment variable name`)).be.true();
        should(JSON.stringify(issues)).not.containEql(SECRET_VALUE);
      }
    }
  });

  it('should report both a bad name and a reserved name when a file has both', () => {
    const env = { 'BAD-NAME': 'x', CODEX_HOME: 'y' };
    const messages = refusal(LoginFileSchema.safeParse({ harness: 'claude-code', store: 'environment', env })).map(
      issue => issue.message,
    );
    should(messages.some(m => m.includes('"BAD-NAME" must be a POSIX environment variable name'))).be.true();
    should(messages.some(m => m.includes('"CODEX_HOME" is reserved'))).be.true();
  });

  it('should accept ordinary variables, a well-formed secret reference and a kept variable', () => {
    const env = { API_KEY: '${secret:WORK_KEY}', REGION: 'eu-west-1' };
    should(LoginFileSchema.safeParse({ harness: 'claude-code', store: 'environment', env }).success).be.true();
    should(LoginHalfSchema.safeParse({ env }).success).be.true();
    should(
      LoginChangeSchema.safeParse({ kind: 'login.add', id: 'work', harness: 'claude-code', store: 'environment', env })
        .success,
    ).be.true();
    should(
      LoginChangeSchema.safeParse({ kind: 'login.env', id: 'work', env: { ...env, HIDDEN: { keep: true } } }).success,
    ).be.true();
  });
});
