import { afterAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, execFileSync, spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { SealedDocumentDef, SealedDocumentHandle } from '@ferretry/core-vault/contract';
import { FakeSealedDocuments } from '@ferretry/core-vault/contract/testing';
import type { ChildHandle, SpawnOptions, SpawnResult, StatePort } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import {
  GIT_ACCOUNT_KEYS,
  GITHUB_HOST_KEY_FINGERPRINTS,
  GITHUB_HOST_KEYS,
  GitAccountsPort,
  GitKeyResultSchema,
  NO_SECRET_FIELDS,
  GitKeyRequestSchema,
} from '../../contract/index.ts';
import { gitAccountsDaemon } from '../../daemon/index.ts';
import type { LaunchPart } from '@ferretry/core-ferrets/contract';
import { fingerprintOfBlob, generateEd25519, parsePublicKey } from '../../daemon/features/ssh-keys/openssh.ts';
import { FAKE_TOKEN, FakeGithub } from './fake-github.ts';
import { tmpRunFolder } from './run-folder.ts';

const folders: Array<ReturnType<typeof tmpRunFolder>> = [];
afterAll(() => {
  for (const folder of folders) folder.destroy();
});

const CLIENT = 'Ov23FAKECLIENTID';
const ACCOUNT = 'gha_4242';
const HAVE_TOOLS = ['ssh-agent', 'ssh-add', 'ssh-keygen'].every(
  tool => spawnSync('which', [tool], { stdio: 'ignore' }).status === 0,
);

class SpySealed extends FakeSealedDocuments {
  tokens: SealedDocumentHandle | undefined;
  keys: SealedDocumentHandle | undefined;
  override open(own: StatePort, document: SealedDocumentDef): SealedDocumentHandle {
    const opened = super.open(own, document);
    if (document === GIT_ACCOUNT_KEYS) this.keys = opened;
    else this.tokens = opened;
    return opened;
  }
}

/** GitHub's key endpoints, over the scripted device-flow fake: what `POST /user/keys` and `/user/ssh_signing_keys` do. */
class KeyGithub extends FakeGithub {
  readonly registered = {
    keys: [] as Array<{ id: number; title: string; key: string }>,
    signing: [] as Array<{ id: number; title: string; key: string }>,
  };
  /** A status to answer instead of 201 on a registration, by path. */
  refuse = new Map<string, number>();
  #next = 100;
  /** Raw commit objects by sha, and the verified addresses of the account (GitHub counts the noreply form as verified). */
  readonly commits = new Map<string, string>();
  verifiedEmails: string[] = [];

  /**
   * `commit.verification` as GitHub documents it for an SSH signature: the commit carries a signature, it verifies
   * against a SIGNING key registered on the account (an auth-only key does not count), and the committer address is one
   * of the account's verified addresses.
   */
  verification(raw: string): { verified: boolean; reason: string } {
    const lines = raw.split('\n');
    const start = lines.findIndex(line => line.startsWith('gpgsig '));
    if (start < 0) return { verified: false, reason: 'unsigned' };
    let end = start + 1;
    while ((lines[end] ?? '').startsWith(' ')) end += 1;
    const signature = [lines[start]?.slice(7) ?? '', ...lines.slice(start + 1, end).map(line => line.slice(1))].join(
      '\n',
    );
    const payload = [...lines.slice(0, start), ...lines.slice(end)].join('\n');
    const committer = /^committer .*<([^>]*)>/mu.exec(raw)?.[1] ?? '';
    const dir = mkdtempSync(`${tmpdir()}/b4-verify-`);
    try {
      writeFileSync(`${dir}/allowed`, this.registered.signing.map(key => `* namespaces="git" ${key.key}\n`).join(''));
      writeFileSync(`${dir}/sig`, `${signature}\n`);
      const checked = spawnSync(
        'ssh-keygen',
        ['-Y', 'verify', '-f', `${dir}/allowed`, '-I', 'any', '-n', 'git', '-s', `${dir}/sig`],
        {
          input: payload,
          encoding: 'utf8',
        },
      );
      if (checked.status !== 0) return { verified: false, reason: 'unknown_key' };
      if (!this.verifiedEmails.includes(committer)) return { verified: false, reason: 'bad_email' };
      return { verified: true, reason: 'valid' };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  readonly keyFetch = async (url: URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    const commit = /^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{40})$/u.exec(path);
    if (url.host === 'api.github.com' && method === 'GET' && commit !== null) {
      const raw = this.commits.get(commit[1] as string);
      return raw === undefined
        ? Response.json({ message: 'Not Found' }, { status: 404 })
        : Response.json({ sha: commit[1], commit: { verification: this.verification(raw) } });
    }
    const list =
      path === '/user/keys'
        ? this.registered.keys
        : path === '/user/ssh_signing_keys'
          ? this.registered.signing
          : undefined;
    if (url.host === 'api.github.com' && list !== undefined && method === 'POST') {
      this.seen.push({
        method,
        url: url.toString(),
        body: String(init?.body ?? ''),
        authorization: new Headers(init?.headers).get('authorization') ?? '',
      });
      const status = this.refuse.get(path);
      if (status !== undefined) return Response.json({ message: 'Validation Failed' }, { status });
      const body = JSON.parse(String(init?.body)) as { title: string; key: string };
      this.#next += 1;
      list.push({ id: this.#next, ...body });
      return Response.json({ id: this.#next, ...body }, { status: 201 });
    }
    if (url.host === 'api.github.com' && list !== undefined && method === 'GET') {
      this.seen.push({ method, url: url.toString(), body: '' });
      return Response.json(list);
    }
    if (url.host === 'api.github.com' && method === 'DELETE') {
      const gone = this.registered.keys.findIndex(k => path === `/user/keys/${k.id}`);
      if (gone >= 0) this.registered.keys.splice(gone, 1);
      const goneSigning = this.registered.signing.findIndex(k => path === `/user/ssh_signing_keys/${k.id}`);
      if (goneSigning >= 0) this.registered.signing.splice(goneSigning, 1);
    }
    return await this.fetch(url, init);
  };
}

type SpawnCall = { program: string; args: readonly string[]; options?: SpawnOptions };

/** Records every spawn and answers `ssh-add` as a running agent would (reachable, key accepted). */
function recorder() {
  const runs: SpawnCall[] = [];
  const starts: SpawnCall[] = [];
  const killed: string[] = [];
  const fakeStart = (program: string, args: readonly string[], options?: SpawnOptions): ChildHandle => {
    starts.push({ program, args, ...(options === undefined ? {} : { options }) });
    let end: (code: number | null) => void = () => undefined;
    const exited = new Promise<number | null>(resolve => {
      end = resolve;
    });
    const empty = () => new ReadableStream<Uint8Array>({ start: c => c.close() });
    return {
      pid: 4321,
      stdout: empty(),
      stderr: empty(),
      write: () => undefined,
      kill: signal => {
        killed.push(`${args.at(-1) ?? ''}:${signal ?? 'SIGTERM'}`);
        end(null);
      },
      exited,
      pipes: [],
      closePipes: () => undefined,
    };
  };
  const fakeRun = (program: string, args: readonly string[], options?: SpawnOptions): SpawnResult => {
    runs.push({ program, args, ...(options === undefined ? {} : { options }) });
    return { exitCode: program === 'ssh-add' && args[0] === '-l' ? 1 : 0, signal: null, stdout: '', stderr: '' };
  };
  return { runs, starts, killed, fakeStart, fakeRun };
}

type Source = { parts(spec: object): Promise<readonly LaunchPart[]> };
/** The daemon half's `launch.parts` contribution, kept as the host builds it (the test host offers no reader of it). */
function watched(impl: ReturnType<typeof gitAccountsDaemon>) {
  const held: { source?: Source } = {};
  const wrapped = {
    ...impl,
    build: (ctx: never) => {
      const half = (impl.build as (ctx: never) => unknown)(ctx) as {
        hooks: { 'launch.parts': () => readonly { item: Source }[] };
      };
      held.source = half.hooks['launch.parts']()[0]?.item;
      return half;
    },
  } as unknown as ReturnType<typeof gitAccountsDaemon>;
  return { wrapped, held };
}

async function boot(
  github: KeyGithub,
  tools: {
    spawn: (p: string, a: readonly string[], o?: SpawnOptions) => SpawnResult | Promise<SpawnResult>;
    start: (p: string, a: readonly string[], o?: SpawnOptions) => ChildHandle;
  },
  projects: readonly object[] = [],
) {
  const sealed = new SpySealed();
  const gate = new FakeGate();
  const runFolder = tmpRunFolder();
  folders.push(runFolder);
  const { wrapped, held } = watched(gitAccountsDaemon({ runFolder }));
  const host = await testHost({
    plugins: [wrapped],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { sealed, gate },
    uses: { projects: { list: async () => projects } },
    fetch: github.keyFetch,
    spawn: tools.spawn,
    start: tools.start,
    config: { 'git-accounts.yaml': { github: { clientId: CLIENT } } },
  });
  const responses: string[] = [];
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await host.request(method, path, body === undefined ? {} : { body });
    responses.push(response.body);
    return response;
  };
  github.tokenAnswers = [
    { access_token: FAKE_TOKEN, scope: 'read:user user:email write:public_key write:ssh_signing_key repo read:org' },
  ];
  const flow = (await request('POST', '/v1/git-accounts/github/device')).json<{ flowId: string }>();
  await host.clock.advance(5000);
  await request('GET', `/v1/git-accounts/github/device/${flow.flowId}`);
  responses.length = 0;
  return { host, sealed, gate, request, responses, runFolder, held };
}

const fake = () => {
  const rec = recorder();
  return { rec, tools: { spawn: rec.fakeRun, start: rec.fakeStart } };
};

/** Everything a client, a log or the audit trail could ever show, scanned for the private half of a key. */
async function expectNoPrivateKey(
  world: Awaited<ReturnType<typeof boot>>,
  extra: readonly string[] = [],
): Promise<void> {
  const sealedText = (await world.sealed.keys?.get(ACCOUNT as never)) ?? '';
  const stored = JSON.parse(sealedText || '{}') as { privateKey?: string };
  const body = (stored.privateKey ?? '').split('\n').filter(line => line.length > 20 && !line.startsWith('-----'));
  const everything = [
    ...world.responses,
    ...extra,
    ...world.host.logs.map(log => `${log.message} ${JSON.stringify(log.fields ?? {})}`),
    JSON.stringify(world.gate.audits ?? []),
  ].join('\n');
  expect(everything).not.toContain('PRIVATE KEY');
  expect(everything).not.toContain(FAKE_TOKEN);
  for (const line of body) expect(everything).not.toContain(line);
}

describe('the key itself', () => {
  test('a generated key is a real OpenSSH ed25519 key: ssh-keygen reads the private half back to the same public half and fingerprint', () => {
    const made = generateEd25519('Ferretry test');
    expect(made.privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n')).toBe(true);
    expect(made.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+ Ferretry test$/u);
    const parsed = parsePublicKey(made.publicKey);
    expect(parsed?.fingerprint).toBe(made.fingerprint);
    expect(made.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/u);
    // Two keys are never the same.
    expect(generateEd25519('x').fingerprint).not.toBe(made.fingerprint);
    if (!HAVE_TOOLS) return;
    const dir = mkdtempSync(`${tmpdir()}/b3-key-`);
    try {
      const file = `${dir}/id`;
      writeFileSync(file, made.privateKey, { mode: 0o600 });
      const derived = execFileSync('ssh-keygen', ['-y', '-f', file], { encoding: 'utf8' }).trim();
      expect(derived).toBe(made.publicKey);
      const listed = execFileSync('ssh-keygen', ['-l', '-f', file], { encoding: 'utf8' });
      expect(listed).toContain(made.fingerprint);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a public key line is parsed only when its body names its own type', () => {
    const made = generateEd25519('c');
    expect(parsePublicKey(made.publicKey)?.bare).toBe(made.publicKey.split(' ').slice(0, 2).join(' '));
    expect(parsePublicKey(`ssh-rsa ${made.publicKey.split(' ')[1]}`)).toBeUndefined();
    expect(parsePublicKey('ssh-ed25519 not base64 !!')).toBeUndefined();
    expect(parsePublicKey('')).toBeUndefined();
    expect(GitKeyRequestSchema.safeParse({ purpose: 'both', publicKey: made.publicKey }).success).toBe(true);
    expect(
      GitKeyRequestSchema.safeParse({ purpose: 'both', publicKey: '-----BEGIN OPENSSH PRIVATE KEY-----' }).success,
    ).toBe(false);
    expect(GitKeyRequestSchema.safeParse({ purpose: 'sudo' }).success).toBe(false);
    expect(GitKeyRequestSchema.safeParse({ purpose: 'auth', privateKey: 'x' }).success).toBe(false);
  });

  test('the pinned GitHub host keys match the fingerprints GitHub publishes', () => {
    const fingerprints = GITHUB_HOST_KEYS.map(line =>
      fingerprintOfBlob(Buffer.from(line.split(' ')[1] as string, 'base64')),
    );
    expect(fingerprints).toEqual([...GITHUB_HOST_KEY_FINGERPRINTS]);
  });

  test('no wire shape of a key names a secret field', () => {
    const shape = Object.keys(GitKeyResultSchema.shape);
    expect(shape.filter(name => NO_SECRET_FIELDS.test(name))).toEqual([]);
  });
});

describe('registering a key', () => {
  test('both: one key, registered twice by its PUBLIC half, titled with the machine; the private half stays sealed and is in no answer', async () => {
    const github = new KeyGithub();
    const { rec, tools } = fake();
    const world = await boot(github, tools);
    const created = await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'both' });
    expect(created.status).toBe(200);
    const result = GitKeyResultSchema.parse(created.json());
    expect(result.registered).toEqual(['auth', 'signing']);
    expect(result.source).toBe('generated');
    expect(github.registered.keys).toHaveLength(1);
    expect(github.registered.signing).toHaveLength(1);
    const [auth, signing] = [github.registered.keys[0], github.registered.signing[0]];
    expect(auth?.title).toBe('Ferretry test-daemon');
    expect(signing?.title).toBe('Ferretry test-daemon');
    // What GitHub got: `type body`, no comment, nothing private.
    expect(auth?.key).toBe(result.publicKey.split(' ').slice(0, 2).join(' '));
    expect(signing?.key).toBe(auth?.key as string);
    expect(parsePublicKey(result.publicKey)?.fingerprint).toBe(result.fingerprint);
    for (const call of github.seen.filter(c => c.method === 'POST' && c.url.includes('/user/')))
      expect(call.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(github.seen.some(call => call.body.includes('PRIVATE'))).toBe(false);

    // The list shows public facts; the sealed entry holds the private half.
    const list = (await world.request('GET', '/v1/git-accounts')).json<
      Array<{ keys: { ssh?: { githubKeyId: string; fingerprint: string }; signing?: { githubKeyId: string } } }>
    >();
    expect(list[0]?.keys.ssh).toMatchObject({ githubKeyId: String(auth?.id), fingerprint: result.fingerprint });
    expect(list[0]?.keys.signing).toMatchObject({ githubKeyId: String(signing?.id) });
    const sealed = JSON.parse((await world.sealed.keys?.get(ACCOUNT as never)) as string) as { privateKey: string };
    expect(sealed.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(JSON.stringify(list)).not.toContain('PRIVATE');
    // No agent is started just to register: that is lazy, on a launch.
    expect(rec.starts).toEqual([]);
    await expectNoPrivateKey(world);
  });

  test('auth first, signing later: the SAME key is registered the second time, and asking again changes nothing', async () => {
    const github = new KeyGithub();
    const world = await boot(github, fake().tools);
    const first = GitKeyResultSchema.parse(
      (await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'auth' })).json(),
    );
    expect(first.registered).toEqual(['auth']);
    expect(github.registered.signing).toHaveLength(0);
    const second = GitKeyResultSchema.parse(
      (await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'signing' })).json(),
    );
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.registered).toEqual(['auth', 'signing']);
    const again = GitKeyResultSchema.parse(
      (await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'both' })).json(),
    );
    expect(again.fingerprint).toBe(first.fingerprint);
    expect(github.registered.keys).toHaveLength(1);
    expect(github.registered.signing).toHaveLength(1);
  });

  test('GitHub refusing the key (422) is a 409 and leaves no sealed key behind; a 500 is a 502 the same way', async () => {
    const github = new KeyGithub();
    const world = await boot(github, fake().tools);
    github.refuse.set('/user/keys', 422);
    const refused = await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'auth' });
    expect(refused.status).toBe(409);
    expect(await world.sealed.keys?.names()).toEqual([]);
    github.refuse.set('/user/keys', 500);
    expect((await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'auth' })).status).toBe(502);
    expect(await world.sealed.keys?.names()).toEqual([]);
    expect((await world.request('GET', '/v1/git-accounts')).json<Array<{ keys: object }>>()[0]?.keys).toEqual({});
    await expectNoPrivateKey(world);
  });

  test('when signing is refused after auth landed, the key stays (auth uses it) and signing can be asked again', async () => {
    const github = new KeyGithub();
    const world = await boot(github, fake().tools);
    github.refuse.set('/user/ssh_signing_keys', 422);
    expect((await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'both' })).status).toBe(409);
    expect(await world.sealed.keys?.names()).toEqual([ACCOUNT]);
    github.refuse.delete('/user/ssh_signing_keys');
    const done = GitKeyResultSchema.parse(
      (await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'both' })).json(),
    );
    expect(done.registered).toEqual(['auth', 'signing']);
  });

  test('an unknown account is a 404; a malformed or oversized body is a 400 that quotes nothing', async () => {
    const world = await boot(new KeyGithub(), fake().tools);
    expect((await world.request('POST', '/v1/git-accounts/gha_9/keys', { purpose: 'auth' })).status).toBe(404);
    const bad = await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, {
      purpose: 'auth',
      publicKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETBODY',
    });
    expect(bad.status).toBe(400);
    expect(bad.body).not.toContain('SECRETBODY');
    expect((await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'root' })).status).toBe(400);
    expect((await world.request('POST', '/v1/git-accounts/..%2f/keys', { purpose: 'auth' })).status).toBe(404);
  });
});

describe('a key the person already has', () => {
  test('is recorded after GitHub lists it, never deleted by us, and uses no agent of ours', async () => {
    const github = new KeyGithub();
    const { rec, tools } = fake();
    const world = await boot(github, tools);
    const own = generateEd25519('mine@laptop');
    github.registered.keys.push({ id: 7, title: 'My laptop', key: own.publicKey.split(' ').slice(0, 2).join(' ') });
    const answer = GitKeyResultSchema.parse(
      (
        await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'auth', publicKey: own.publicKey })
      ).json(),
    );
    expect(answer).toMatchObject({ source: 'own', fingerprint: own.fingerprint, registered: ['auth'] });
    expect(github.registered.keys).toHaveLength(1);
    expect(await world.sealed.keys?.names()).toEqual([]);
    const port = world.host.provided(GitAccountsPort);
    expect(await port.agentSocket(ACCOUNT as never)).toBeUndefined();
    expect(rec.starts).toEqual([]);
    // Removing the key forgets it here and leaves it on GitHub.
    const removed = await world.request('DELETE', `/v1/git-accounts/${ACCOUNT}/keys/auth`);
    expect(removed.json()).toEqual({ id: ACCOUNT, purpose: 'auth', removed: true });
    expect(github.registered.keys).toHaveLength(1);
    expect(github.seen.filter(call => call.method === 'DELETE')).toEqual([]);
  });

  test('a key GitHub does not list for that purpose is refused, and the account is unchanged', async () => {
    const github = new KeyGithub();
    const world = await boot(github, fake().tools);
    const own = generateEd25519('x');
    github.registered.keys.push({ id: 7, title: 'only auth', key: own.publicKey.split(' ').slice(0, 2).join(' ') });
    const both = await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, {
      purpose: 'both',
      publicKey: own.publicKey,
    });
    expect(both.status).toBe(422);
    expect((await world.request('GET', '/v1/git-accounts')).json<Array<{ keys: object }>>()[0]?.keys).toEqual({});
  });
});

describe('removing a key and removing the account', () => {
  test('a key comes off GitHub first; the sealed key goes with the last registration', async () => {
    const github = new KeyGithub();
    const { rec, tools } = fake();
    const world = await boot(github, tools);
    await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'both' });
    const port = world.host.provided(GitAccountsPort);
    await port.agentSocket(ACCOUNT as never);
    expect(rec.starts).toHaveLength(1);

    const first = await world.request('DELETE', `/v1/git-accounts/${ACCOUNT}/keys/signing`);
    expect(first.json()).toEqual({ id: ACCOUNT, purpose: 'signing', removed: true });
    expect(github.registered.signing).toHaveLength(0);
    expect(await world.sealed.keys?.names()).toEqual([ACCOUNT]);
    expect(rec.killed).toEqual([]);

    await world.request('DELETE', `/v1/git-accounts/${ACCOUNT}/keys/auth`);
    expect(github.registered.keys).toHaveLength(0);
    expect(await world.sealed.keys?.names()).toEqual([]);
    expect(rec.killed).toHaveLength(1);
    expect((await world.request('DELETE', `/v1/git-accounts/${ACCOUNT}/keys/auth`)).status).toBe(404);
    expect((await world.request('DELETE', `/v1/git-accounts/${ACCOUNT}/keys/both`)).status).toBe(404);
  });

  test('a key GitHub will not delete stays recorded, so removing it can be tried again', async () => {
    const github = new KeyGithub();
    const world = await boot(github, fake().tools);
    await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'auth' });
    github.deleteStatus.set(`/user/keys/${github.registered.keys[0]?.id}`, 403);
    expect((await world.request('DELETE', `/v1/git-accounts/${ACCOUNT}/keys/auth`)).status).toBe(502);
    expect(
      (await world.request('GET', '/v1/git-accounts')).json<Array<{ keys: { ssh?: object } }>>()[0]?.keys.ssh,
    ).toBeDefined();
    expect(await world.sealed.keys?.names()).toEqual([ACCOUNT]);
  });

  test('removing the account deletes its keys at GitHub, stops its agent, and drops the private key', async () => {
    const github = new KeyGithub();
    const { rec, tools } = fake();
    const world = await boot(github, tools);
    await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'both' });
    await world.host.provided(GitAccountsPort).agentSocket(ACCOUNT as never);
    const removed = await world.request('DELETE', `/v1/git-accounts/${ACCOUNT}`);
    expect(removed.json()).toMatchObject({ removed: true, keysLeftOnProvider: [] });
    expect(github.registered.keys).toHaveLength(0);
    expect(github.registered.signing).toHaveLength(0);
    expect(rec.killed).toHaveLength(1);
    expect(await world.sealed.keys?.names()).toEqual([]);
    expect(await world.sealed.tokens?.names()).toEqual([]);
  });
});

describe('the agent seam (fake processes)', () => {
  test('the key reaches the agent on stdin only: nothing private in argv, in env, or in a log', async () => {
    const github = new KeyGithub();
    const { rec, tools } = fake();
    const world = await boot(github, tools);
    await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'both' });
    const port = world.host.provided(GitAccountsPort);
    const socket = await port.agentSocket(ACCOUNT as never);
    expect(socket).toBe(`${world.runFolder.path}/gha_4242.sock`);

    expect(rec.starts).toHaveLength(1);
    expect(rec.starts[0]?.program).toBe('ssh-agent');
    expect(rec.starts[0]?.args).toEqual(['-D', '-a', socket as string]);
    expect(rec.starts[0]?.options?.sealed).toBe(true);
    const add = rec.runs.find(call => call.program === 'ssh-add' && call.args[0] === '-');
    expect(add?.args).toEqual(['-']);
    expect(add?.options?.sealed).toBe(true);
    expect(add?.options?.env).toEqual({ SSH_AUTH_SOCK: socket as string });
    const stdin = String(add?.options?.stdin);
    expect(stdin).toContain('BEGIN OPENSSH PRIVATE KEY');
    const sealed = JSON.parse((await world.sealed.keys?.get(ACCOUNT as never)) as string) as { privateKey: string };
    expect(stdin).toBe(sealed.privateKey);
    // Everything else the host was asked to spawn carries no key material.
    for (const call of [...rec.runs, ...rec.starts]) {
      const without = call === add ? { ...call, options: { ...call.options, stdin: undefined } } : call;
      expect(JSON.stringify(without)).not.toContain('PRIVATE');
      expect(JSON.stringify(without)).not.toContain(sealed.privateKey.split('\n')[1] as string);
    }
    await expectNoPrivateKey(world);
  });

  test('the agent is started once however many ask at once, and only for a key Ferretry made', async () => {
    const github = new KeyGithub();
    const { rec, tools } = fake();
    const world = await boot(github, tools);
    const port = world.host.provided(GitAccountsPort);
    expect(await port.agentSocket(ACCOUNT as never)).toBeUndefined();
    await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'auth' });
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => port.agentSocket(ACCOUNT as never)));
    expect(new Set([a, b, c]).size).toBe(1);
    expect(rec.starts).toHaveLength(1);
    expect(rec.runs.filter(call => call.program === 'ssh-add' && call.args[0] === '-')).toHaveLength(1);
  });

  test('an agent that cannot take the key is killed and the answer is a 503-class error, never the key', async () => {
    const github = new KeyGithub();
    const rec = recorder();
    const world = await boot(github, {
      start: rec.fakeStart,
      spawn: (program, args, options) => {
        const result = rec.fakeRun(program, args, options);
        return program === 'ssh-add' && args[0] === '-' ? { ...result, exitCode: 1, stderr: 'bad key' } : result;
      },
    });
    await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'auth' });
    const port = world.host.provided(GitAccountsPort);
    await expect(port.agentSocket(ACCOUNT as never)).rejects.toMatchObject({ status: 503 });
    expect(rec.killed).toHaveLength(1);
  });

  test('stopping the daemon ends every agent; known_hosts pins GitHub, is written once, and stays for a ferret that outlives the restart', async () => {
    const github = new KeyGithub();
    const { rec, tools } = fake();
    const world = await boot(github, tools);
    await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'auth' });
    const port = world.host.provided(GitAccountsPort);
    await port.agentSocket(ACCOUNT as never);
    const known = await port.knownHostsFile();
    expect(await port.knownHostsFile()).toBe(known);
    expect(statSync(known).mode & 0o777).toBe(0o600);
    expect(statSync(known.replace(/\/[^/]+$/u, '')).mode & 0o777).toBe(0o700);
    const text = (await Bun.file(known).text()).trim().split('\n');
    expect(text).toEqual(GITHUB_HOST_KEYS.map(key => `github.com ${key}`));
    await world.host.stop();
    expect(rec.killed).toHaveLength(1);
    // A ferret started before the restart still names this file in `UserKnownHostsFile`: it must still be there.
    expect(existsSync(known)).toBe(true);
    expect(known).toBe(`${world.runFolder.path}/known_hosts`);
  });
});

/** Real processes for the fakes' `run`/`start`: only the tests may spawn, and only the three declared tools. */
function realTools() {
  const children: ChildProcess[] = [];
  /** What each child did, so a failure on a machine where this cannot be reproduced says where it stopped. */
  const trace: string[] = [];
  const env = (options?: SpawnOptions) => ({
    PATH: process.env.PATH ?? '',
    ...(options?.env as Record<string, string> | undefined),
  });
  const once = (program: string, args: readonly string[], options?: SpawnOptions): Promise<SpawnResult> =>
    new Promise(resolve => {
      const child = nodeSpawn(program, [...args], { env: env(options), stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', chunk => (stdout += String(chunk)));
      child.stderr?.on('data', chunk => (stderr += String(chunk)));
      const limit = setTimeout(() => child.kill('SIGKILL'), 8_000);
      child.on('close', (code, signal) => {
        clearTimeout(limit);
        trace.push(`${program} ${args.join(' ')} -> ${code ?? signal} ${stderr.trim().slice(0, 200)}`);
        resolve({ exitCode: code, signal, stdout, stderr });
      });
      child.stdin?.end(typeof options?.stdin === 'string' ? options.stdin : undefined);
    });
  /** The test host's clock is a fake that only moves when told, so a readiness probe must not sleep on it: wait in real time here. */
  const spawn = async (program: string, args: readonly string[], options?: SpawnOptions): Promise<SpawnResult> => {
    const probe = program === 'ssh-add' && args[0] === '-l';
    for (let attempt = 0; ; attempt += 1) {
      const result = await once(program, args, options);
      if (!probe || result.exitCode !== 2 || attempt >= 60) return result;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const start = (program: string, args: readonly string[], options?: SpawnOptions): ChildHandle => {
    const child = nodeSpawn(program, [...args], { env: env(options), stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    return {
      pid: child.pid ?? 0,
      stdout: Readable.toWeb(child.stdout as Readable) as unknown as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr as Readable) as unknown as ReadableStream<Uint8Array>,
      write: chunk => void child.stdin?.write(chunk),
      kill: signal => void child.kill((signal ?? 'SIGTERM') as NodeJS.Signals),
      exited: new Promise(resolve => child.on('close', code => resolve(code))),
      pipes: [],
      closePipes: () => undefined,
    };
  };
  return { spawn, start, children, trace };
}

describe.skipIf(!HAVE_TOOLS)('a real ssh-agent (needs ssh-agent, ssh-add and ssh-keygen; skipped without them)', () => {
  test("the socket is 0600 in a 0700 folder, the agent holds the key and signs with it, and the account's removal ends it", async () => {
    const github = new KeyGithub();
    const real = realTools();
    const dump = setTimeout(() => console.error(`ssh-agent test trace:\n${real.trace.join('\n')}`), 15_000);
    const world = await boot(github, real);
    const created = GitKeyResultSchema.parse(
      (await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'both' })).json(),
    );
    const port = world.host.provided(GitAccountsPort);
    const socket = (await port.agentSocket(ACCOUNT as never)) as string;
    try {
      expect(statSync(socket).mode & 0o777).toBe(0o600);
      expect(statSync(socket.replace(/\/[^/]+$/u, '')).mode & 0o777).toBe(0o700);
      // Same socket on a second ask, one agent.
      expect(await port.agentSocket(ACCOUNT as never)).toBe(socket);
      expect(real.children).toHaveLength(1);

      const env = { PATH: process.env.PATH ?? '', SSH_AUTH_SOCK: socket };
      const listed = execFileSync('ssh-add', ['-l'], { env, encoding: 'utf8' });
      expect(listed).toContain(created.fingerprint);
      // The agent signs for a caller that holds only its socket and the public key: use, never read.
      const dir = mkdtempSync(`${tmpdir()}/b3-sign-`);
      try {
        writeFileSync(`${dir}/id.pub`, `${created.publicKey}\n`);
        const signed = spawnSync('ssh-keygen', ['-Y', 'sign', '-f', `${dir}/id.pub`, '-n', 'git', '-U'], {
          env,
          input: 'a commit body\n',
          encoding: 'utf8',
        });
        expect(signed.status).toBe(0);
        expect(signed.stdout).toContain('BEGIN SSH SIGNATURE');
        // The agent has no request that returns the key: its listing is the public half.
        expect(listed).not.toContain('PRIVATE');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      await world.request('DELETE', `/v1/git-accounts/${ACCOUNT}`);
      await real.children[0]?.exitCode;
      await new Promise(resolve => setTimeout(resolve, 300));
      const after = spawnSync('ssh-add', ['-l'], { env, encoding: 'utf8' });
      expect(after.status).toBe(2);
      await expectNoPrivateKey(world, [listed]);
    } finally {
      clearTimeout(dump);
      for (const child of real.children) child.kill('SIGKILL');
    }
  }, 30_000);
});

/** The ferret's launch: what the account's `launch.parts` source says for a folder, as a pane would receive it. */
async function paneEnvFor(world: Awaited<ReturnType<typeof boot>>, folder: string): Promise<Record<string, string>> {
  const parts = (await world.held.source?.parts({ folder })) ?? [];
  return Object.assign({}, ...parts.flatMap(part => (part.kind === 'pane-env' ? [part.env] : [])));
}

describe.skipIf(!HAVE_TOOLS || spawnSync('git', ['--version']).status !== 0)(
  'a real commit through the account’s agent, with exactly the launch environment (owner step 5 proves the real GitHub)',
  () => {
    const EMAIL = '4242+octo-fake@users.noreply.github.com';
    const root = mkdtempSync(`${tmpdir()}/b4-e2e-`);
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    /** A temp repo in a linked project, a world with real processes, and `git` run with the pane's environment alone. */
    async function setup(purpose: 'auth' | 'signing' | 'both', name: string) {
      const github = new KeyGithub();
      github.verifiedEmails = [EMAIL];
      const project = {
        id: '00000000-0000-4000-8000-000000000001',
        name,
        path: `${root}/${name}`,
        accounts: [ACCOUNT],
      };
      mkdirSync(project.path, { recursive: true });
      const real = realTools();
      const world = await boot(github, real, [project]);
      await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose });
      const env = await paneEnvFor(world, project.path);
      const home = `${root}/${name}-home`;
      mkdirSync(home, { recursive: true });
      const git = (args: string[], extra: Record<string, string> = {}) =>
        spawnSync('git', args, {
          cwd: project.path,
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH ?? '',
            HOME: home,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            ...env,
            ...extra,
          },
        });
      expect(git(['init', '-q', '-b', 'main']).status).toBe(0);
      return { github, world, real, env, git, project };
    }
    const verdict = async (ctx: Awaited<ReturnType<typeof setup>>) => {
      const sha = ctx.git(['rev-parse', 'HEAD']).stdout.trim();
      ctx.github.commits.set(sha, ctx.git(['cat-file', 'commit', 'HEAD']).stdout);
      const answer = await ctx.world.host
        .provided(GitAccountsPort)
        .api(ACCOUNT as never, { method: 'GET', path: `/repos/o/r/commits/${sha}` });
      return (answer.body as { commit: { verification: { verified: boolean; reason: string } } }).commit.verification;
    };
    const finish = (ctx: Awaited<ReturnType<typeof setup>>) => {
      for (const child of ctx.real.children) child.kill('SIGKILL');
    };

    test('a signed commit shows Verified: valid signature, a registered signing key, the noreply address', async () => {
      const ctx = await setup('both', 'verified');
      try {
        const committed = ctx.git(['commit', '--allow-empty', '-q', '-m', 'signed']);
        expect(committed.stderr).toBe('');
        expect(committed.status).toBe(0);
        expect(await verdict(ctx)).toEqual({ verified: true, reason: 'valid' });
        expect(ctx.git(['log', '-1', '--format=%ae']).stdout.trim()).toBe(EMAIL);
        // Nothing the pane was given is key material.
        expect(JSON.stringify(ctx.env)).not.toContain('PRIVATE');
      } finally {
        finish(ctx);
      }
    }, 60_000);

    test('negatives: a key registered for pushing only is unknown_key, another address is bad_email, no signature is unsigned', async () => {
      const ctx = await setup('both', 'negatives');
      try {
        ctx.git(['-c', 'user.email=someone@example.com', 'commit', '--allow-empty', '-q', '-m', 'other address']);
        expect(await verdict(ctx)).toEqual({ verified: false, reason: 'bad_email' });
        ctx.git(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'unsigned']);
        expect(await verdict(ctx)).toEqual({ verified: false, reason: 'unsigned' });
        ctx.git(['commit', '--allow-empty', '-q', '-m', 'signed']);
        ctx.github.registered.signing.length = 0;
        expect(await verdict(ctx)).toEqual({ verified: false, reason: 'unknown_key' });
      } finally {
        finish(ctx);
      }
    }, 60_000);

    test('core.sshCommand ignores the person’s ssh config and offers exactly this account’s key, checked against the pinned host keys', async () => {
      const ctx = await setup('auth', 'sshconfig');
      try {
        const command = (ctx.git(['config', 'core.sshCommand']).stdout || '').trim();
        expect(command).toMatch(
          /^ssh -F none -o IdentitiesOnly=yes -o IdentityFile=\S+\.pub -o IdentityAgent=\S+\.sock -o StrictHostKeyChecking=yes -o UserKnownHostsFile=\S+\/known_hosts$/u,
        );
        // A hostile or merely busy ~/.ssh/config: a proxy, a key, agent forwarding and an alias for github.com.
        const home = `${root}/sshconfig-home`;
        mkdirSync(`${home}/.ssh`, { recursive: true });
        writeFileSync(
          `${home}/.ssh/config`,
          'Host github.com\n  ProxyCommand /bin/false\n  IdentityFile ~/.ssh/id_host\n  ForwardAgent yes\n  HostName evil.example\n  StrictHostKeyChecking no\n',
        );
        const shown = spawnSync('sh', ['-c', `${command} -G git@github.com`], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '', HOME: home },
        });
        expect(shown.status).toBe(0);
        const effective = new Map(
          shown.stdout.split('\n').map(line => [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)] as const),
        );
        expect(effective.get('hostname')).toBe('github.com');
        expect(effective.get('proxycommand')).toBeUndefined();
        expect(effective.get('forwardagent')).toBe('no');
        expect(effective.get('identitiesonly')).toBe('yes');
        expect(effective.get('stricthostkeychecking')).toBe('true');
        expect(
          shown.stdout
            .split('\n')
            .filter(line => line.startsWith('identityfile '))
            .map(line => line.slice(13)),
        ).toEqual([String(ctx.env.SSH_AUTH_SOCK).replace(/\.sock$/u, '.pub')]);
        expect(effective.get('identityagent')).toBe(ctx.env.SSH_AUTH_SOCK);
        expect(effective.get('userknownhostsfile')).toBe(
          `${String(ctx.env.SSH_AUTH_SOCK).replace(/[^/]+$/u, '')}known_hosts`,
        );
      } finally {
        finish(ctx);
      }
    }, 60_000);
  },
);
