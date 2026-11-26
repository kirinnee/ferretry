import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testHost } from '@ferretry/kernel/testing';
import { FakeSealedDocuments } from '@ferretry/core-vault/contract/testing';
import { FakeGate } from '@ferretry/core-gate/contract/testing';
import { gitAccountsDaemon } from '../../daemon/index.ts';
import { ghHost } from './gh-host.ts';
import { testClient, tmpRunFolder } from './run-folder.ts';
import { rootGhShimFolder } from '../../daemon/adapters/run-folder.ts';
import { shimScript } from '../../daemon/features/gh-shim/shim.ts';
import { nodeFs } from '@ferretry/kernel/host';
import { rootsPortFor } from '../../../../core/kernel/host/roots.ts';
import type { LaunchPartSource } from '@ferretry/core-ferrets/contract';
import type { PathsPort } from '@ferretry/kernel/contract';
import { bindProgram } from '../../../../core/kernel/host/paths.ts';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of clean.splice(0).reverse()) await undo();
});
const scratch = () => {
  const path = mkdtempSync(join(tmpdir(), 'g21-security-'));
  clean.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
async function source(clients: string[], folder = tmpRunFolder(), linked = true, binding?: PathsPort['bindProgram']) {
  clean.push(() => folder.destroy());
  let parts: () => Promise<unknown> = async () => undefined;
  let ghSource: LaunchPartSource;
  const impl = gitAccountsDaemon({ runFolder: folder });
  const wrapped = {
    ...impl,
    build: (ctx: never) => {
      const built = impl.build?.(ctx) as {
        hooks: { 'launch.parts': () => readonly { id: string; item: { parts(spec: object): Promise<unknown> } }[] };
      };
      const source = built.hooks['launch.parts']().find(item => item.id === 'git-accounts-gh');
      if (source === undefined) throw new Error('missing GitHub launch source');
      ghSource = source.item as LaunchPartSource;
      parts = () => source.item.parts({ folder: '/synthetic-project' });
      return built;
    },
  };
  const host = await testHost({
    plugins: [wrapped as never],
    ...ghHost(
      [`${folder.path}/shims`, ...clients.map(path => path.slice(0, path.lastIndexOf('/')))].join(':'),
      clients,
    ),
    // Use production trust: these clients are planted fixture files, not synthetic installed clients.
    bindProgram: binding,
    fakes: { sealed: new FakeSealedDocuments(), gate: new FakeGate() },
    uses: {
      projects: {
        list: async () =>
          linked
            ? [
                {
                  id: 'synthetic',
                  name: 'synthetic',
                  path: '/synthetic-project',
                  accounts: ['gha_4242'],
                  source: 'existing-folder',
                  createdAt: '2026-11-19T00:00:00.000Z',
                },
              ]
            : [],
      },
    },
    spawn: () => ({ exitCode: 1, signal: null, stdout: '', stderr: '' }),
  });
  clean.push(() => host.stop());
  return {
    parts: () => parts(),
    folder,
    required: () => ghSource.required,
  };
}

test('MUST 1: a planted client earlier on daemon PATH is refused without executing it', async () => {
  const bin = scratch();
  const marker = join(bin, 'executed');
  const client = join(bin, 'fy');
  writeFileSync(client, `#!/bin/sh\nprintf executed > '${marker}'\n`, { mode: 0o755 });
  const run = await source([client, '/synthetic-installed/fy']);
  await expect(run.parts()).rejects.toThrow('GitHub client unavailable');
  expect(run.required()).toBe(true);
  expect(existsSync(marker)).toBe(false);
});

test('MUST 3: failed discovery with an old shim on the inherited PATH refuses the launch', async () => {
  const folder = tmpRunFolder();
  const marker = join(folder.path, 'old-shim-executed');
  mkdirSync(join(folder.path, 'shims'));
  writeFileSync(join(folder.path, 'shims/gh'), `#!/bin/sh\nprintf executed > '${marker}'\n`, { mode: 0o755 });
  const run = await source([], folder);
  await expect(run.parts()).rejects.toThrow('GitHub client unavailable');
  expect(run.required()).toBe(true);
  expect(existsSync(marker)).toBe(false);
});

test('S1: an unlinked project keeps a closed GH_CONFIG_DIR when client discovery fails', async () => {
  const run = await source([], tmpRunFolder(), false);
  expect(await run.parts()).toEqual([
    { kind: 'pane-env', plugin: 'git-accounts', env: { GH_CONFIG_DIR: `${run.folder.path}/pane-gh-config` } },
  ]);
  expect(readdirSync(join(run.folder.path, 'pane-gh-config'))).toEqual([]);
  expect(statSync(join(run.folder.path, 'pane-gh-config')).mode & 0o777).toBe(0o500);
});

test('S1: failed shim publication still empties and closes the unlinked pane config', async () => {
  const folder = tmpRunFolder();
  await folder.emptyDirectory('pane-gh-config', 0o700);
  writeFileSync(join(folder.path, 'pane-gh-config/hosts.yml'), 'synthetic-stale-sign-in');
  folder.publish = async () => {
    throw new Error('synthetic publication failure');
  };
  const run = await source(['/synthetic-installed/fy'], folder, false, async path => testClient(path));
  expect(await run.parts()).toEqual([
    { kind: 'pane-env', plugin: 'git-accounts', env: { GH_CONFIG_DIR: `${folder.path}/pane-gh-config` } },
  ]);
  expect(readdirSync(join(folder.path, 'pane-gh-config'))).toEqual([]);
  expect(statSync(join(folder.path, 'pane-gh-config')).mode & 0o777).toBe(0o500);
});

test('S1: an unlinked launch refuses when the closed config itself cannot be prepared', async () => {
  const folder = tmpRunFolder();
  folder.emptyDirectory = async () => {
    throw new Error('synthetic config failure');
  };
  const run = await source([], folder, false);
  await expect(run.parts()).rejects.toThrow('synthetic config failure');
});

test('R1: a linked pane uses the user-owned ~/.local/bin client beside its running daemon', async () => {
  const home = scratch();
  const bin = join(home, '.local/bin');
  mkdirSync(bin, { recursive: true });
  const client = join(bin, 'fy');
  const daemon = join(bin, 'fyd');
  writeFileSync(client, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  writeFileSync(daemon, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const run = await source([client], tmpRunFolder(), true, path =>
    bindProgram(
      nodeFs(() => crypto.randomUUID()),
      path,
      { executable: daemon, client: 'fy', daemon: 'fyd' },
    ),
  );
  expect(await run.parts()).toHaveLength(2);
  const result = Bun.spawnSync([join(run.folder.path, 'shims/gh'), 'pr', 'list'], {
    env: { HOME: home, PATH: '/absent' },
  });
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('gh\n--\npr\nlist\n');
  // The verifier runs inside the pane. Its Bun runtime must ignore project/home preload configuration and options.
  const marker = join(home, 'preload-executed');
  const preload = join(home, 'preload.js');
  writeFileSync(preload, `await Bun.write(${JSON.stringify(marker)}, 'must not execute'); process.exit(99);`);
  for (const name of ['bunfig.toml', '.bunfig.toml'])
    writeFileSync(join(home, name), `preload = [${JSON.stringify(preload)}]\n`);
  const configured = Bun.spawnSync([join(run.folder.path, 'shims/gh'), 'pr', 'list'], {
    cwd: home,
    env: { HOME: home, PATH: '/absent', BUN_OPTIONS: `--preload=${preload}`, NODE_OPTIONS: `--require=${preload}` },
  });
  expect(configured.exitCode).toBe(0);
  expect(existsSync(marker)).toBe(false);
});

test('MUST 1: a replacement after preflight never executes with the pane credential environment', async () => {
  const bin = scratch();
  const client = join(bin, 'fy');
  const marker = join(bin, 'executed');
  writeFileSync(client, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const binding = await bindProgram(
    nodeFs(() => crypto.randomUUID()),
    client,
    {
      executable: client,
      client: 'fy',
      daemon: 'fyd',
    },
  );
  expect(binding).toBeDefined();
  const shim = join(bin, 'gh');
  writeFileSync(shim, shimScript(binding!), { mode: 0o755 });
  const replacement = join(bin, 'replacement');
  writeFileSync(replacement, `#!/bin/sh\nprintf '%s' "$FY_SESSION_TOKEN" > '${marker}'\n`, { mode: 0o755 });
  renameSync(replacement, client);
  const result = Bun.spawnSync([shim, 'pr', 'list'], {
    env: { FY_SESSION_TOKEN: 'synthetic-pane-credential', PATH: '/nonexistent' },
  });
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain('GitHub client unavailable');
  expect(existsSync(marker)).toBe(false);
});

function managed() {
  const home = scratch();
  const downloads = join(home, 'state/git-accounts/downloads');
  mkdirSync(downloads, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, 'state/git-accounts/agent-homes'), { mode: 0o700 });
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home, plugin: 'git-accounts', worktrees: `${home}-worktrees` },
    ['downloads', 'agent-homes'],
    () => undefined,
    { setMode: true },
  );
  return { folder: rootGhShimFolder(roots), downloads };
}

test('MUST 2: symlinked siblings in downloads cannot redirect shim publication or config cleanup', async () => {
  const { folder, downloads } = managed();
  const sibling = join(downloads, 'sibling');
  mkdirSync(sibling);
  writeFileSync(join(sibling, 'keep'), 'sibling-fixture');
  symlinkSync(sibling, join(downloads, 'shims'));
  symlinkSync(sibling, join(downloads, 'pane-gh-config'));
  expect(await folder.isPrivate()).toBe(true);
  await folder.publish('shims/gh', 'managed-shim', 0o755);
  expect(readdirSync(sibling)).toEqual(['keep']);
  await folder.emptyDirectory('pane-gh-config', 0o500);
  expect(readdirSync(sibling)).toEqual(['keep']);
  expect(readFileSync(join(sibling, 'keep'), 'utf8')).toBe('sibling-fixture');
  expect(readFileSync(join(folder.path, 'shims/gh'), 'utf8')).toBe('managed-shim');
  expect(statSync(join(folder.path, 'pane-gh-config')).mode & 0o777).toBe(0o500);
});

test('MUST 2: config swapped after listing stays confined to the held managed directory', async () => {
  const { folder } = managed();
  expect(await folder.isPrivate()).toBe(true);
  await folder.emptyDirectory('pane-gh-config', 0o500);
  const config = join(folder.path, 'pane-gh-config');
  const sibling = join(folder.path, 'sibling');
  mkdirSync(sibling);
  writeFileSync(join(sibling, 'same-name'), 'keep-sibling');
  chmodSync(config, 0o700);
  writeFileSync(join(config, 'same-name'), 'remove-managed');
  const disk = nodeFs(() => crypto.randomUUID());
  const home = folder.path.slice(0, folder.path.indexOf('/state/'));
  let swapped = false;
  const roots = rootsPortFor(
    {
      ...disk,
      list: async path => {
        const names = await disk.list(path);
        if (!swapped && names.includes('same-name')) {
          swapped = true;
          renameSync(config, `${config}-held`);
          symlinkSync(sibling, config);
        }
        return names;
      },
    },
    { home, plugin: 'git-accounts', worktrees: `${home}-worktrees` },
    ['downloads', 'agent-homes'],
    () => undefined,
    { setMode: true },
  );
  const raced = rootGhShimFolder(roots);
  await raced.emptyDirectory('pane-gh-config', 0o500).catch(() => undefined);
  expect(swapped).toBe(true);
  expect(readFileSync(join(sibling, 'same-name'), 'utf8')).toBe('keep-sibling');
});

test('MUST 2: symlinked managed bases are refused even when the target is a sibling', async () => {
  const { folder } = managed();
  await folder.isPrivate();
  const sibling = join(folder.path, 'sibling');
  mkdirSync(sibling);
  writeFileSync(join(sibling, 'keep'), 'keep');
  symlinkSync(sibling, join(folder.path, 'shims'));
  symlinkSync(sibling, join(folder.path, 'pane-gh-config'));
  await expect(folder.publish('shims/gh', 'must-not-land', 0o755)).rejects.toThrow();
  await expect(folder.emptyDirectory('pane-gh-config', 0o500)).rejects.toThrow();
  expect(readdirSync(sibling)).toEqual(['keep']);
});
