import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import {
  GIT_PROVIDERS,
  GitAccountListSchema,
  GitAccountRemovedSchema,
  GitAccountSchema,
  GitAccountsConfigSchema,
  GitDeviceFlowSchema,
  GitDeviceFlowStatusSchema,
  gitAccountsLoosens,
  GITHUB_API_QUERY,
  GITHUB_API_RULES,
  GITHUB_CONSENT,
  GITHUB_DEVICE_CLIENT_ID,
  GITHUB_SCOPES,
  NO_SECRET_FIELDS,
  type GitAccount,
  type GitDeviceFlow,
  type GitDeviceFlowStatus,
} from '../../contract/index.ts';
import manifest from '../../manifest.ts';

/** Every key of a zod schema's object shape, through unions and arrays. */
function keysOf(schema: z.ZodType): string[] {
  const def = (
    schema as unknown as {
      def: {
        type: string;
        shape?: Record<string, z.ZodType>;
        options?: z.ZodType[];
        element?: z.ZodType;
        innerType?: z.ZodType;
      };
    }
  ).def;
  switch (def.type) {
    case 'object':
      return Object.entries(def.shape ?? {}).flatMap(([key, value]) => [key, ...keysOf(value)]);
    case 'union':
      return (def.options ?? []).flatMap(keysOf);
    case 'array':
      return def.element === undefined ? [] : keysOf(def.element);
    case 'optional':
    case 'default':
      return def.innerType === undefined ? [] : keysOf(def.innerType);
    default:
      return [];
  }
}

// Compile-time: none of these shapes has a token-like key (a typed field would break the build here).
type Forbidden = 'token' | 'accessToken' | 'secret' | 'deviceCode' | 'device_code' | 'password' | 'privateKey';
type NoSecret<T> = Extract<keyof T, Forbidden> extends never ? true : never;
const accountIsClean: NoSecret<GitAccount> = true;
const flowIsClean: NoSecret<GitDeviceFlow> = true;
const statusIsClean: NoSecret<Extract<GitDeviceFlowStatus, { status: 'done' }>> = true;

describe('git-accounts contract', () => {
  test('no wire shape has a field that could carry a token, a device code or key material', () => {
    expect([accountIsClean, flowIsClean, statusIsClean]).toEqual([true, true, true]);
    for (const schema of [
      GitAccountSchema,
      GitAccountListSchema,
      GitDeviceFlowSchema,
      GitDeviceFlowStatusSchema,
      GitAccountRemovedSchema,
    ])
      for (const key of keysOf(schema)) expect(NO_SECRET_FIELDS.test(key)).toBe(false);
  });

  test('wire objects are strict: an extra field (a smuggled token) does not parse', () => {
    const account = {
      id: 'gha_1',
      provider: 'github',
      githubId: 1,
      login: 'a',
      scopes: [],
      keys: {},
      createdAt: '2026-11-19T00:00:00.000Z',
    };
    expect(GitAccountSchema.safeParse(account).success).toBe(true);
    expect(GitAccountSchema.safeParse({ ...account, token: 'gho_x' }).success).toBe(false);
    expect(
      GitDeviceFlowStatusSchema.safeParse({ status: 'done', accountId: 'gha_1', login: 'a', token: 'x' }).success,
    ).toBe(false);
  });

  test('the provider is a closed union with room for GitLab later', () => {
    expect(GIT_PROVIDERS).toEqual(['github']);
  });

  test('the connect-time scopes are one constant, with repo and read:org but never workflow', () => {
    expect([...GITHUB_SCOPES]).toEqual([
      'read:user',
      'user:email',
      'write:public_key',
      'write:ssh_signing_key',
      'repo',
      'read:org',
    ]);
    expect((GITHUB_SCOPES as readonly string[]).includes('workflow')).toBe(false);
  });

  test('the consent text says plainly that repo means every repository, private ones included', () => {
    const text = GITHUB_CONSENT.join(' ');
    expect(text).toContain('read and write EVERY repository');
    expect(text).toContain('private ones included');
    expect(text).toContain('workflow');
    expect(text).toContain('sealed');
  });

  test('the client id is the owner’s public app id, and no client secret is a field of the config', () => {
    expect(GITHUB_DEVICE_CLIENT_ID).toBe('Ov23liHZjkFulWlicHXd');
    expect(GitAccountsConfigSchema.parse({}).github.clientId).toBe(GITHUB_DEVICE_CLIENT_ID);
  });

  test('the API rules: REST reads and writes, GraphQL by POST, and DELETE only for the two key kinds', () => {
    const allowed = (method: keyof typeof GITHUB_API_RULES, path: string): boolean =>
      GITHUB_API_RULES[method].some(rule => rule.test(path));
    for (const path of ['/user', '/repos/o/r/pulls', '/repos/o/r/commits/abc/check-runs', '/notifications'])
      expect(allowed('GET', path)).toBe(true);
    for (const method of ['POST', 'PATCH'] as const) expect(allowed(method, '/repos/o/r/issues/3/comments')).toBe(true);
    expect(allowed('POST', '/graphql')).toBe(true);
    for (const method of ['GET', 'PATCH', 'DELETE'] as const) expect(allowed(method, '/graphql')).toBe(false);
    expect(allowed('DELETE', '/user/keys/12')).toBe(true);
    expect(allowed('DELETE', '/user/ssh_signing_keys/9')).toBe(true);
    for (const path of ['/repos/o/r', '/user/keys', '/user/keys/abc', '/user/repos'])
      expect(allowed('DELETE', path)).toBe(false);
    for (const path of ['', '/', 'user', 'https://evil.example/user', '/user keys'])
      for (const method of ['GET', 'POST', 'PATCH'] as const) expect(allowed(method, path)).toBe(false);
    expect(GITHUB_API_QUERY.test('?per_page=100&page=2')).toBe(true);
    for (const query of ['?', '?a=b c', '#x', '?a=<script>', '?a=b\n'])
      expect(GITHUB_API_QUERY.test(query)).toBe(false);
  });

  test('changing the OAuth client id is a loosening held for the owner; leaving it is not', () => {
    const a = GitAccountsConfigSchema.parse({ github: { clientId: 'Ov23a' } });
    const b = GitAccountsConfigSchema.parse({ github: { clientId: 'Ov23b' } });
    expect(gitAccountsLoosens(a, a)).toEqual([]);
    expect(gitAccountsLoosens(a, b)).toHaveLength(1);
    expect(GitAccountsConfigSchema.safeParse({ github: { clientId: 'has space' } }).success).toBe(false);
    expect(GitAccountsConfigSchema.safeParse({ github: { clientId: 'x', clientSecret: 'no' } }).success).toBe(false);
  });
});

describe('git-accounts manifest', () => {
  const byKey = new Map<string, (typeof manifest.actions.routes)[number]>(
    manifest.actions.routes.map(route => [route.key, route]),
  );
  test('declares the seven routes, each governed by an existing capability (no new one)', () => {
    expect([...byKey.keys()].sort()).toEqual([
      'DELETE /v1/git-accounts/:id',
      'DELETE /v1/git-accounts/:id/keys/:purpose',
      'GET /v1/git-accounts',
      'GET /v1/git-accounts/github/device/:flowId',
      'POST /v1/git-accounts/:id/keys',
      'POST /v1/git-accounts/gh/run',
      'POST /v1/git-accounts/github/device',
    ]);
    for (const route of byKey.values()) expect(route.capability?.axis).toBeDefined();
    // Ferretry's gh (B9): a ferret calls it on its own credential; a paired device needs secrets.use.
    expect([
      byKey.get('POST /v1/git-accounts/gh/run')?.capability?.axis,
      byKey.get('POST /v1/git-accounts/gh/run')?.caller,
    ]).toEqual(['use', 'any']);
    expect(byKey.get('GET /v1/git-accounts')?.capability?.axis).toBe('use');
    for (const key of [
      'DELETE /v1/git-accounts/:id',
      'DELETE /v1/git-accounts/:id/keys/:purpose',
      'POST /v1/git-accounts/:id/keys',
      'POST /v1/git-accounts/github/device',
      'GET /v1/git-accounts/github/device/:flowId',
    ])
      expect([byKey.get(key)?.capability?.axis, byKey.get(key)?.caller]).toEqual(['configure', 'person']);
  });
  test('the CLI verbs are `fy git account add|ls|rm`, and Ferretry’s `fy gh` with its pane check (B10)', () => {
    expect(manifest.actions.cli.map(verb => verb.verb)).toEqual([
      'gh',
      'gh-doctor',
      'git account add',
      'git account ls',
      'git account rm',
    ]);
  });
  test('only GitHub is reached, the tokens and keys files are private, and no secret is named', () => {
    expect(manifest.permissions?.network).toEqual(['github.com', 'api.github.com']);
    expect(manifest.privacy?.private).toEqual(['tokens.json', 'keys.json']);
    expect(Object.keys(manifest.permissions ?? {}).sort()).toEqual([
      'checkDirectory',
      'cliEnvReads',
      'hostFacts',
      'network',
      'roots',
      'spawn',
      'which',
    ]);
    // `fy gh-doctor` reads these NAMES from a pane to warn about them; no value is ever printed, and no `FY_*` is among them.
    expect(manifest.permissions?.cliEnvReads).toEqual([
      'PATH',
      'GH_CONFIG_DIR',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GH_ENTERPRISE_TOKEN',
    ]);
  });
});
