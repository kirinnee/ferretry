import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import type { SealedDocumentHandle } from '@ferretry/core-vault/contract';
import type { LaunchPart, LaunchSpec } from '@ferretry/core-ferrets/contract';
import type { ProjectInfo } from '@ferretry/plugin-projects/contract';
import type { GitAccount } from '../../contract/index.ts';
import { accountForFolder } from '../../daemon/lib/account-for-folder.ts';
import {
  type AccountKit,
  gitEnvironment,
  noIdentityEnvironment,
  noreplyEmail,
  sshCommand,
} from '../../daemon/features/launch/environment.ts';
import { accountLaunchParts } from '../../daemon/features/launch/parts.ts';
import { AgentSupervisor, type RunFolder } from '../../daemon/features/ssh-keys/agents.ts';
import { SshKeyService } from '../../daemon/features/ssh-keys/service.ts';
import { tmpRunFolder } from './run-folder.ts';

const account = (id: number, login: string, extra: Partial<GitAccount> = {}): GitAccount => ({
  id: `gha_${String(id)}` as GitAccount['id'],
  provider: 'github',
  githubId: id,
  login,
  scopes: [],
  keys: {},
  createdAt: '2026-11-19T00:00:00.000Z',
  ...extra,
});
const project = (path: string, extra: Partial<ProjectInfo> = {}): ProjectInfo =>
  ({
    id: `00000000-0000-4000-8000-${String(path.length).padStart(12, '0')}`,
    name: path,
    path,
    source: 'existing-folder',
    createdAt: '2026-11-19T00:00:00.000Z',
    ...extra,
  }) as ProjectInfo;

const KIT: AccountKit = {
  socket: '/run/fy/gha_1.sock',
  publicKeyFile: '/run/fy/gha_1.pub',
  knownHosts: '/run/fy/known_hosts',
  auth: true,
  signing: true,
};
const everyone = () => true;

describe('which account a folder pushes as (one resolver)', () => {
  const a = account(1, 'alice');
  test('the folder is inside a project: the project’s FIRST linked account', () => {
    const projects = [project('/work/app', { accounts: [a.id, 'gha_2'] })];
    expect(accountForFolder('/work/app', projects, everyone)?.account).toBe(a.id);
    expect(accountForFolder('/work/app/packages/x', projects, everyone)?.account).toBe(a.id);
    expect(accountForFolder('/work/app/', projects, everyone)?.account).toBe(a.id);
  });
  test('outside every project, or a sibling that only shares a prefix: nothing', () => {
    const projects = [project('/work/app', { accounts: [a.id] })];
    expect(accountForFolder('/work/app-two', projects, everyone)).toBeUndefined();
    expect(accountForFolder('/work', projects, everyone)).toBeUndefined();
    expect(accountForFolder('/elsewhere', projects, everyone)).toBeUndefined();
  });
  test('a project with no linked account gives nothing', () => {
    expect(accountForFolder('/work/app', [project('/work/app')], everyone)).toBeUndefined();
  });
  test('the repository the folder is in names its own account over the project’s', () => {
    const projects = [
      project('/work/app', {
        accounts: ['gha_1'],
        repos: [{ path: 'api', account: 'gha_2' }, { path: 'web' }, { path: 'api/vendor/lib', account: 'gha_3' }],
      }),
    ];
    expect(accountForFolder('/work/app/api/src', projects, everyone)?.account).toBe('gha_2');
    expect(accountForFolder('/work/app/api/vendor/lib/x', projects, everyone)?.account).toBe('gha_3');
    expect(accountForFolder('/work/app/web', projects, everyone)?.account).toBe('gha_1');
    expect(accountForFolder('/work/app', projects, everyone)?.account).toBe('gha_1');
  });
  test('the longest project wins when projects nest', () => {
    const projects = [project('/work', { accounts: ['gha_1'] }), project('/work/inner', { accounts: ['gha_2'] })];
    expect(accountForFolder('/work/inner/x', projects, everyone)?.account).toBe('gha_2');
    expect(accountForFolder('/work/other', projects, everyone)?.account).toBe('gha_1');
  });
  test('an account that no longer exists is never swapped for another', () => {
    const projects = [
      project('/work/app', { accounts: ['gha_1', 'gha_2'], repos: [{ path: 'api', account: 'gha_9' }] }),
    ];
    const exists = (id: string) => id !== 'gha_1' && id !== 'gha_9';
    expect(accountForFolder('/work/app', projects, exists)).toBeUndefined();
    expect(accountForFolder('/work/app/api', projects, exists)).toBeUndefined();
  });
});

describe('what the ferret is handed', () => {
  const a = account(4242, 'octo-fake', { name: 'Octo Fake' });
  const config = (env: Readonly<Record<string, string>>) =>
    Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [
      env[`GIT_CONFIG_KEY_${String(i)}`],
      env[`GIT_CONFIG_VALUE_${String(i)}`],
    ]);

  test('the noreply address, the signing settings, the agent socket and the pinned ssh command', () => {
    const env = gitEnvironment(a, KIT);
    expect(env.SSH_AUTH_SOCK).toBe('/run/fy/gha_1.sock');
    expect(config(env)).toEqual([
      ['user.name', 'Octo Fake'],
      ['user.email', '4242+octo-fake@users.noreply.github.com'],
      ['gpg.format', 'ssh'],
      ['user.signingkey', '/run/fy/gha_1.pub'],
      ['commit.gpgsign', 'true'],
      ['tag.gpgsign', 'true'],
      [
        'core.sshCommand',
        'ssh -F none -o IdentitiesOnly=yes -o IdentityFile=/run/fy/gha_1.pub -o IdentityAgent=/run/fy/gha_1.sock -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/run/fy/known_hosts -o GlobalKnownHostsFile=none',
      ],
      ['url.git@github.com:.insteadOf', 'https://github.com/'],
    ]);
    expect(Object.keys(env).sort()).toEqual(
      [
        'GIT_CONFIG_COUNT',
        ...config(env).flatMap((_, i) => [`GIT_CONFIG_KEY_${String(i)}`, `GIT_CONFIG_VALUE_${String(i)}`]),
        'SSH_AUTH_SOCK',
      ].sort(),
    );
  });

  test('a key registered only for signing sets no push rewrite; one only for pushing signs nothing', () => {
    const signingOnly = config(gitEnvironment(a, { ...KIT, auth: false })).map(([key]) => key);
    expect(signingOnly).not.toContain('core.sshCommand');
    expect(signingOnly).not.toContain('url.git@github.com:.insteadOf');
    expect(signingOnly).toContain('commit.gpgsign');
    const authOnly = config(gitEnvironment(a, { ...KIT, signing: false })).map(([key]) => key);
    expect(authOnly).not.toContain('commit.gpgsign');
    expect(authOnly).not.toContain('user.signingkey');
    expect(authOnly).toContain('core.sshCommand');
  });

  test('a name with control characters, or none, is made plain; the login stands in', () => {
    expect(config(gitEnvironment(account(1, 'zed', { name: 'Zed\nEvil=1' }), KIT))[0]).toEqual([
      'user.name',
      'Zed Evil=1',
    ]);
    expect(config(gitEnvironment(account(1, 'zed'), KIT))[0]).toEqual(['user.name', 'zed']);
    expect(noreplyEmail(account(7, 'x'))).toBe('7+x@users.noreply.github.com');
  });

  test('a path with a space or a quote is one shell word', () => {
    const odd = sshCommand({ ...KIT, socket: "/Users/o n'e/a.sock" });
    expect(odd).toContain("-o IdentityAgent='/Users/o n'\\''e/a.sock'");
    expect(odd.startsWith('ssh -F none -o IdentitiesOnly=yes ')).toBe(true);
  });

  test('nothing in it is key material or a token', () => {
    const text = JSON.stringify(gitEnvironment(a, KIT));
    expect(text).not.toMatch(/PRIVATE|BEGIN|gho_|GH_TOKEN|GITHUB_TOKEN/u);
    expect(
      Object.keys(gitEnvironment(a, KIT)).every(name => /^(SSH_AUTH_SOCK|GIT_CONFIG_[A-Z_0-9]+)$/u.test(name)),
    ).toBe(true);
  });
});

describe('the launch source', () => {
  const a = account(1, 'alice');
  const b = account(2, 'bob');
  const spec = (folder: string) => ({ folder }) as unknown as Omit<LaunchSpec, 'parts' | 'credential'>;
  function source(
    projects: readonly ProjectInfo[],
    kits: Record<string, AccountKit | undefined> = { gha_1: KIT, gha_2: { ...KIT, socket: '/run/fy/gha_2.sock' } },
  ) {
    const asked: string[] = [];
    return {
      asked,
      source: accountLaunchParts({
        projects: async () => projects,
        accounts: async () => [a, b],
        kit: async id => {
          asked.push(id);
          return kits[id];
        },
      }),
    };
  }
  const envOf = (parts: readonly LaunchPart[]) => parts.flatMap(part => (part.kind === 'pane-env' ? [part.env] : []));

  test('a launch inside a linked project gets the env, a launch outside gets none (and no agent is started for it)', async () => {
    const world = source([project('/work/app', { accounts: ['gha_1'] })]);
    const inside = await world.source.parts(spec('/work/app/src'));
    expect(inside).toHaveLength(1);
    expect(inside[0]).toMatchObject({ kind: 'pane-env', plugin: 'git-accounts' });
    expect(envOf(inside)[0]?.SSH_AUTH_SOCK).toBe('/run/fy/gha_1.sock');
    expect(await world.source.parts(spec('/elsewhere'))).toEqual([]);
    expect(world.asked).toEqual(['gha_1']);
  });

  test('two accounts on two projects get two sockets', async () => {
    const world = source([project('/work/a', { accounts: ['gha_1'] }), project('/work/b', { accounts: ['gha_2'] })]);
    const one = envOf(await world.source.parts(spec('/work/a')))[0];
    const two = envOf(await world.source.parts(spec('/work/b')))[0];
    expect([one?.SSH_AUTH_SOCK, two?.SSH_AUTH_SOCK]).toEqual(['/run/fy/gha_1.sock', '/run/fy/gha_2.sock']);
    expect(one?.GIT_CONFIG_VALUE_1).toBe('1+alice@users.noreply.github.com');
    expect(two?.GIT_CONFIG_VALUE_1).toBe('2+bob@users.noreply.github.com');
  });

  test('an account with no key Ferretry made, or a project the registry does not know, gives nothing', async () => {
    expect(
      await source([project('/work/app', { accounts: ['gha_1'] })], { gha_1: undefined }).source.parts(
        spec('/work/app'),
      ),
    ).toEqual([]);
    expect(
      await source([project('/work/app', { accounts: ['gha_1'] })], {
        gha_1: { ...KIT, auth: false, signing: false },
      }).source.parts(spec('/work/app')),
    ).toEqual([]);
    expect(await source([]).source.parts(spec('/work/app'))).toEqual([]);
    expect(await source([project('/work/app', { accounts: ['gha_77'] })]).source.parts(spec('/work/app'))).toEqual([]);
  });
});

describe('a key that cannot be started says so in the pane, and runs with no identity', () => {
  const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPUBLICPUBLICPUBLICPUBLICPUBLICPUBLICPUBLICPUBLIC';
  const made = (source: 'generated' | 'own'): GitAccount['keys'] => ({
    ssh: { title: 't', publicKey: PUB, source },
    signing: { title: 't', publicKey: PUB, source },
  });
  const launch = (who: GitAccount, kit: () => Promise<AccountKit | undefined>) =>
    accountLaunchParts({
      projects: async () => [project('/work/app', { accounts: ['gha_1'] })],
      accounts: async () => [who],
      kit,
    }).parts({ folder: '/work/app' } as unknown as Omit<LaunchSpec, 'parts' | 'credential'>);
  const config = (parts: readonly LaunchPart[]): Record<string, string> => {
    const env = parts.flatMap(part => (part.kind === 'pane-env' ? [part.env] : []))[0] ?? {};
    return Object.fromEntries(
      Array.from({ length: Number(env.GIT_CONFIG_COUNT ?? 0) }, (_, i) => [
        env[`GIT_CONFIG_KEY_${String(i)}`] as string,
        env[`GIT_CONFIG_VALUE_${String(i)}`] as string,
      ]),
    );
  };

  test('the kit throws: the "key unavailable" sentence, and git is given no identity at all (no agent, no key file, no https)', async () => {
    const parts = await launch(account(1, 'alice', { keys: made('generated') }), async () => {
      throw new Error('ssh-agent did not start');
    });
    const text = parts.flatMap(part => (part.kind === 'instruction' ? [part.text] : [])).join('\n');
    expect(text).toContain('Git account key for this project is unavailable');
    expect(text).toContain('given no identity at all');
    expect(text).not.toContain('did not start');
    const settings = config(parts);
    expect(settings['core.sshCommand']).toContain('IdentityAgent=none');
    expect(settings['core.sshCommand']).toContain('IdentityFile=/dev/null');
    expect(settings['core.sshCommand']).toContain('IdentitiesOnly=yes');
    expect(settings['url.git@github.com:.insteadOf']).toBe('https://github.com/');
    expect([settings['commit.gpgsign'], settings['tag.gpgsign']]).toEqual(['false', 'false']);
    // Nothing of the account's own key is handed over, and no socket is named.
    expect(JSON.stringify(parts)).not.toContain('.sock');
    expect(JSON.stringify(parts)).not.toContain('.pub');
  });

  test('a key that is RECORDED but whose sealed entry is gone is that same case through the real key service', async () => {
    const folder = tmpRunFolder();
    const started: string[] = [];
    const agents = new AgentSupervisor(
      {
        run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
        start: (_program: string, args: readonly string[]) => {
          started.push(args.at(-1) as string);
          throw new Error('an agent must not start without a key');
        },
      },
      folder,
      { after: () => () => undefined, sleep: () => new Promise<void>(() => undefined) },
      { warn: () => undefined },
    );
    const who = account(1, 'alice', { keys: made('generated') });
    const service = new SshKeyService(
      {
        find: async () => who,
        api: async () => {
          throw new Error('not used');
        },
        recordKeys: async () => undefined,
      },
      { get: async () => undefined } as unknown as SealedDocumentHandle,
      agents,
      () => 'machine',
    );
    await expect(service.launchKit(who.id)).rejects.toMatchObject({ status: 503, code: 'agent_unavailable' });
    const parts = await launch(who, () => service.launchKit(who.id));
    expect(parts.some(part => part.kind === 'instruction' && part.id === 'git-accounts-key-unavailable')).toBe(true);
    expect(config(parts)['core.sshCommand']).toContain('IdentityAgent=none');
    expect(started).toEqual([]);
    folder.destroy();
  });

  test('an account with no generated key (none, or the person’s own) keeps today’s launch: nothing, and no warning', async () => {
    for (const keys of [{}, made('own')]) {
      const who = account(1, 'alice', { keys });
      const service = new SshKeyService(
        { find: async () => who, api: async () => undefined as never, recordKeys: async () => undefined },
        { get: async () => undefined } as unknown as SealedDocumentHandle,
        {} as AgentSupervisor,
        () => 'machine',
      );
      expect(await service.launchKit(who.id)).toBeUndefined();
      expect(await launch(who, () => service.launchKit(who.id))).toEqual([]);
    }
  });

  test('git itself reads the no-identity command as: no agent, only /dev/null as an identity file, no default key', async () => {
    const ssh = Bun.which('ssh');
    if (ssh === null) return;
    const env = noIdentityEnvironment(account(1, 'alice', { keys: made('generated') }));
    const command = env.GIT_CONFIG_VALUE_0 as string;
    const run = Bun.spawnSync([ssh, ...command.split(' ').slice(1), '-G', 'github.com'], {
      env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent-fy-home' },
    });
    const effective = new TextDecoder().decode(run.stdout);
    expect(effective).toContain('identityagent none');
    expect(effective).toContain('identitiesonly yes');
    expect(effective).toContain('identityfile /dev/null');
    expect(effective).not.toMatch(/identityfile .*id_(ed25519|rsa|ecdsa)/u);
  });
});

describe('the key service hands a launch its kit, and brings the agents back at boot', () => {
  const PUBLIC = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPUBLICPUBLICPUBLICPUBLICPUBLICPUBLICPUBLICPUBLIC';
  const generated = (): GitAccount['keys'] => ({
    ssh: { title: 't', publicKey: PUBLIC, source: 'generated' },
    signing: { title: 't', publicKey: PUBLIC, source: 'generated' },
  });
  function world(accounts: readonly GitAccount[], folderOverrides: Partial<RunFolder> = {}) {
    const folder = Object.assign(tmpRunFolder(), folderOverrides);
    const started: string[] = [];
    const empty = () => new ReadableStream<Uint8Array>({ start: c => c.close() });
    const tools = {
      run: async (_program: string, args: readonly string[]) => ({
        exitCode: args[0] === '-' ? 0 : 1,
        signal: null,
        stdout: '',
        stderr: '',
      }),
      start: (_program: string, args: readonly string[]) => {
        started.push(args.at(-1) as string);
        return {
          pid: 1,
          stdout: empty(),
          stderr: empty(),
          write: () => undefined,
          kill: () => undefined,
          exited: new Promise<number | null>(() => undefined),
          pipes: [],
          closePipes: () => undefined,
        };
      },
    };
    const clock = { after: () => () => undefined, sleep: () => new Promise<void>(() => undefined) };
    const agents = new AgentSupervisor(tools, folder, clock, { warn: () => undefined });
    const sealed = {
      get: async () => JSON.stringify({ privateKey: 'k', publicKey: PUBLIC, fingerprint: 'SHA256:x' }),
    } as unknown as SealedDocumentHandle;
    const service = new SshKeyService(
      {
        find: async id => accounts.find(account => account.id === id),
        api: async () => {
          throw new Error('not used');
        },
        recordKeys: async () => undefined,
      },
      sealed,
      agents,
      () => 'machine',
    );
    return { folder, started, service };
  }

  test('a kit names the socket, a public key file and the pinned known_hosts, in one folder, and says what is registered', async () => {
    const w = world([account(1, 'a', { keys: generated() })]);
    const kit = await w.service.launchKit('gha_1' as GitAccount['id']);
    expect(kit).toEqual({
      socket: `${w.folder.path}/gha_1.sock`,
      publicKeyFile: `${w.folder.path}/gha_1.pub`,
      knownHosts: `${w.folder.path}/known_hosts`,
      auth: true,
      signing: true,
    });
    expect(readFileSync(kit?.publicKeyFile as string, 'utf8')).toBe(`${PUBLIC}\n`);
    expect(readFileSync(kit?.knownHosts as string, 'utf8')).toContain('github.com ssh-ed25519 ');
    expect(statSync(kit?.knownHosts as string).mode & 0o777).toBe(0o600);
    w.folder.destroy();
  });

  test('a key the person already had (the host’s agent holds it), or no key, starts no agent and gives no kit', async () => {
    const own = account(1, 'a', { keys: { ssh: { title: 't', publicKey: PUBLIC, source: 'own' } } });
    const w = world([own, account(2, 'b')]);
    expect(await w.service.launchKit('gha_1' as GitAccount['id'])).toBeUndefined();
    expect(await w.service.launchKit('gha_2' as GitAccount['id'])).toBeUndefined();
    expect(await w.service.launchKit('gha_3' as GitAccount['id'])).toBeUndefined();
    expect(w.started).toEqual([]);
    w.folder.destroy();
  });

  test('at boot every account with a key Ferretry made gets its agent back at its own path; one that fails is only logged', async () => {
    const w = world([account(1, 'a', { keys: generated() }), account(2, 'b', { keys: generated() })]);
    const failed: string[] = [];
    await w.service.warm(['gha_1', 'gha_2'] as GitAccount['id'][], id => failed.push(id));
    expect(w.started).toEqual([`${w.folder.path}/gha_1.sock`, `${w.folder.path}/gha_2.sock`]);
    expect(failed).toEqual([]);
    // An account that is gone, and an agent folder that is not private: logged by id, never thrown, nothing started.
    await w.service.warm(['gha_9'] as GitAccount['id'][], id => failed.push(id));
    expect(failed).toEqual([]);
    const open = world([account(1, 'a', { keys: generated() })], { isPrivate: async () => false });
    await open.service.warm(['gha_1'] as GitAccount['id'][], id => failed.push(id));
    expect(failed).toEqual(['gha_1']);
    expect(open.started).toEqual([]);
    open.folder.destroy();
    w.folder.destroy();
  });
});
