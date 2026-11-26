/**
 * The GPG signing key of a Git account (ledger W-45): what git is told, what the routes answer, and a commit made with
 * exactly the launch environment that `git verify-commit` accepts. The key, the account and GitHub are all synthetic; no
 * real GitHub call is made and the machine's own `~/.gnupg` is never named (every process gets a temp HOME).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { SealedDocumentDef, SealedDocumentHandle } from '@ferretry/core-vault/contract';
import { FakeSealedDocuments } from '@ferretry/core-vault/contract/testing';
import type { ChildHandle, SpawnOptions, SpawnResult, StatePort } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import type { LaunchPart } from '@ferretry/core-ferrets/contract';
import {
  GIT_ACCOUNT_KEYS,
  GitAccountsPort,
  GitGpgKeyResultSchema,
  GitKeyRemovedSchema,
  GitKeyRequestSchema,
  type GitAccount,
  NO_SECRET_FIELDS,
} from '../../contract/index.ts';
import { gitAccountsDaemon } from '../../daemon/index.ts';
import { type AccountKit, gitEnvironment, noIdentityEnvironment } from '../../daemon/features/launch/environment.ts';
import type { GpgKit } from '../../daemon/features/gpg-keys/gnupg.ts';
import { FAKE_TOKEN, FakeGithub } from './fake-github.ts';
import { ghHost } from './gh-host.ts';
import { tmpRunFolder } from './run-folder.ts';

const ACCOUNT = 'gha_4242';
const EMAIL = '4242+octo-fake@users.noreply.github.com';
const CLIENT = 'Ov23FAKECLIENTID';
const HAVE_SSH = ['ssh-agent', 'ssh-add'].every(tool => spawnSync('which', [tool], { stdio: 'ignore' }).status === 0);
const HAVE_GPG = ['gpg', 'gpgconf', 'git'].every(tool => spawnSync('which', [tool], { stdio: 'ignore' }).status === 0);

const account = (extra: Partial<GitAccount> = {}): GitAccount => ({
  id: ACCOUNT as GitAccount['id'],
  provider: 'github',
  githubId: 4242,
  login: 'octo-fake',
  name: 'Octo Fake',
  scopes: [],
  keys: {},
  createdAt: '2026-11-19T00:00:00.000Z',
  ...extra,
});

const GPG_KIT: GpgKit = {
  home: '/run/fy/gha_4242.gnupg',
  fingerprint: 'A'.repeat(40),
  program: '/usr/bin/gpg',
};
const SSH_KIT: AccountKit = {
  socket: '/run/fy/gha_4242.sock',
  publicKeyFile: '/run/fy/gha_4242.pub',
  knownHosts: '/run/fy/known_hosts',
  auth: true,
  signing: false,
};

/** The git-config pairs a launch environment spells, in order. */
function settingsOf(env: Readonly<Record<string, string>>): Array<[string, string]> {
  const count = Number(env['GIT_CONFIG_COUNT'] ?? '0');
  return Array.from({ length: count }, (_, i) => [
    env[`GIT_CONFIG_KEY_${String(i)}`] as string,
    env[`GIT_CONFIG_VALUE_${String(i)}`] as string,
  ]);
}

describe('what git is told for a GPG key (the launch environment)', () => {
  test('signs with the key by fingerprint through the real gpg, in the account’s own GNUPGHOME', () => {
    const env = gitEnvironment(account(), undefined, GPG_KIT);
    const settings = new Map(settingsOf(env));
    expect(settings.get('gpg.format')).toBe('openpgp');
    expect(settings.get('user.signingkey')).toBe(GPG_KIT.fingerprint);
    expect(settings.get('gpg.program')).toBe('/usr/bin/gpg');
    expect(settings.get('commit.gpgsign')).toBe('true');
    expect(settings.get('tag.gpgsign')).toBe('true');
    expect(settings.get('user.email')).toBe(EMAIL);
    expect(env['GNUPGHOME']).toBe(GPG_KIT.home);
    // No ssh side was asked for, so no ssh socket and no ssh settings ride along.
    expect(env['SSH_AUTH_SOCK']).toBeUndefined();
    expect(
      [...settings.keys()].filter(key => key.startsWith('core.ssh') || key === 'url.git@github.com:.insteadOf'),
    ).toEqual([]);
  });

  test('a push key and a GPG signing key together: ssh pushes, gpg signs, and gpg.format is never ssh', () => {
    const env = gitEnvironment(account(), SSH_KIT, GPG_KIT);
    const settings = new Map(settingsOf(env));
    expect(settings.get('gpg.format')).toBe('openpgp');
    expect(settings.get('core.sshCommand')).toContain('IdentityAgent=/run/fy/gha_4242.sock');
    expect(env['SSH_AUTH_SOCK']).toBe(SSH_KIT.socket);
    expect(env['GNUPGHOME']).toBe(GPG_KIT.home);
  });

  test('the environment is paths, a fingerprint and words: no key material', () => {
    expect(JSON.stringify(gitEnvironment(account(), SSH_KIT, GPG_KIT))).not.toMatch(/PRIVATE|BEGIN PGP/u);
  });

  test('a recorded GPG key that cannot be served switches signing off (never the machine’s own signing)', () => {
    const none = noIdentityEnvironment(
      account({
        keys: { signing: { title: 't', format: 'gpg', openpgpFingerprint: 'A'.repeat(40), source: 'generated' } },
      }),
    );
    const settings = new Map(settingsOf(none));
    expect(settings.get('commit.gpgsign')).toBe('false');
    expect(settings.get('tag.gpgsign')).toBe('false');
    expect(none['GIT_CONFIG_PARAMETERS']).toContain("'commit.gpgsign'='false'");
    // An imported key is Ferretry's to speak for too.
    expect(
      Object.keys(
        noIdentityEnvironment(
          account({
            keys: { signing: { title: 't', format: 'gpg', openpgpFingerprint: 'A'.repeat(40), source: 'imported' } },
          }),
        ),
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe('the GPG request and answer', () => {
  test('a GPG request is a signing request: no ssh public key, and a key block needs format gpg', () => {
    const block = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nAAAA\n-----END PGP PRIVATE KEY BLOCK-----\n';
    expect(GitKeyRequestSchema.safeParse({ purpose: 'signing', format: 'gpg' }).success).toBe(true);
    expect(GitKeyRequestSchema.safeParse({ purpose: 'signing', format: 'gpg', keyBlock: block }).success).toBe(true);
    expect(GitKeyRequestSchema.safeParse({ purpose: 'both', format: 'gpg' }).success).toBe(false);
    expect(GitKeyRequestSchema.safeParse({ purpose: 'auth', format: 'gpg' }).success).toBe(false);
    expect(GitKeyRequestSchema.safeParse({ purpose: 'signing', keyBlock: block }).success).toBe(false);
    expect(GitKeyRequestSchema.safeParse({ purpose: 'signing', format: 'gpg', keyBlock: 'not a key' }).success).toBe(
      false,
    );
    // The older SSH request is unchanged.
    expect(GitKeyRequestSchema.safeParse({ purpose: 'both' }).success).toBe(true);
  });

  test('no field of the GPG answer is named like a secret', () => {
    expect(Object.keys(GitGpgKeyResultSchema.shape).filter(name => NO_SECRET_FIELDS.test(name))).toEqual([]);
  });
});

// ─── a real gpg, a real git ─────────────────────────────────────────────────────────────────────────────────────────

const baseName = (program: string) => program.slice(program.lastIndexOf('/') + 1);
const scratch = mkdtempSync(`${tmpdir()}/g8-gpg-`);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

class SpySealed extends FakeSealedDocuments {
  keys: SealedDocumentHandle | undefined;
  override open(own: StatePort, document: SealedDocumentDef): SealedDocumentHandle {
    const opened = super.open(own, document);
    if (document === GIT_ACCOUNT_KEYS) this.keys = opened;
    return opened;
  }
}

interface Registered {
  id: number;
  name: string;
  armored_public_key: string;
}

/** GitHub's `/user/gpg_keys`, over the scripted device-flow fake. */
class GpgGithub extends FakeGithub {
  readonly registered: Registered[] = [];
  /** A status to answer a registration with instead of 201. */
  refuse: number | undefined;
  /** The account already holds whatever key is posted: 422 on the POST, and the listing names it by its key id. */
  alreadyHolds = false;
  /** `key_id`s the account lists. */
  listed: string[] = [];
  readonly deleted: string[] = [];
  #next = 700;

  readonly keyFetch = async (url: URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    if (url.host === 'api.github.com' && url.pathname === '/user/gpg_keys') {
      this.seen.push({
        method,
        url: url.toString(),
        body: String(init?.body ?? ''),
        authorization: new Headers(init?.headers).get('authorization') ?? '',
      });
      if (method === 'GET') return Response.json(this.listed.map(key_id => ({ key_id })));
      if (this.refuse !== undefined) return Response.json({ message: 'Validation Failed' }, { status: this.refuse });
      if (this.alreadyHolds) {
        mkdirSync(`${scratch}/show-only`, { recursive: true, mode: 0o700 });
        const shown = spawnSync('gpg', ['--batch', '--with-colons', '--import-options', 'show-only', '--import'], {
          input: String((JSON.parse(String(init?.body)) as { armored_public_key: string }).armored_public_key),
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '', HOME: scratch, GNUPGHOME: `${scratch}/show-only` },
        }).stdout;
        const fpr =
          shown
            .split('\n')
            .find(line => line.startsWith('fpr:'))
            ?.split(':')[9] ?? '';
        this.listed = [fpr.slice(-16)];
        return Response.json({ message: 'Validation Failed' }, { status: 422 });
      }
      const body = JSON.parse(String(init?.body)) as Omit<Registered, 'id'>;
      this.#next += 1;
      this.registered.push({ id: this.#next, ...body });
      return Response.json({ id: this.#next, name: body.name }, { status: 201 });
    }
    if (url.host === 'api.github.com' && url.pathname === '/user/keys' && method === 'POST') {
      this.#next += 1;
      return Response.json({ id: this.#next }, { status: 201 });
    }
    if (url.host === 'api.github.com' && /^\/user\/keys\/[0-9]+$/u.test(url.pathname) && method === 'DELETE') {
      this.deleted.push(url.pathname);
      return new Response(null, { status: 204 });
    }
    const gone = /^\/user\/gpg_keys\/([0-9]+)$/u.exec(url.pathname);
    if (url.host === 'api.github.com' && method === 'DELETE' && gone !== null) {
      this.deleted.push(url.pathname);
      const at = this.registered.findIndex(key => String(key.id) === gone[1]);
      if (at >= 0) this.registered.splice(at, 1);
      return new Response(null, { status: 204 });
    }
    return await this.fetch(url, init);
  };
}

/** Real processes for the daemon's `spawn.run`, each with a temp HOME and only what the daemon hands over in `env`. */
function realGpg(home: string) {
  const trace: string[] = [];
  const children: ChildProcess[] = [];
  const run = (program: string, args: readonly string[], options?: SpawnOptions): Promise<SpawnResult> =>
    new Promise(resolve => {
      const child = nodeSpawn(program, [...args], {
        env: { PATH: process.env.PATH ?? '', HOME: home, ...(options?.env as Record<string, string> | undefined) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', chunk => (stdout += String(chunk)));
      child.stderr?.on('data', chunk => (stderr += String(chunk)));
      const limit = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.on('close', (code, signal) => {
        clearTimeout(limit);
        trace.push(`${program} ${args.slice(0, 2).join(' ')} -> ${String(code ?? signal)}`);
        resolve({ exitCode: code, signal, stdout, stderr });
      });
      child.stdin?.end(typeof options?.stdin === 'string' ? options.stdin : undefined);
    });
  const start = (program: string, args: readonly string[], options?: SpawnOptions): ChildHandle => {
    const child = nodeSpawn(baseName(program), [...args], {
      env: { PATH: process.env.PATH ?? '', HOME: home, ...(options?.env as Record<string, string> | undefined) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
  return {
    trace,
    children,
    spawn: (program: string, args: readonly string[], options?: SpawnOptions) => run(baseName(program), args, options),
    start,
  };
}

type Source = { parts(spec: object): Promise<readonly LaunchPart[]> };

async function boot(github: GpgGithub, projects: readonly object[]) {
  const sealed = new SpySealed();
  const gate = new FakeGate();
  const runFolder = tmpRunFolder();
  const home = mkdtempSync(`${scratch}/home-`);
  const held: { source?: Source } = {};
  const impl = gitAccountsDaemon({ runFolder });
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
  const real = realGpg(home);
  const host = await testHost({
    plugins: [wrapped],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { sealed, gate },
    uses: { projects: { list: async () => projects } },
    fetch: github.keyFetch,
    ...ghHost('/usr/bin', ['/usr/bin/gpg', '/usr/bin/gpgconf', '/usr/bin/ssh-agent', '/usr/bin/ssh-add']),
    spawn: real.spawn,
    start: real.start,
    config: { 'git-accounts.yaml': { github: { clientId: CLIENT } } },
  });
  const responses: string[] = [];
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await host.request(method, path, body === undefined ? {} : { body });
    responses.push(response.body);
    return response;
  };
  github.tokenAnswers = [{ access_token: FAKE_TOKEN, scope: 'read:user user:email write:gpg_key repo read:org' }];
  const flow = (await request('POST', '/v1/git-accounts/github/device')).json<{ flowId: string }>();
  await host.clock.advance(5000);
  await request('GET', `/v1/git-accounts/github/device/${flow.flowId}`);
  responses.length = 0;
  return { host, sealed, gate, request, responses, runFolder, held, home, real };
}
type World = Awaited<ReturnType<typeof boot>>;

const folders: Array<{ destroy(): void }> = [];
afterAll(() => {
  for (const folder of folders) folder.destroy();
});

/** The ferret's launch: what the account's `launch.parts` source says for a folder, as a pane would receive it. */
async function paneEnvFor(world: World, folder: string): Promise<Record<string, string>> {
  const parts = (await world.held.source?.parts({ folder })) ?? [];
  return Object.assign({}, ...parts.flatMap(part => (part.kind === 'pane-env' ? [part.env] : [])));
}

const bareEnv = (home: string, extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? '',
  HOME: home,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  ...extra,
});

/** `gpg` in a throwaway home that holds nothing of the account's: the verifier a stranger (GitHub) would be. */
function strangerHome(name: string): string {
  const dir = `${scratch}/${name}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

describe.skipIf(!HAVE_GPG)('a real gpg and git (needs gpg, gpgconf and git; skipped without them)', () => {
  const root = `${scratch}/projects`;

  async function setup(name: string) {
    const github = new GpgGithub();
    const project = {
      id: '00000000-0000-4000-8000-000000000001',
      name,
      path: `${root}/${name}`,
      accounts: [ACCOUNT],
    };
    mkdirSync(project.path, { recursive: true });
    const world = await boot(github, [project]);
    folders.push(world.runFolder);
    return { github, world, project };
  }
  const gitIn = (cwd: string, home: string, env: Record<string, string>) => (args: string[]) =>
    spawnSync('git', args, { cwd, encoding: 'utf8', env: bareEnv(home, env) });

  test('generate: a commit made with ONLY the launch environment is signed, git verify-commit accepts it, and a stranger’s keyring accepts it with GitHub’s copy of the key', async () => {
    const { github, world, project } = await setup('generate');
    try {
      const created = await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, {
        purpose: 'signing',
        format: 'gpg',
      });
      expect(created.status).toBe(200);
      const result = GitGpgKeyResultSchema.parse(created.json());
      expect(result.registered).toEqual(['signing']);
      expect(result.source).toBe('generated');
      expect(result.publicKey).toContain('BEGIN PGP PUBLIC KEY BLOCK');

      // GitHub got the PUBLIC block, titled with the machine, over the account's token.
      expect(github.registered).toHaveLength(1);
      expect(github.registered[0]?.armored_public_key).toBe(result.publicKey);
      expect(github.registered[0]?.name).toBe('Ferretry test-daemon');
      expect(github.seen.find(call => call.url.endsWith('/user/gpg_keys'))?.authorization).toBe(`Bearer ${FAKE_TOKEN}`);

      // The record names the key by fingerprint; the secret half is sealed and in no answer.
      const listed = (await world.request('GET', '/v1/git-accounts')).json<GitAccount[]>();
      expect(listed[0]?.keys.signing).toMatchObject({
        format: 'gpg',
        openpgpFingerprint: result.fingerprint,
        source: 'generated',
      });
      const sealedText = (await world.sealed.keys?.get(`${ACCOUNT}:gpg` as never)) ?? '';
      expect(sealedText).toContain('PRIVATE KEY BLOCK');

      // The launch environment: git signs with this key, from this account's isolated home.
      const env = await paneEnvFor(world, project.path);
      const settings = new Map(settingsOf(env));
      expect(settings.get('gpg.format')).toBe('openpgp');
      expect(settings.get('user.signingkey')).toBe(result.fingerprint);
      expect(settings.get('commit.gpgsign')).toBe('true');
      expect(env['GNUPGHOME']).toBe(`${world.runFolder.path}/${ACCOUNT}.gnupg`);
      expect(statSync(env['GNUPGHOME'] as string).mode & 0o777).toBe(0o700);

      const git = gitIn(project.path, world.home, env);
      expect(git(['init', '-q', '-b', 'main']).status).toBe(0);
      const committed = git(['commit', '--allow-empty', '-q', '-m', 'signed']);
      expect(committed.stderr).toBe('');
      expect(committed.status).toBe(0);
      expect(git(['cat-file', 'commit', 'HEAD']).stdout).toContain('-----BEGIN PGP SIGNATURE-----');
      expect(git(['log', '-1', '--format=%ae']).stdout.trim()).toBe(EMAIL);
      const verified = git(['verify-commit', 'HEAD']);
      expect(verified.status).toBe(0);
      expect(verified.stderr).toContain('Good signature');

      // What GitHub does: only the registered public key, in a keyring of its own, and the committer address is the key's.
      const stranger = strangerHome('generate-stranger');
      const imported = spawnSync('gpg', ['--batch', '--import'], {
        input: github.registered[0]?.armored_public_key,
        encoding: 'utf8',
        env: bareEnv(world.home, { GNUPGHOME: stranger }),
      });
      expect(imported.status).toBe(0);
      const there = spawnSync('git', ['verify-commit', 'HEAD'], {
        cwd: project.path,
        encoding: 'utf8',
        env: bareEnv(world.home, { GNUPGHOME: stranger }),
      });
      expect(there.status).toBe(0);
      expect(there.stderr).toContain('Good signature');
      const uids = spawnSync('gpg', ['--list-keys', '--with-colons'], {
        encoding: 'utf8',
        env: bareEnv(world.home, { GNUPGHOME: stranger }),
      }).stdout;
      expect(uids).toContain(`<${EMAIL}>`);

      // Never printed, never returned, never logged: the secret half is in none of it.
      const everything = [
        ...world.responses,
        ...world.host.logs.map(log => `${log.message} ${JSON.stringify(log.fields ?? {})}`),
        JSON.stringify(world.gate.audits ?? []),
        JSON.stringify(env),
        JSON.stringify(github.seen),
      ].join('\n');
      expect(everything).not.toContain('PRIVATE KEY');
      const secretBody = sealedText.split('\\n').find(line => line.length > 40 && /^[A-Za-z0-9+/=]+$/u.test(line));
      if (secretBody !== undefined) expect(everything).not.toContain(secretBody);
      // The person's own keyring was never touched: the temp HOME has no `.gnupg`.
      expect(existsSync(`${world.home}/.gnupg`)).toBe(false);
    } finally {
      await world.host.stop();
    }
  }, 90_000);

  test('import: a key the person hands over is kept sealed, gains the noreply address, and signs; a passphrase-protected key is refused in words', async () => {
    const { github, world, project } = await setup('import');
    try {
      const mine = strangerHome('import-author');
      const author = (args: string[], input?: string) =>
        spawnSync('gpg', args, { input, encoding: 'utf8', env: bareEnv(world.home, { GNUPGHOME: mine }) });
      expect(
        author([
          '--batch',
          '--pinentry-mode',
          'loopback',
          '--passphrase',
          '',
          '--quick-generate-key',
          'Mine <mine@example.test>',
          'ed25519',
          'cert,sign',
          'never',
        ]).status,
      ).toBe(0);
      const block = author(['--batch', '--armor', '--export-secret-keys']).stdout;
      expect(block).toContain('PRIVATE KEY BLOCK');

      const refusedBody = await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, {
        purpose: 'signing',
        format: 'gpg',
        keyBlock: 'nonsense',
      });
      expect(refusedBody.status).toBe(400);

      const created = await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, {
        purpose: 'signing',
        format: 'gpg',
        keyBlock: block,
      });
      expect(created.status).toBe(200);
      const result = GitGpgKeyResultSchema.parse(created.json());
      expect(result.source).toBe('imported');
      // The block the person sent is nowhere in what came back.
      expect(created.body).not.toContain('PRIVATE KEY');
      // GitHub's copy now names the account's address too (it only calls a commit Verified for an address the key holds).
      const stranger = strangerHome('import-stranger');
      spawnSync('gpg', ['--batch', '--import'], {
        input: github.registered[0]?.armored_public_key,
        env: bareEnv(world.home, { GNUPGHOME: stranger }),
      });
      const uids = spawnSync('gpg', ['--list-keys', '--with-colons'], {
        encoding: 'utf8',
        env: bareEnv(world.home, { GNUPGHOME: stranger }),
      }).stdout;
      expect(uids).toContain(`<${EMAIL}>`);

      const env = await paneEnvFor(world, project.path);
      const git = gitIn(project.path, world.home, env);
      git(['init', '-q', '-b', 'main']);
      expect(git(['commit', '--allow-empty', '-q', '-m', 'imported']).status).toBe(0);
      expect(git(['verify-commit', 'HEAD']).status).toBe(0);

      // Removing it deletes it at GitHub (it was registered by us), forgets the sealed key and the home.
      const removed = await world.request('DELETE', `/v1/git-accounts/${ACCOUNT}/keys/signing`);
      expect(GitKeyRemovedSchema.parse(removed.json())).toMatchObject({ purpose: 'signing', removed: true });
      expect(github.deleted).toEqual([`/user/gpg_keys/${String(701)}`]);
      expect(github.registered).toHaveLength(0);
      expect(await world.sealed.keys?.get(`${ACCOUNT}:gpg` as never)).toBeUndefined();
      expect(existsSync(`${world.runFolder.path}/${ACCOUNT}.gnupg`)).toBe(false);
      const after = (await world.request('GET', '/v1/git-accounts')).json<GitAccount[]>();
      expect(after[0]?.keys.signing).toBeUndefined();
    } finally {
      await world.host.stop();
    }
  }, 90_000);

  test('a key that needs a passphrase cannot sign for a ferret: refused, nothing left sealed or registered', async () => {
    const { github, world } = await setup('passphrase');
    try {
      const mine = strangerHome('passphrase-author');
      const run = (args: string[]) =>
        spawnSync('gpg', args, { encoding: 'utf8', env: bareEnv(world.home, { GNUPGHOME: mine }) });
      expect(
        run([
          '--batch',
          '--pinentry-mode',
          'loopback',
          '--passphrase',
          'correct horse',
          '--quick-generate-key',
          'P <p@example.test>',
          'ed25519',
          'cert,sign',
          'never',
        ]).status,
      ).toBe(0);
      const block = spawnSync(
        'gpg',
        ['--batch', '--pinentry-mode', 'loopback', '--passphrase', 'correct horse', '--armor', '--export-secret-keys'],
        { encoding: 'utf8', env: bareEnv(world.home, { GNUPGHOME: mine }) },
      ).stdout;
      const answer = await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, {
        purpose: 'signing',
        format: 'gpg',
        keyBlock: block,
      });
      expect(answer.status).toBe(400);
      expect(answer.body).not.toContain('PRIVATE KEY');
      expect(github.registered).toHaveLength(0);
      expect(await world.sealed.keys?.get(`${ACCOUNT}:gpg` as never)).toBeUndefined();
      expect(readdirSync(world.runFolder.path).filter(name => name.endsWith('.gnupg'))).toEqual([]);
    } finally {
      await world.host.stop();
    }
  }, 90_000);

  test('GitHub refusing the key (422 and not listed) is a 409 and leaves nothing behind; one the account already lists is recorded and never deleted by us', async () => {
    const { github, world } = await setup('refusals');
    try {
      github.refuse = 422;
      const refused = await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, {
        purpose: 'signing',
        format: 'gpg',
      });
      expect(refused.status).toBe(409);
      expect(await world.sealed.keys?.get(`${ACCOUNT}:gpg` as never)).toBeUndefined();
      const none = (await world.request('GET', '/v1/git-accounts')).json<GitAccount[]>();
      expect(none[0]?.keys.signing).toBeUndefined();

      // The account already lists it: found by the key id (the last sixteen digits of the fingerprint). It is recorded
      // without GitHub's id, so removing it here never deletes what was not ours to delete.
      github.refuse = undefined;
      github.alreadyHolds = true;
      const held = await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, {
        purpose: 'signing',
        format: 'gpg',
      });
      expect(held.status).toBe(200);
      const after = (await world.request('GET', '/v1/git-accounts')).json<GitAccount[]>();
      expect(after[0]?.keys.signing?.githubKeyId).toBeUndefined();
      expect(after[0]?.keys.signing?.format).toBe('gpg');
      await world.request('DELETE', `/v1/git-accounts/${ACCOUNT}/keys/signing`);
      expect(github.deleted).toEqual([]);
    } finally {
      await world.host.stop();
    }
  }, 90_000);

  test('a second request while a signing key exists is refused; the same request again answers what is there', async () => {
    const { github, world } = await setup('twice');
    try {
      const first = GitGpgKeyResultSchema.parse(
        (await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'signing', format: 'gpg' })).json(),
      );
      const again = GitGpgKeyResultSchema.parse(
        (await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'signing', format: 'gpg' })).json(),
      );
      expect(again.fingerprint).toBe(first.fingerprint);
      expect(github.registered).toHaveLength(1);
      const ssh = await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'signing' });
      expect(ssh.status).toBe(409);
    } finally {
      await world.host.stop();
    }
  }, 90_000);

  test('removing the account deletes the key at GitHub and drops the sealed secret and the home', async () => {
    const { github, world } = await setup('account-gone');
    try {
      await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'signing', format: 'gpg' });
      const port = world.host.provided(GitAccountsPort);
      expect((await port.list())[0]?.keys.signing?.format).toBe('gpg');
      await world.request('DELETE', `/v1/git-accounts/${ACCOUNT}`);
      expect(github.deleted).toEqual(['/user/gpg_keys/701']);
      expect(await world.sealed.keys?.get(`${ACCOUNT}:gpg` as never)).toBeUndefined();
      expect(existsSync(`${world.runFolder.path}/${ACCOUNT}.gnupg`)).toBe(false);
    } finally {
      await world.host.stop();
    }
  }, 90_000);

  test.skipIf(!HAVE_SSH)(
    'a push key and a GPG signing key side by side: ssh pushes, gpg signs, and removing the push key keeps the signing key working',
    async () => {
      const { github, world, project } = await setup('both');
      try {
        expect((await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'auth' })).status).toBe(200);
        const gpg = GitGpgKeyResultSchema.parse(
          (
            await world.request('POST', `/v1/git-accounts/${ACCOUNT}/keys`, { purpose: 'signing', format: 'gpg' })
          ).json(),
        );
        const env = await paneEnvFor(world, project.path);
        const settings = new Map(settingsOf(env));
        expect(settings.get('gpg.format')).toBe('openpgp');
        expect(settings.get('user.signingkey')).toBe(gpg.fingerprint);
        expect(settings.get('core.sshCommand')).toContain('IdentityAgent=');
        expect(env['SSH_AUTH_SOCK']).toBeDefined();
        expect(env['GNUPGHOME']).toBeDefined();
        const git = gitIn(project.path, world.home, env);
        git(['init', '-q', '-b', 'main']);
        expect(git(['commit', '--allow-empty', '-q', '-m', 'both']).status).toBe(0);
        expect(git(['verify-commit', 'HEAD']).status).toBe(0);

        // The push key goes; its sealed private half goes with it, and the GPG key is untouched.
        expect((await world.request('DELETE', `/v1/git-accounts/${ACCOUNT}/keys/auth`)).status).toBe(200);
        expect(await world.sealed.keys?.get(ACCOUNT as never)).toBeUndefined();
        expect(await world.sealed.keys?.get(`${ACCOUNT}:gpg` as never)).toContain('PRIVATE KEY BLOCK');
        const left = (await world.request('GET', '/v1/git-accounts')).json<GitAccount[]>();
        expect(left[0]?.keys.ssh).toBeUndefined();
        expect(left[0]?.keys.signing?.format).toBe('gpg');
        expect(github.registered).toHaveLength(1);
        const after = await paneEnvFor(world, project.path);
        expect(after['SSH_AUTH_SOCK']).toBeUndefined();
        expect(gitIn(project.path, world.home, after)(['commit', '--allow-empty', '-q', '-m', 'after']).status).toBe(0);
      } finally {
        await world.host.stop();
        for (const child of world.real.children) child.kill('SIGKILL');
      }
    },
    90_000,
  );
});
