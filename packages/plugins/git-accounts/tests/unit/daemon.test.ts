import { describe, expect, test } from 'bun:test';
import { deviceStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { CallStanding } from '@ferretry/kernel/contract';
import type { SealedDocumentDef, SealedDocumentHandle } from '@ferretry/core-vault/contract';
import { FakeSealedDocuments } from '@ferretry/core-vault/contract/testing';
import type { SpawnOptions, SpawnResult, StatePort } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import { GitAccountsPort, GitDeviceFlowStatusSchema } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import { FAKE_DEVICE_CODE, FAKE_TOKEN, FAKE_USER_CODE, FakeGithub } from './fake-github.ts';

const CLIENT = 'Ov23FAKECLIENTID';

/** The fake sealed port, remembering the one handle this plugin opened so a test can look inside its own document. */
class SpySealed extends FakeSealedDocuments {
  handle: SealedDocumentHandle | undefined;
  override open(own: StatePort, document: SealedDocumentDef): SealedDocumentHandle {
    this.handle = super.open(own, document);
    return this.handle;
  }
}

type SpawnCall = { program: string; args: readonly string[]; options?: SpawnOptions };

async function boot(
  github: FakeGithub,
  options: { clientId?: string; standing?: () => CallStanding; spawn?: (call: SpawnCall) => SpawnResult } = {},
) {
  const sealed = new SpySealed();
  const host = await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => (options.standing ?? (() => ownerStanding()))()),
    fakes: { sealed },
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
  return { host, sealed, request, responses, wait };
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
    expect(Object.keys(port).sort()).toEqual(['api', 'list', 'recordKeys', 'run']);
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
    const result = await port.run('gha_4242' as never, { program: 'gh', args: ['auth', 'status'], timeoutMs: 5_000 });
    expect(result).toEqual({ exitCode: 0, stdout: 'as [redacted]', stderr: 'bad [redacted] and [redacted]' });
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.program).toBe('gh');
    expect(calls[0]?.args).toEqual(['auth', 'status']);
    expect(calls[0]?.args.join(' ')).not.toContain(FAKE_TOKEN);
    expect(calls[0]?.options?.env).toEqual({ GH_TOKEN: FAKE_TOKEN });
    expect(calls[0]?.options?.sealed).toBe(true);
    // Only gh, only a connected account.
    await expect(port.run('gha_4242' as never, { program: 'sh' as never, args: ['-c', 'env'] })).rejects.toMatchObject({
      status: 403,
    });
    await expect(port.run('gha_9' as never, { program: 'gh', args: [] })).rejects.toMatchObject({ status: 404 });
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
