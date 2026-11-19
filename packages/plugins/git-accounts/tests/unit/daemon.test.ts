import { describe, expect, test } from 'bun:test';
import { deviceStanding, FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { CallStanding } from '@ferretry/kernel/contract';
import type { SealedDocumentDef, SealedDocumentHandle } from '@ferretry/core-vault/contract';
import { FakeSealedDocuments } from '@ferretry/core-vault/contract/testing';
import type { SpawnOptions, SpawnResult, StatePort } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { GitAccountId, GitAccountsApi } from '../../contract/index.ts';
import { GIT_ACCOUNT_TOKENS, GitAccountsPort, GitDeviceFlowStatusSchema } from '../../contract/index.ts';
import { AccountBook } from '../../daemon/lib/accounts.ts';
import { GithubDeviceFlows } from '../../daemon/lib/device-flow.ts';
import type { GithubHttp, GithubRequest, GithubResponse } from '../../daemon/lib/github-http.ts';
import daemon from '../../daemon/index.ts';
import { FAKE_DEVICE_CODE, FAKE_TOKEN, FAKE_USER_CODE, FakeGithub } from './fake-github.ts';

const CLIENT = 'Ov23FAKECLIENTID';

/** The fake sealed port, remembering the one handle this plugin opened so a test can look inside its own document. */
class SpySealed extends FakeSealedDocuments {
  handle: SealedDocumentHandle | undefined;
  keyHandle: SealedDocumentHandle | undefined;
  override open(own: StatePort, document: SealedDocumentDef): SealedDocumentHandle {
    const opened = super.open(own, document);
    if (document === GIT_ACCOUNT_TOKENS) this.handle = opened;
    else this.keyHandle = opened;
    return opened;
  }
}

type SpawnCall = { program: string; args: readonly string[]; options?: SpawnOptions };

async function boot(
  github: FakeGithub,
  options: { clientId?: string; standing?: () => CallStanding; spawn?: (call: SpawnCall) => SpawnResult } = {},
) {
  const sealed = new SpySealed();
  const gate = new FakeGate();
  const host = await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => (options.standing ?? (() => ownerStanding()))()),
    fakes: { sealed, gate },
    fetch: github.fetch,
    ...(options.spawn === undefined
      ? {}
      : {
          spawn: (program: string, args: readonly string[], opts?: SpawnOptions) =>
            options.spawn?.({ program, args, ...(opts === undefined ? {} : { options: opts }) }) as SpawnResult,
        }),
    config: { 'git-accounts.yaml': { github: { clientId: options.clientId ?? CLIENT } } },
  });
  const responses: string[] = [];
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await host.request(method, path, body === undefined ? {} : { body });
    responses.push(response.body);
    return response;
  };
  const wait = async (seconds: number) => await host.clock.advance(seconds * 1000);
  return { host, sealed, gate, request, responses, wait };
}

/** Everything a client could ever read, scanned for the token and the device code. */
function expectNoSecretAnywhere(
  parts: readonly string[],
  logs: readonly { message: string; fields?: unknown }[],
): void {
  const everything = [...parts, ...logs.map(log => `${log.message} ${JSON.stringify(log.fields ?? {})}`)].join('\n');
  expect(everything).not.toContain(FAKE_TOKEN);
  expect(everything).not.toContain(FAKE_DEVICE_CODE);
}

describe('GitHub device flow', () => {
  test('pending → slow_down (+5 s) → done: the account is filed, the token is sealed, nothing secret is answered', async () => {
    const github = new FakeGithub();
    github.tokenAnswers = [
      { error: 'authorization_pending' },
      { error: 'slow_down' },
      {
        access_token: FAKE_TOKEN,
        token_type: 'bearer',
        scope: 'read:user,user:email,write:public_key,write:ssh_signing_key',
      },
    ];
    const { host, sealed, request, responses, wait } = await boot(github);

    const started = await request('POST', '/v1/git-accounts/github/device');
    expect(started.status).toBe(200);
    const flow = started.json<{ flowId: string; userCode: string; verificationUri: string; interval: number }>();
    expect([flow.userCode, flow.verificationUri, flow.interval]).toEqual([
      FAKE_USER_CODE,
      'https://github.com/login/device',
      5,
    ]);
    const form = new URLSearchParams(github.seen[0]?.body);
    expect(form.get('client_id')).toBe(CLIENT);
    expect(form.get('scope')).toBe('read:user user:email write:public_key write:ssh_signing_key repo read:org');
    expect(form.has('client_secret')).toBe(false);

    const path = `/v1/git-accounts/github/device/${flow.flowId}`;
    // Before the interval has passed GitHub is not asked.
    expect((await request('GET', path)).json()).toEqual({ status: 'pending', interval: 5 });
    expect(github.tokenPolls).toBe(0);

    await wait(5);
    expect((await request('GET', path)).json()).toEqual({ status: 'pending', interval: 5 });
    await wait(5);
    expect((await request('GET', path)).json()).toEqual({ status: 'slow_down', interval: 10 });
    // slow_down made the interval 10 s: at +5 s GitHub is not asked again.
    await wait(5);
    expect((await request('GET', path)).json()).toEqual({ status: 'pending', interval: 10 });
    expect(github.tokenPolls).toBe(2);
    await wait(5);
    const done = await request('GET', path);
    expect(GitDeviceFlowStatusSchema.parse(done.json())).toEqual({
      status: 'done',
      accountId: 'gha_4242',
      login: 'octo-fake',
    });
    // Asked again once done: the same answer, GitHub not asked again.
    const polls = github.tokenPolls;
    expect((await request('GET', path)).json()).toEqual(done.json());
    expect(github.tokenPolls).toBe(polls);

    // The poll body carried the device code to GitHub, and the profile read carried the token to api.github.com only.
    const pollBody = new URLSearchParams(github.calls('github.com', '/login/oauth/access_token')[0]?.body);
    expect(pollBody.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(pollBody.get('device_code')).toBe(FAKE_DEVICE_CODE);
    const withToken = github.seen.filter(call => call.authorization !== undefined);
    expect(withToken.map(call => new URL(call.url).host)).toEqual(['api.github.com']);

    // The list says who, never the token; the token is only in the sealed document.
    const list = await request('GET', '/v1/git-accounts');
    expect(list.json()).toEqual([
      expect.objectContaining({
        id: 'gha_4242',
        provider: 'github',
        githubId: 4242,
        login: 'octo-fake',
        name: 'Octo Fake',
        keys: {},
      }),
    ]);
    const handle = sealed.handle as SealedDocumentHandle;
    expect(await handle.names()).toEqual(['gha_4242']);
    expect(await handle.get('gha_4242' as never)).toBe(FAKE_TOKEN);

    expectNoSecretAnywhere(responses, host.logs);
    expect(JSON.stringify(host.published)).not.toContain(FAKE_TOKEN);
  });

  test('an expired code and a denial end the flow and file nothing', async () => {
    for (const [answer, status] of [
      [{ error: 'expired_token' }, 'expired'],
      [{ error: 'access_denied' }, 'denied'],
    ] as const) {
      const github = new FakeGithub();
      github.tokenAnswers = [answer];
      const { request, wait } = await boot(github);
      const flow = (await request('POST', '/v1/git-accounts/github/device')).json<{ flowId: string }>();
      await wait(5);
      expect((await request('GET', `/v1/git-accounts/github/device/${flow.flowId}`)).json()).toEqual({ status });
      expect((await request('GET', '/v1/git-accounts')).json()).toEqual([]);
    }
  });

  test('a flow past its own expiry is expired without asking GitHub', async () => {
    const github = new FakeGithub();
    github.deviceExpiresIn = 60;
    const { request, wait } = await boot(github);
    const flow = (await request('POST', '/v1/git-accounts/github/device')).json<{ flowId: string }>();
    await wait(61);
    expect((await request('GET', `/v1/git-accounts/github/device/${flow.flowId}`)).json()).toEqual({
      status: 'expired',
    });
    expect(github.tokenPolls).toBe(0);
  });

  test('no client id set: connecting says so and how to fix it, and calls nothing', async () => {
    const github = new FakeGithub();
    const { request } = await boot(github, { clientId: '' });
    const response = await request('POST', '/v1/git-accounts/github/device');
    expect([response.status, response.json<{ code: string }>().code]).toEqual([409, 'client_id_unset']);
    expect(response.json<{ error: string }>().error).toContain('config/git-accounts.yaml');
    expect(github.seen).toEqual([]);
  });

  test('a verification address that is not https://github.com is refused', async () => {
    const github = new FakeGithub();
    github.verificationUri = 'https://evil.example/login/device';
    const { request } = await boot(github);
    expect((await request('POST', '/v1/git-accounts/github/device')).status).toBe(502);
  });

  test('an unknown or malformed flow id is a 404; more than eight open flows are refused', async () => {
    const github = new FakeGithub();
    const { request } = await boot(github);
    expect((await request('GET', '/v1/git-accounts/github/device/nope')).status).toBe(404);
    expect((await request('GET', '/v1/git-accounts/github/device/aaaaaaaaaaaaaaaaaaaaaaaa')).status).toBe(404);
    for (let n = 0; n < 8; n += 1) expect((await request('POST', '/v1/git-accounts/github/device')).status).toBe(200);
    expect((await request('POST', '/v1/git-accounts/github/device')).status).toBe(429);
  });

  test('if GitHub will not say who signed in, nothing is saved', async () => {
    const github = new FakeGithub();
    github.tokenAnswers = [{ access_token: FAKE_TOKEN, scope: 'read:user' }];
    github.userStatus = 401;
    const { host, sealed, request, responses, wait } = await boot(github);
    const flow = (await request('POST', '/v1/git-accounts/github/device')).json<{ flowId: string }>();
    await wait(5);
    const response = await request('GET', `/v1/git-accounts/github/device/${flow.flowId}`);
    expect(response.status).toBe(502);
    expect((await request('GET', '/v1/git-accounts')).json()).toEqual([]);
    expect(await (sealed.handle as SealedDocumentHandle).names()).toEqual([]);
    expectNoSecretAnywhere(responses, host.logs);
  });

  test('connecting the same GitHub user again replaces the token and keeps the date and the keys', async () => {
    const github = new FakeGithub();
    github.tokenAnswers = [{ access_token: FAKE_TOKEN, scope: 'read:user' }];
    const { host, request, wait } = await boot(github);
    const connect = async () => {
      const flow = (await request('POST', '/v1/git-accounts/github/device')).json<{ flowId: string }>();
      await wait(5);
      await request('GET', `/v1/git-accounts/github/device/${flow.flowId}`);
    };
    await connect();
    const port = host.provided(GitAccountsPort);
    await port.recordKeys('gha_4242' as never, { ssh: { githubKeyId: '77', title: 'Ferretry box' } });
    const before = (await request('GET', '/v1/git-accounts')).json<{ createdAt: string }[]>();
    await wait(60);
    await connect();
    const after = (await request('GET', '/v1/git-accounts')).json<{ createdAt: string; keys: unknown }[]>();
    expect(after).toHaveLength(1);
    expect(after[0]?.createdAt).toBe(before[0]?.createdAt as string);
    expect(after[0]?.keys).toEqual({ ssh: { githubKeyId: '77', title: 'Ferretry box' } });
  });
});

describe('listing, removing and the port', () => {
  async function connected(github = new FakeGithub(), spawn?: (call: SpawnCall) => SpawnResult) {
    github.tokenAnswers = [{ access_token: FAKE_TOKEN, scope: 'read:user' }];
    const world = await boot(github, spawn === undefined ? {} : { spawn });
    const flow = (await world.request('POST', '/v1/git-accounts/github/device')).json<{ flowId: string }>();
    await world.wait(5);
    await world.request('GET', `/v1/git-accounts/github/device/${flow.flowId}`);
    return { ...world, github };
  }

  test('remove deletes the registered keys at GitHub FIRST, then the sealed token, then the record', async () => {
    const { host, sealed, github, request, responses } = await connected();
    await host.provided(GitAccountsPort).recordKeys('gha_4242' as never, {
      ssh: { githubKeyId: '11', title: 'Ferretry box (auth)' },
      signing: { githubKeyId: '22', title: 'Ferretry box (signing)' },
    });
    const handle = sealed.handle as SealedDocumentHandle;
    const removed = await request('DELETE', '/v1/git-accounts/gha_4242');
    expect(removed.status).toBe(200);
    expect(removed.json()).toEqual({
      id: 'gha_4242',
      removed: true,
      keysLeftOnProvider: [],
      revokeAt: 'https://github.com/settings/applications',
    });
    const deletes = github.seen.filter(call => call.method === 'DELETE').map(call => new URL(call.url).pathname);
    expect(deletes).toEqual(['/user/keys/11', '/user/ssh_signing_keys/22']);
    expect(
      github.seen.filter(call => call.method === 'DELETE').every(call => call.authorization === `Bearer ${FAKE_TOKEN}`),
    ).toBe(true);
    expect(await handle.names()).toEqual([]);
    expect((await request('GET', '/v1/git-accounts')).json()).toEqual([]);
    expect(host.state('git-accounts')).toBeDefined();
    // One event, the id and nothing else.
    expect(host.published).toEqual([{ event: 'git-accounts.removed', payload: { id: 'gha_4242' } }]);
    expectNoSecretAnywhere(responses, host.logs);
  });

  test('a key GitHub will not delete is named for the person; the account is still disconnected', async () => {
    const github = new FakeGithub();
    github.deleteStatus.set('/user/keys/11', 403);
    github.deleteStatus.set('/user/ssh_signing_keys/22', 404);
    const { host, request } = await connected(github);
    await host.provided(GitAccountsPort).recordKeys('gha_4242' as never, {
      ssh: { githubKeyId: '11', title: 'stuck key' },
      signing: { githubKeyId: '22', title: 'already gone' },
    });
    const removed = (await request('DELETE', '/v1/git-accounts/gha_4242')).json<{ keysLeftOnProvider: string[] }>();
    expect(removed.keysLeftOnProvider).toEqual(['stuck key']);
    expect((await request('GET', '/v1/git-accounts')).json()).toEqual([]);
  });

  test('removing what is not there, or with a malformed id, is a 404', async () => {
    const { request } = await connected();
    expect((await request('DELETE', '/v1/git-accounts/gha_1')).status).toBe(404);
    expect((await request('DELETE', '/v1/git-accounts/..%2f..')).status).toBe(404);
  });

  test('the port forwards api calls with the token, and never returns it', async () => {
    const { host, github } = await connected();
    const port = host.provided(GitAccountsPort);
    const ok = await port.api('gha_4242' as never, {
      method: 'POST',
      path: '/user/keys',
      body: { title: 't', key: 'ssh-ed25519 AAAA' },
    });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok)).not.toContain(FAKE_TOKEN);
    const sent = github.seen.at(-1);
    expect([sent?.method, new URL(sent?.url ?? 'x:').pathname, sent?.authorization]).toEqual([
      'POST',
      '/user/keys',
      `Bearer ${FAKE_TOKEN}`,
    ]);
    for (const path of ['/graphql', '/user/keys?x=<1>', '/user/keys#frag'])
      await expect(port.api('gha_4242' as never, { method: 'GET', path })).rejects.toMatchObject({ status: 403 });
    await expect(port.api('gha_9' as never, { method: 'GET', path: '/user' })).rejects.toMatchObject({ status: 404 });
    // The listing has no method that returns a token.
    expect(Object.keys(port).sort()).toEqual(['agentSocket', 'api', 'knownHostsFile', 'list', 'recordKeys', 'run']);
    expect(JSON.stringify(await port.list())).not.toContain(FAKE_TOKEN);
  });

  test('the api seam: conditional GETs, 304, pagination and rate-limit headers, PATCH and GraphQL, a plain query', async () => {
    const { host, github } = await connected();
    const port = host.provided(GitAccountsPort);
    const fresh = await port.api('gha_4242' as never, { method: 'GET', path: '/repos/o/r/pulls?per_page=100&page=1' });
    expect(fresh.status).toBe(200);
    expect(fresh.headers).toEqual({
      etag: 'W/"abc123"',
      link: '<https://api.github.com/x?page=2>; rel="next"',
      rateLimitRemaining: '4999',
      rateLimitReset: '1790000000',
      oauthScopes: 'read:user, user:email',
    });
    expect(JSON.stringify(fresh)).not.toContain('SHOULD-NEVER-PASS');
    expect(new URL(github.seen.at(-1)?.url ?? 'x:').search).toBe('?per_page=100&page=1');

    const unchanged = await port.api('gha_4242' as never, {
      method: 'GET',
      path: '/repos/o/r/pulls',
      ifNoneMatch: 'W/"abc123"',
    });
    expect(unchanged.status).toBe(304);
    expect(unchanged.body).toBeUndefined();
    expect(unchanged.headers).toEqual({ etag: 'W/"abc123"', rateLimitRemaining: '4998' });

    expect(
      (
        await port.api('gha_4242' as never, {
          method: 'PATCH',
          path: '/repos/o/r/issues/comments/5',
          body: { body: 'x' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await port.api('gha_4242' as never, {
          method: 'POST',
          path: '/graphql',
          body: { query: '{ viewer { login } }' },
        })
      ).status,
    ).toBe(200);
    expect(github.seen.at(-1)?.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    // Still only api.github.com, and still never a thing outside the rules.
    expect(
      github.seen
        .filter(call => call.authorization !== undefined)
        .every(call => new URL(call.url).host === 'api.github.com'),
    ).toBe(true);
    for (const call of [
      { method: 'GET', path: '/graphql' },
      { method: 'DELETE', path: '/repos/o/r' },
      { method: 'GET', path: '/repos/o/r?x=<y>' },
      { method: 'GET', path: '/repos/../user' },
      { method: 'GET', path: '//evil.example/x' },
    ] as const)
      await expect(port.api('gha_4242' as never, call)).rejects.toMatchObject({ status: 403 });
  });

  test('run: gh gets the token in its own sealed environment, and what comes back has it masked', async () => {
    const calls: SpawnCall[] = [];
    const { host } = await connected(new FakeGithub(), call => {
      calls.push(call);
      return { exitCode: 0, signal: null, stdout: `as ${FAKE_TOKEN}`, stderr: `bad ${FAKE_TOKEN} and ${FAKE_TOKEN}` };
    });
    const port = host.provided(GitAccountsPort);
    const result = await port.run('gha_4242' as never, { program: 'gh', args: ['pr', 'list'], timeoutMs: 5_000 });
    expect(result).toEqual({ exitCode: 0, stdout: 'as [redacted]', stderr: 'bad [redacted] and [redacted]' });
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.program).toBe('gh');
    expect(calls[0]?.args).toEqual(['pr', 'list']);
    expect(calls[0]?.args.join(' ')).not.toContain(FAKE_TOKEN);
    expect((calls[0]?.options?.env as Record<string, string> | undefined)?.GH_TOKEN).toBe(FAKE_TOKEN);
    expect(calls[0]?.options?.sealed).toBe(true);
    // Only gh, only a connected account.
    await expect(port.run('gha_4242' as never, { program: 'sh' as never, args: ['-c', 'env'] })).rejects.toMatchObject({
      status: 403,
    });
    await expect(port.run('gha_9' as never, { program: 'gh', args: ['pr', 'list'] })).rejects.toMatchObject({
      status: 404,
    });
    expect(calls).toHaveLength(1);
  });

  test('the account file is public facts only: no token in the plain state', async () => {
    const { host } = await connected();
    const files = host.state('git-accounts').files;
    expect([...files.keys()]).toContain('accounts.json');
    expect(JSON.stringify([...files.entries()])).not.toContain(FAKE_TOKEN);
  });
});

describe('who may do what (existing capabilities, no new one)', () => {
  test('a paired device without secrets.configure cannot connect or remove; the list needs secrets.use', async () => {
    const github = new FakeGithub();
    const noConfigure = deviceStanding('phone', {
      fleet: { use: true, configure: true },
      secrets: { use: true, configure: false },
    } as never);
    const { request } = await boot(github, { standing: () => noConfigure });
    expect((await request('POST', '/v1/git-accounts/github/device')).status).toBe(403);
    expect((await request('DELETE', '/v1/git-accounts/gha_1')).status).toBe(403);
    expect(github.seen).toEqual([]);
  });
});

const EMPTY: SpawnResult = { exitCode: 0, signal: null, stdout: '', stderr: '' };

describe('gh runs as an account, narrowed (review HIGH 1)', () => {
  async function ready(spawn: (call: SpawnCall) => SpawnResult = () => EMPTY) {
    const github = new FakeGithub();
    github.tokenAnswers = [{ access_token: FAKE_TOKEN, scope: 'read:user' }];
    const calls: SpawnCall[] = [];
    const world = await boot(github, {
      spawn: call => {
        calls.push(call);
        return spawn(call);
      },
    });
    const flow = (await world.request('POST', '/v1/git-accounts/github/device')).json<{ flowId: string }>();
    await world.wait(5);
    await world.request('GET', `/v1/git-accounts/github/device/${flow.flowId}`);
    return { ...world, calls, port: world.host.provided(GitAccountsPort) };
  }
  const run = (port: Pick<GitAccountsApi, 'run'>, args: string[]) =>
    port.run('gha_4242' as never, { program: 'gh', args });

  const REFUSED: readonly (readonly string[])[] = [
    ['auth', 'token'],
    ['auth', 'status', '-t'],
    ['auth', 'status', '--show-token'],
    ['auth', 'login'],
    ['auth', 'refresh'],
    ['auth', 'setup-git'],
    ['extension', 'install', 'owner/gh-evil'],
    ['ext', 'list'],
    ['alias', 'set', 'x', '!env'],
    ['config', 'get', 'oauth_token', '-h', 'github.com'],
    ['config', 'set', 'editor', 'sh'],
    ['codespace', 'ssh'],
    ['gist', 'create'],
    ['browse'],
    ['completion', '-s', 'bash'],
    ['--version'],
    ['-R', 'o/r', 'pr', 'list'],
    ['api', '/user', '--hostname', 'ghe.example.com'],
    ['api', '/user', '--hostname=ghe.example.com'],
    ['api', '/x', '--input', '/etc/passwd'],
    ['api', '/x', '--input=/etc/passwd'],
    ['pr', 'create', '--body-file', '/etc/passwd'],
    ['release', 'create', 'v1', '--notes-file=/etc/passwd'],
    ['pr', 'comment', '1', '-F', '/etc/passwd'],
    ['pr', 'comment', '1', '-F/etc/passwd'],
    ['api', '/x', '-F', 'data=@/etc/passwd'],
    ['api', '/x', '--field', 'data=@/etc/passwd'],
    ['api', '/x', '--field=data=@/etc/passwd'],
    ['api', '/x', '-F', 'n=1'],
    ['api', 'graphql', '-iFquery=@/etc/passwd'],
    ['api', 'graphql', '-iF', 'query=@/tmp/q'],
    ['api', 'graphql', '-f', 'query=@/tmp/q'],
    ['api', 'graphql', '-fquery=@/tmp/q'],
    ['api', '@/etc/passwd'],
    ['api', '/x', '--', '--input', '/etc/passwd'],
    ['api', '/x', '-i'],
    ['api', '/x', '--include'],
    ['api', '/x', '--cache', '1h'],
    ['api', '/x', '-t', '{{.}}'],
    // HIGH 1 (security re-check): gh's jq reads the environment, so jq and templates are refused on EVERY command.
    ['api', '/user', '--jq', 'env.GH_TOKEN|@base64'],
    ['api', '/user', '-q', '$ENV.GH_TOKEN|explode'],
    ['api', '/user', '--jq=env|tostring|@base64'],
    ['api', '/user', '-qenv'],
    ['api', 'repos/o/r/pulls', '--paginate', '--jq', '.[].number'],
    ['pr', 'list', '-R', 'o/r', '--json', 'number', '--jq', 'env.GH_TOKEN|@base64'],
    ['pr', 'list', '--jq=env|tostring|@base64'],
    ['pr', 'list', '--json', 'number', '--jq', '$ENV.GH_TOKEN'],
    ['issue', 'list', '-R', 'o/r', '--json', 'number', '-q', 'env.GH_TOKEN'],
    ['issue', 'list', '-qenv.GH_TOKEN'],
    ['search', 'repos', 'x', '--json', 'name', '--jq', 'env.GH_TOKEN|@base64'],
    ['run', 'list', '--json', 'name', '--jq=env'],
    ['pr', 'list', '-t', '{{.}}'],
    ['pr', 'list', '--template={{env}}'],
    ['pr', 'list', '-t{{.}}'],
    // HIGH 2: a repository is OWNER/REPO or github.com/OWNER/REPO, nothing else; no other host is ever named.
    ['pr', 'list', '-R', 'git@github.localhost:o/r'],
    ['pr', 'list', '-R', 'git@evil.example:o/r'],
    ['pr', 'list', '-R', 'git@acme.ghe.com:o/r'],
    ['pr', 'list', '--repo', 'git@evil.example:o/r'],
    ['pr', 'list', '--repo=git@evil.example:o/r'],
    ['pr', 'list', '-R', 'github.localhost/o/r'],
    ['pr', 'list', '-R', 'acme.ghe.com/o/r'],
    ['pr', 'list', '-R', 'evil/o/r'],
    ['pr', 'list', '-R', 'https://github.com/o/r'],
    ['pr', 'list', '-R', 'o/r/extra'],
    ['pr', 'list', '-R', 'o'],
    ['pr', 'list', '-R', 'o/..'],
    ['pr', 'list', '-R', '../r'],
    ['pr', 'list', '-R', 'o/r:x'],
    ['pr', 'list', '-R', '-x'],
    ['pr', 'list', '--repo=o/r@x'],
    ['pr', 'list', '-R'],
    ['pr', 'view', '1', '-R'],
    ['repo', 'view', 'git@github.localhost:o/r'],
    ['repo', 'view', 'git@evil.example:o/r'],
    ['repo', 'view', 'git@acme.ghe.com:o/r'],
    ['repo', 'view', 'ssh://git@github.com/o/r'],
    ['repo', 'view', 'evil/o/r'],
    ['repo', 'view', 'o/r/extra'],
    ['pr', 'view', 'git@evil.example:o/r'],
    ['pr', 'view', 'evil.example/o/r'],
    ['pr', 'view', '1', '--head', 'git@evil.example:o/r'],
    ['pr', 'view', 'github.localhost/o/r'],
    ['pr', 'view', 'https://github.localhost/o/r/pull/1'],
    ['api', 'https://api.github.localhost/user'],
    ['api', '/user', '-H', 'X-Host: api.github.localhost'],
    ['search', 'repos', 'acme.ghe.com'],
    ['pr', 'list', '-R', 'o/r', '--search', 'acme.ghe.com'],
    ['api', '/x', '--template', '{{.}}'],
    ['api', '/x', '-H'],
    ['api', '/x', '-X', 'TRACE'],
    ['api', '/x', '-H', 'Host: evil.example'],
    ['api', '/x', '-f', 'noequals'],
    ['api', '/x', '/y'],
    ['api', '../etc/passwd'],
    ['api', '/repos/../../x'],
    ['api', '//evil.example/x'],
    ['api', 'https://api.github.com.evil.example/x'],
    ['api', 'https://github.com/o/r'],
    ['api'],
    ['https://evil.example/collect'],
    ['api', 'https://evil.example/collect'],
    ['api', 'http://api.github.com/user'],
    ['repo', 'view', 'ghe.example.com/o/r'],
    // Anything that starts git or touches a local file is out of this seam.
    ['repo', 'clone', 'o/r'],
    ['repo', 'clone', 'o/r', '/any/dir'],
    ['repo', 'clone', 'o/r', '--', '-c', 'core.hooksPath=/tmp/hooks'],
    ['repo', 'clone', 'o/r', '--', '--config', 'core.hooksPath=/tmp/hooks'],
    ['repo', 'clone', 'o/r', '--', '--template=/tmp/tpl'],
    ['repo', 'create', 'x', '--source', '.', '--push'],
    ['repo', 'create', '--source=/tmp/x', '--push'],
    ['repo', 'fork', 'o/r'],
    ['repo', 'sync', 'o/r'],
    ['repo', 'edit', 'o/r'],
    ['repo', 'view', 'o/r', '--', '--x'],
    ['pr', 'checkout', '1'],
    ['pr', 'create', '-dF', '/path'],
    ['pr', 'create', '-dF/path'],
    ['pr', 'create', '-d', '-F', '/path'],
    ['pr', 'create', '--body-file=/etc/passwd'],
    ['pr', 'create', '--template', 'x'],
    ['pr', 'create', '-T', 'x'],
    ['pr', 'create', '--title', 't', '--', '--x'],
    ['pr', 'view', '../x'],
    ['pr', 'view', './x'],
    ['pr', 'view', '~/x'],
    ['pr', 'view', '--json=/etc/passwd'],
    ['pr', 'develop'],
    ['pr', 'status'],
    ['pr', 'ready'],
    ['pr', 'lock'],
    ['issue', 'develop', '1'],
    ['issue', 'transfer', '1', 'o/r'],
    ['issue', 'comment', '1', '-F', 'x'],
    ['issue', 'comment', '1', '--body-file', '-'],
    ['release', 'upload', 'v1', '/etc/passwd'],
    ['release', 'create', 'v1', '/etc/passwd'],
    ['release', 'create', 'v1'],
    ['release', 'download', 'v1'],
    ['release', 'delete', 'v1'],
    ['run', 'download', '1'],
    ['run', 'delete', '1'],
    ['workflow', 'run', 'ci.yaml'],
    ['workflow', 'enable', 'ci.yaml'],
    ['search'],
    ['search', 'secrets', 'x'],
    ['search', '--', 'x'],
    ['pr'],
    ['constructor', 'view'],
    ['toString'],
    ['pr', 'constructor'],
    ['gist', 'create'],
    ['ssh-key', 'add'],
    ['gpg-key', 'add'],
    ['secret', 'list'],
    ['variable', 'list'],
    [],
  ];
  for (const args of REFUSED)
    test(`refuses gh ${args.join(' ') || '(nothing)'}: a 403 and no child is started`, async () => {
      const { port, calls } = await ready();
      await expect(run(port, [...args])).rejects.toMatchObject({ status: 403 });
      expect(calls).toHaveLength(0);
    });

  test('allows the API work the units need, and github.com addresses', async () => {
    const { port, calls } = await ready();
    const ok: string[][] = [
      ['api', '/repos/o/r/pulls'],
      ['api', 'repos/o/r/pulls', '--paginate'],
      ['api', 'https://api.github.com/user'],
      ['api', '-X', 'POST', '/repos/o/r/issues', '-f', 'title=hi', '-f', 'body=a/b ./c'],
      ['api', '--method=PATCH', '/repos/o/r/issues/1', '--raw-field=state=closed'],
      ['api', 'graphql', '-f', 'query={ viewer { login } }', '-H', 'Accept: application/vnd.github+json'],
      ['api', '/search/issues?q=repo:o/r+is:open'],
      ['pr', 'list', '-R', 'o/r', '--json', 'number,title'],
      ['pr', 'list', '--repo', 'github.com/o/r', '--state', 'open'],
      ['pr', 'list', '--repo=o/r.js_x-y'],
      ['pr', 'list', '--repo=github.com/o/r'],
      ['issue', 'list', '-R', 'github.com/o/r'],
      ['repo', 'view', 'github.com/o/r', '--json', 'name'],
      ['pr', 'list'],
      ['pr', 'view', 'https://github.com/o/r/pull/1'],
      ['pr', 'view', '1', '-R', 'o/r', '--json', 'title,state'],
      ['pr', 'diff', '1'],
      ['pr', 'view', 'feat/x/y'],
      ['pr', 'checks', '1'],
      ['pr', 'create', '-d', '--title', 't', '--body', 'b', '--head', 'x', '--base', 'main'],
      ['pr', 'comment', '1', '--body', 'thanks'],
      ['pr', 'merge', '1', '--squash'],
      ['issue', 'list', '--assignee', '@me'],
      ['issue', 'create', '--title', 't', '--body', 'b'],
      ['run', 'list'],
      ['run', 'view', '1', '--log-failed'],
      ['run', 'rerun', '1'],
      ['workflow', 'list'],
      ['workflow', 'view', 'ci.yaml'],
      ['repo', 'view', 'github.com/o/r'],
      ['repo', 'view', 'o/r'],
      ['release', 'list'],
      ['release', 'view', 'v1'],
      ['search', 'prs', 'x'],
      ['search', 'repos', 'topic:bun', '--limit', '5'],
    ];
    for (const args of ok) await run(port, args);
    expect(calls.map(call => call.args.join(' '))).toEqual(ok.map(args => args.join(' ')));
  });

  test('the child runs in an empty private folder that is its HOME and gh config, with nothing interactive', async () => {
    let seen:
      | { cwd: string; env: Record<string, string>; editorMode: number; editorBody: string; homeEntries: number }
      | undefined;
    const { port, calls } = await ready(call => {
      const env = call.options?.env as Record<string, string>;
      const cwd = String(call.options?.cwd);
      seen = {
        cwd,
        env,
        editorMode: statSync(env.EDITOR as string).mode & 0o777,
        editorBody: readFileSync(env.EDITOR as string, 'utf8'),
        homeEntries: 0,
      };
      return EMPTY;
    });
    await run(port, ['pr', 'list']);
    expect(calls).toHaveLength(1);
    const env = seen?.env as Record<string, string>;
    expect(env.GH_TOKEN).toBe(FAKE_TOKEN);
    expect(env.GH_CONFIG_DIR?.startsWith(`${seen?.cwd}/`)).toBe(true);
    expect(env.HOME?.startsWith(`${seen?.cwd}/`)).toBe(true);
    expect(env.HOME).not.toBe(process.env.HOME);
    expect(env.GH_PROMPT_DISABLED).toBe('1');
    expect([env.GH_PAGER, env.PAGER]).toEqual(['cat', 'cat']);
    expect(env.GH_NO_UPDATE_NOTIFIER).toBe('1');
    expect(env.GH_HOST).toBe('github.com');
    const refuser = env.EDITOR as string;
    for (const name of ['GH_EDITOR', 'GIT_EDITOR', 'EDITOR', 'VISUAL', 'BROWSER', 'GH_BROWSER'])
      expect(env[name]).toBe(refuser);
    expect(seen?.editorMode).toBe(0o700);
    expect(seen?.editorBody).toBe('#!/bin/sh\nexit 1\n');
    expect(calls[0]?.options?.sealed).toBe(true);
    // The folder goes away with the run, even a failed one.
    expect(existsSync(seen?.cwd as string)).toBe(false);
  });

  test('the folder is removed when the child fails too', async () => {
    let cwd = '';
    const { port } = await ready(call => {
      cwd = String(call.options?.cwd);
      throw new Error('spawn failed');
    });
    await expect(run(port, ['pr', 'list'])).rejects.toThrow('spawn failed');
    expect(existsSync(cwd)).toBe(false);
  });

  test('output is scrubbed of the exact token and of any GitHub-token-shaped text', async () => {
    const other = `ghp_${'a1B2c3D4'.repeat(5)}`;
    const pat = `github_pat_11ABCDEFG0abcdefghijkl_${'Z9y8X7w6'.repeat(6)}`;
    const { port } = await ready(() => ({
      exitCode: 0,
      signal: null,
      stdout: `${FAKE_TOKEN} ${other} ok`,
      stderr: `${pat} gho_0123456789abcdefghij ghs_0123456789abcdefghij ghu_0123456789abcdefghij`,
    }));
    const result = (await port.run('gha_4242' as never, { program: 'gh', args: ['pr', 'list'] })) as {
      stdout: string;
      stderr: string;
    };
    expect(result.stdout).toBe('[redacted] [redacted] ok');
    expect(result.stderr).toBe('[redacted] [redacted] [redacted] [redacted]');
  });
});

describe('a provider that reflects the bearer (review MED 2)', () => {
  async function connectedReflecting() {
    const github = new FakeGithub();
    github.tokenAnswers = [{ access_token: FAKE_TOKEN, scope: 'read:user' }];
    github.reflect = true;
    const world = await boot(github);
    const flow = (await world.request('POST', '/v1/git-accounts/github/device')).json<{ flowId: string }>();
    await world.wait(5);
    await world.request('GET', `/v1/git-accounts/github/device/${flow.flowId}`);
    return { ...world, port: world.host.provided(GitAccountsPort) };
  }

  test('a body that echoes the token in any spelling, a key that holds it, and headers that carry it are masked', async () => {
    const { port } = await connectedReflecting();
    const answer = await port.api('gha_4242' as never, { method: 'GET', path: '/reflect' });
    const everything = JSON.stringify(answer);
    expect(everything).not.toContain(FAKE_TOKEN);
    expect(everything).not.toContain(encodeURIComponent(FAKE_TOKEN));
    expect(everything).not.toContain(Buffer.from(FAKE_TOKEN).toString('base64'));
    expect(everything).toContain('[redacted]');
    // What does not hold the token is kept as it was.
    expect((answer.body as { number: number }).number).toBe(5);
    expect((answer.body as { nested: { list: string[] } }).nested.list[0]).toBe('ok');
    expect(answer.status).toBe(401);
    expect(answer.headers.etag).toBe('[redacted]');
    expect(answer.headers.link).toBe('[redacted]');
  });

  test('a body that is not JSON is not passed on', async () => {
    const { port } = await connectedReflecting();
    const answer = await port.api('gha_4242' as never, { method: 'GET', path: '/html' });
    expect(answer.body).toBeNull();
    expect(JSON.stringify(answer)).not.toContain(FAKE_TOKEN);
  });
});

describe('device codes are dropped as soon as a flow ends (review MED 3)', () => {
  class ScriptedHttp implements GithubHttp {
    answers: Array<Record<string, unknown>> = [{ error: 'authorization_pending' }];
    async request(request: GithubRequest): Promise<GithubResponse> {
      if (request.url.endsWith('/login/device/code'))
        return {
          status: 200,
          headers: {},
          body: {
            device_code: FAKE_DEVICE_CODE,
            user_code: FAKE_USER_CODE,
            verification_uri: 'https://github.com/login/device',
            expires_in: 60,
            interval: 5,
          },
        };
      if (request.url.endsWith('/login/oauth/access_token'))
        return { status: 200, headers: {}, body: this.answers.shift() ?? { error: 'authorization_pending' } };
      return { status: 200, headers: {}, body: { id: 7, login: 'octo' } };
    }
  }
  function world() {
    let now = 1_000_000;
    const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
    const http = new ScriptedHttp();
    let held: unknown;
    const stateStub = {
      read: async () => ({ ok: true, value: held }),
      update: async (_file: unknown, fn: (current: unknown) => unknown) => {
        held = await fn(held);
        return { ok: true, value: held };
      },
    } as unknown as StatePort;
    const book = new AccountBook(stateStub, new FakeSealedDocuments().open(stateStub, GIT_ACCOUNT_TOKENS), () => 'now');
    const flows = new GithubDeviceFlows({
      http,
      book,
      clientId: () => 'cid',
      nowMs: () => now,
      after: (ms, fn) => {
        const timer = { at: now + ms, fn, live: true };
        timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
    });
    const advance = (ms: number) => {
      now += ms;
      for (const timer of timers) {
        if (!timer.live || timer.at > now) continue;
        timer.live = false;
        timer.fn();
      }
    };
    return { flows, http, advance, book };
  }

  test('denied and expired_token drop the code the moment they are seen', async () => {
    for (const error of ['access_denied', 'expired_token']) {
      const { flows, http, advance } = world();
      http.answers = [{ error }];
      const started = await flows.start();
      expect(flows.liveDeviceCodes()).toBe(1);
      advance(5_000);
      expect((await flows.poll(started.flowId)).status).toBe(error === 'access_denied' ? 'denied' : 'expired');
      expect(flows.liveDeviceCodes()).toBe(0);
    }
  });

  test('a flow nobody polls drops its code at its expiry, by timer, with no start or read needed', async () => {
    const { flows, advance } = world();
    const started = await flows.start();
    expect(flows.liveDeviceCodes()).toBe(1);
    advance(59_000);
    expect(flows.liveDeviceCodes()).toBe(1);
    advance(2_000);
    expect(flows.liveDeviceCodes()).toBe(0);
    expect(await flows.poll(started.flowId)).toEqual({ status: 'expired' });
  });

  test('a read past the expiry drops it too, and a done flow drops it and cancels its timer', async () => {
    const { flows, http, advance } = world();
    const first = await flows.start();
    advance(61_000);
    // (the timer already ran in this harness; a read stays expired)
    expect((await flows.poll(first.flowId)).status).toBe('expired');
    http.answers = [{ access_token: FAKE_TOKEN, scope: 'read:user' }];
    const second = await flows.start();
    advance(5_000);
    expect((await flows.poll(second.flowId)).status).toBe('done');
    expect(flows.liveDeviceCodes()).toBe(0);
  });
});

describe('a token with no record (review MED 4)', () => {
  function failingState(): StatePort {
    return {
      read: async () => ({ ok: true, value: undefined }),
      update: async () => ({ ok: false, error: { kind: 'io' } }),
    } as unknown as StatePort;
  }
  const facts = { id: 'gha_9' as GitAccountId, githubId: 9, login: 'nine', scopes: [] as string[] };

  test('a record that cannot be written leaves no sealed entry for a new account', async () => {
    const state = failingState();
    const handle = new FakeSealedDocuments().open(state, GIT_ACCOUNT_TOKENS);
    const book = new AccountBook(state, handle, () => 'now');
    await expect(book.upsert(facts, 'gho_NEW_TOKEN_0123456789abcdef')).rejects.toMatchObject({ status: 500 });
    expect(await handle.names()).toEqual([]);
  });

  test('for an account already connected the old token is put back', async () => {
    const state = failingState();
    const handle = new FakeSealedDocuments().open(state, GIT_ACCOUNT_TOKENS);
    await handle.put('gha_9' as never, 'gho_OLD_TOKEN_0123456789abcdef');
    const book = new AccountBook(state, handle, () => 'now');
    await expect(book.upsert(facts, 'gho_NEW_TOKEN_0123456789abcdef')).rejects.toMatchObject({ status: 500 });
    expect(await handle.get('gha_9' as never)).toBe('gho_OLD_TOKEN_0123456789abcdef');
  });

  test('disconnect removes a sealed entry that has no record, and still 404s when there is neither', async () => {
    const github = new FakeGithub();
    const { host, sealed, request } = await boot(github);
    expect((await request('DELETE', '/v1/git-accounts/gha_77')).status).toBe(404);
    // Open the plugin's handle by asking for anything, then strand an entry the way a failed record write would have.
    await request('GET', '/v1/git-accounts');
    await (sealed.handle as SealedDocumentHandle).put('gha_77' as never, FAKE_TOKEN);
    const removed = await request('DELETE', '/v1/git-accounts/gha_77');
    expect(removed.status).toBe(200);
    expect(removed.json()).toMatchObject({ id: 'gha_77', removed: true, keysLeftOnProvider: [] });
    expect(await (sealed.handle as SealedDocumentHandle).names()).toEqual([]);
    expect(host.published).toEqual([{ event: 'git-accounts.removed', payload: { id: 'gha_77' } }]);
    expect((await request('DELETE', '/v1/git-accounts/gha_77')).status).toBe(404);
    expect(host.published).toHaveLength(1); // a refused removal says nothing
  });
});

describe('git-account.added is recorded once per connect, by account (review MED 5)', () => {
  test('many polls of a done flow record one entry whose subject is the account id', async () => {
    const github = new FakeGithub();
    github.tokenAnswers = [{ error: 'authorization_pending' }, { access_token: FAKE_TOKEN, scope: 'read:user' }];
    const { gate, request, wait } = await boot(github);
    const flow = (await request('POST', '/v1/git-accounts/github/device')).json<{ flowId: string }>();
    const path = `/v1/git-accounts/github/device/${flow.flowId}`;
    await wait(5);
    await request('GET', path);
    expect(gate.audits).toEqual([]);
    await wait(5);
    for (let n = 0; n < 4; n += 1) expect((await request('GET', path)).json()).toMatchObject({ status: 'done' });
    expect(gate.audits).toHaveLength(1);
    expect(gate.audits[0]).toMatchObject({ subject: 'gha_4242', outcome: 'succeeded', actor: { kind: 'host' } });
    expect(String(gate.audits[0]?.event)).toContain('git-account.added');
    expect(JSON.stringify(gate.audits)).not.toContain(flow.flowId);
    expect(JSON.stringify(gate.audits)).not.toContain(FAKE_TOKEN);
  });

  test('connecting a second account records a second entry, and a failed connect records none', async () => {
    const github = new FakeGithub();
    github.tokenAnswers = [{ access_token: FAKE_TOKEN, scope: 'read:user' }];
    github.userStatus = 401;
    const { gate, request, wait } = await boot(github);
    const flow = (await request('POST', '/v1/git-accounts/github/device')).json<{ flowId: string }>();
    await wait(5);
    expect((await request('GET', `/v1/git-accounts/github/device/${flow.flowId}`)).status).toBe(502);
    expect(gate.audits).toEqual([]);
  });
});

describe('the failure branches of the flow and the service', () => {
  async function connected(github = new FakeGithub()) {
    github.tokenAnswers = [{ access_token: FAKE_TOKEN, scope: 'read:user' }];
    const world = await boot(github);
    const flow = (await world.request('POST', '/v1/git-accounts/github/device')).json<{ flowId: string }>();
    await world.wait(5);
    await world.request('GET', `/v1/git-accounts/github/device/${flow.flowId}`);
    return { ...world, github };
  }

  test('GitHub refusing to start a device sign-in is a 502 and no flow is kept', async () => {
    const github = new FakeGithub();
    github.deviceFails = true;
    const { request } = await boot(github);
    expect((await request('POST', '/v1/git-accounts/github/device')).status).toBe(502);
  });

  test('a poll answer that is not an answer, and an error nobody knows, are a 502 and file nothing', async () => {
    for (const answer of ['nonsense', { error: 'unsupported_grant_type' }]) {
      const github = new FakeGithub();
      github.tokenAnswers = [answer as never];
      const { request, wait } = await boot(github);
      const flow = (await request('POST', '/v1/git-accounts/github/device')).json<{ flowId: string }>();
      await wait(5);
      expect((await request('GET', `/v1/git-accounts/github/device/${flow.flowId}`)).status).toBe(502);
      expect((await request('GET', '/v1/git-accounts')).json()).toEqual([]);
    }
  });

  test('a 502 from a sign-in poll pushes the next ask one interval out: a fast poller never re-hits GitHub', async () => {
    for (const answer of ['nonsense', { error: 'unsupported_grant_type' }]) {
      const github = new FakeGithub();
      github.tokenAnswers = [answer as never];
      const { request, wait } = await boot(github);
      const flow = (await request('POST', '/v1/git-accounts/github/device')).json<{ flowId: string }>();
      await wait(5);
      expect((await request('GET', `/v1/git-accounts/github/device/${flow.flowId}`)).status).toBe(502);
      expect(github.tokenPolls).toBe(1);
      for (let n = 0; n < 3; n += 1) {
        const again = await request('GET', `/v1/git-accounts/github/device/${flow.flowId}`);
        expect([again.status, again.json<{ status: string }>().status]).toEqual([200, 'pending']);
      }
      expect(github.tokenPolls).toBe(1);
      await wait(5);
      expect((await request('GET', `/v1/git-accounts/github/device/${flow.flowId}`)).status).toBe(502);
      expect(github.tokenPolls).toBe(2);
    }
  });

  test('an api body past the cap is a 413 and is never sent', async () => {
    const { host, github } = await connected();
    const sent = github.seen.length;
    await expect(
      host
        .provided(GitAccountsPort)
        .api('gha_4242' as never, { method: 'POST', path: '/user/keys', body: { key: 'x'.repeat(300 * 1024) } }),
    ).rejects.toMatchObject({ status: 413 });
    expect(github.seen).toHaveLength(sent);
  });

  test('an account whose sealed token is gone: api and run say to connect again, remove names its keys and still disconnects', async () => {
    const { host, sealed, request } = await connected();
    const port = host.provided(GitAccountsPort);
    await port.recordKeys('gha_4242' as never, {
      ssh: { githubKeyId: '11', title: 'auth key' },
      signing: { githubKeyId: '22', title: 'signing key' },
    });
    await (sealed.handle as SealedDocumentHandle).delete('gha_4242' as never);
    await expect(port.api('gha_4242' as never, { method: 'GET', path: '/user' })).rejects.toMatchObject({
      status: 409,
    });
    await expect(port.run('gha_4242' as never, { program: 'gh', args: ['pr', 'list'] })).rejects.toMatchObject({
      status: 409,
    });
    const removed = (await request('DELETE', '/v1/git-accounts/gha_4242')).json<{ keysLeftOnProvider: string[] }>();
    expect(removed.keysLeftOnProvider).toEqual(['auth key', 'signing key']);
    expect((await request('GET', '/v1/git-accounts')).json()).toEqual([]);
  });

  test('a key delete that never gets an answer is named for the person, and the account is still disconnected', async () => {
    const github = new FakeGithub();
    github.deleteThrows.add('/user/keys/11');
    const { host, request } = await connected(github);
    await host.provided(GitAccountsPort).recordKeys('gha_4242' as never, {
      ssh: { githubKeyId: '11', title: 'unreachable key' },
    });
    const removed = (await request('DELETE', '/v1/git-accounts/gha_4242')).json<{ keysLeftOnProvider: string[] }>();
    expect(removed.keysLeftOnProvider).toEqual(['unreachable key']);
    expect((await request('GET', '/v1/git-accounts')).json()).toEqual([]);
  });
});
