import { expect, test } from 'bun:test';
import type { LoginFile } from '../../contract/index.ts';
import { sampleLogin } from '../../contract/testing/index.ts';
import { loginKinds } from '../../daemon/lib/kinds.ts';
import { credentialHarnessKeys } from '../../daemon/lib/shared/halves.ts';

function fixture() {
  let credentials = 0;
  let stores = 0;
  const files = new Map<string, LoginFile>([
    ['subscription', { harness: 'claude-code', store: 'ferretry' } as LoginFile],
    ['openai', { harness: 'codex', store: 'ferretry' } as LoginFile],
    [
      'key',
      {
        harness: 'claude-code',
        store: 'environment',
        preset: 'anthropic-api-key',
        env: { ANTHROPIC_API_KEY: '${secret:API_KEY}' },
      } as LoginFile,
    ],
    [
      'endpoint',
      {
        harness: 'claude-code',
        store: 'environment',
        preset: 'deepseek',
        claude: {
          env: {
            ANTHROPIC_AUTH_TOKEN: '${secret:DEEPSEEK_API_KEY}',
            ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          },
        },
        codex: { env: { DEEPSEEK_API_KEY: '${secret:DEEPSEEK_API_KEY}' } },
      } as LoginFile,
    ],
  ]);
  const kinds = loginKinds({
    files: () => files,
    clock: { sleep: async () => undefined },
    view: async id => sampleLogin(id),
    check: async id => sampleLogin(id),
    launchStore: async () => {
      stores++;
      return { kind: 'none' };
    },
    shareCredential: async () => {
      credentials++;
      return undefined;
    },
    credentialProblem: async () => undefined,
    startSignIn: async () => {
      throw new Error('must not sign in');
    },
    signInStatus: async () => {
      throw new Error('must not sign in');
    },
  });
  return { kinds, credentials: () => credentials, stores: () => stores };
}

test('OpenCode spends existing API-key/endpoint logins with their native env names', async () => {
  const f = fixture();
  expect(f.kinds['api-key'].harnesses).toContain('opencode');
  expect(f.kinds.endpoint.harnesses).toContain('opencode');
  expect(await f.kinds['api-key'].env('key', 'opencode')).toEqual({ ANTHROPIC_API_KEY: '${secret:API_KEY}' });
  expect(await f.kinds.endpoint.env('endpoint', 'opencode')).toMatchObject({
    DEEPSEEK_API_KEY: '${secret:DEEPSEEK_API_KEY}',
  });
  expect(f.credentials()).toBe(0);
  expect(f.stores()).toBe(0);
  expect(credentialHarnessKeys({ harness: 'claude', store: 'environment' })).toEqual(['claude-code', 'opencode']);
});

test('an Anthropic subscription is refused by login kind before env, credential or store access', async () => {
  const f = fixture();
  expect(f.kinds.anthropic.harnesses).toEqual(['claude-code']);
  await expect(f.kinds.anthropic.env('subscription', 'opencode')).rejects.toThrow('Anthropic subscription');
  await expect(f.kinds.openai.env('openai', 'opencode')).rejects.toThrow('API-key and endpoint');
  expect(f.credentials()).toBe(0);
  expect(f.stores()).toBe(0);
  expect(credentialHarnessKeys({ harness: 'claude', store: 'ferretry' })).toEqual(['claude-code']);
});
