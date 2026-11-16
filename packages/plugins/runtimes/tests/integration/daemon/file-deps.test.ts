/**
 * The catalogue's and the setup's collaborators over a real fleet folder (the kernel's real `fleet` and `harness-home`
 * roots over a temp directory): what each one reads and writes there, and the one claim the clone record is updated under.
 * Nothing here reads a real home.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeLogins } from '@ferretry/plugin-logins/contract/testing';
import { fileFleetCatalogDeps } from '../../../daemon/adapters/account-model-files.ts';
import { CommandCache } from '../../../daemon/adapters/command-cache.ts';
import { cloneConfigFilesOver, fileFleetSetupDeps } from '../../../daemon/adapters/setup-files.ts';
import type { ConfigFileService } from '../../../daemon/adapters/ports.ts';
import { fleetHost } from '../../../daemon/host-assembly.ts';
import { FleetPublication } from '../../../daemon/lib/service/publication.ts';
import { cleanupWorlds, fleetWorld, type FleetWorld } from '../../unit/support/fleet-world.ts';
import { kernelOver } from '../support/kernel-over.ts';

const tools: string[] = [];
afterEach(async () => {
  await cleanupWorlds();
  for (const dir of tools.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A folder holding one real executable, so a command lookup is a real `PATH` search. */
async function binWith(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fy-bin-'));
  tools.push(dir);
  const file = join(dir, name);
  await writeFile(file, '#!/bin/sh\nexit 0\n');
  await chmod(file, 0o755);
  return dir;
}

const catalogOver = async (world: FleetWorld, patch: Partial<Parameters<typeof fileFleetCatalogDeps>[0]> = {}) => {
  const bin = await binWith('present-tool');
  const commands = new CommandCache(
    { which: async name => await Promise.resolve(Bun.which(name, { PATH: bin }) ?? undefined) },
    () => 0,
  );
  await commands.prime(['present-tool', 'absent-tool']);
  const { host, directory } = fleetHost(kernelOver(world).kernel, commands);
  const paths = { home: world.home, fleet: directory, fleetManifest: join(directory, 'manifest.json') };
  const deps = fileFleetCatalogDeps({
    host,
    paths,
    userHome: world.person,
    sessionStatuses: async () => ['running'],
    credentials: { list: async () => ({ format: 1 as const, machine: 'this machine', logins: [] }) },
    loginChanges: {} as never,
    configWriter: { write: async () => undefined },
    locate: () => undefined,
    machineName: () => 'this machine',
    clientName: 'fy',
    config: {} as never,
    sharedHistory: {} as never,
    claudeStatusline: () => 'fy statusline',
    configDirectory: join(world.home, 'config'),
    publication: new FleetPublication(),
    ...patch,
  });
  return { host, directory, deps };
};

describe('the catalogue’s collaborators over the fleet folder', () => {
  it('lays the fleet out under the folder the fleet root names, and hands the clock and the commands through', async () => {
    const world = await fleetWorld();
    const { directory, deps } = await catalogOver(world, { hostCodexHome: '/placeholder/codex-home' });

    expect(deps.layout).toMatchObject({
      fleetDirectory: directory,
      binDirectory: join(directory, 'bin'),
      homesDirectory: join(directory, 'homes'),
      assetsDirectory: join(directory, 'assets'),
      manifestPath: join(directory, 'manifest.json'),
      userHome: world.person,
      defaultHomeDirectories: { claude: join(world.person, '.claude'), codex: join(world.person, '.codex') },
    });
    expect(deps.now()).toBe(1_000);
    expect(deps.fyCommand).toBe('fy');
    expect(deps.hostCodexHome).toBe('/placeholder/codex-home');
    expect(deps.acceptsAutoPermissionMode).toBe(true);
    expect(deps.commandExists('present-tool')).toBe(true);
    expect(deps.commandExists('absent-tool')).toBe(false);
    expect(await deps.sessionStatuses()).toEqual(['running']);
    expect(deps.mint()).toMatch(/^[0-9a-f-]{36}$/u);
    expect(deps.mintId()).toMatch(/^[0-9a-f]{22}$/u);
  });

  it('answers a document’s revision from the file, and the runtime ids only from a readable ids.json', async () => {
    const world = await fleetWorld();
    const { directory, deps } = await catalogOver(world);

    expect(await deps.ids()).toBeUndefined();
    await writeFile(join(directory, 'ids.json'), JSON.stringify({ version: 1, runtimes: {} }));
    expect(await deps.ids()).toEqual({ version: 1, runtimes: {} });
    await writeFile(join(directory, 'ids.json'), '{broken');
    await expect(deps.ids()).rejects.toThrow();
    expect(await deps.documentRevision(join(directory, 'missing.md'))).toMatch(/^absent|^[0-9a-f]{64}$/u);
    await writeFile(join(directory, 'doc.md'), 'hello');
    expect(await deps.documentRevision(join(directory, 'doc.md'))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('reads the published manifest between applies, and none when no apply has published one', async () => {
    const world = await fleetWorld();
    const { directory, deps } = await catalogOver(world);

    expect(await deps.publishedManifest?.()).toBeUndefined();
    const manifest = { version: 1, generatedAt: '2027-01-15T08:00:00.000Z', accounts: [], runtimes: [] };
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    expect(await deps.publishedManifest?.()).toMatchObject({ version: 1, accounts: [], runtimes: [] });
  });

  it('judges the launcher scripts current only while every one on disk holds exactly what the plan would write', async () => {
    const world = await fleetWorld();
    const { directory, deps } = await catalogOver(world);
    const bin = join(directory, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'one'), 'echo one\n');
    const plan = (content: string, outside = false) =>
      ({
        operations: [
          { kind: 'directory', path: bin },
          { kind: 'file', path: join(bin, 'one'), content, mode: 0o700 },
          // A file outside bin/ is not a launcher script and is not compared.
          ...(outside ? [{ kind: 'file', path: join(directory, 'other'), content: 'x', mode: 0o600 }] : []),
        ],
      }) as never;

    expect(await deps.wrappersCurrent?.(plan('echo one\n', true))).toBe(true);
    expect(await deps.wrappersCurrent?.(plan('echo changed\n'))).toBe(false);
    await rm(join(bin, 'one'));
    expect(await deps.wrappersCurrent?.(plan('echo one\n'))).toBe(false);
  });

  it('answers the session records and renames through the records it was given, and none without them', async () => {
    const world = await fleetWorld();
    const renamed: unknown[] = [];
    const { deps } = await catalogOver(world, {
      sessionRecords: {
        sessionRecords: async () => [
          { id: 's1', name: 'First', harness: 'claude', agent: 'work', executable: '/bin/work', status: 'running' },
        ],
        renameSessions: async rename => {
          renamed.push(rename);
          return 2;
        },
      },
    });
    const bare = await catalogOver(world);

    expect(await deps.sessionRecords?.()).toHaveLength(1);
    expect(await deps.renameSessions?.({ from: 'a', to: 'b', fromWrapper: '/a', toWrapper: '/b' })).toBe(2);
    expect(renamed).toHaveLength(1);
    expect(bare.deps.sessionRecords).toBeUndefined();
    expect(bare.deps.renameSessions).toBeUndefined();
  });

  it('applies a plan’s fleet documents through its own provisioner, under the daemon’s publication', async () => {
    const world = await fleetWorld();
    const { directory, deps } = await catalogOver(world);
    const manifest = { version: 1, generatedAt: '2027-01-15T08:00:00.000Z', accounts: [], runtimes: [] };
    const plan = {
      manifest,
      manifestPath: join(directory, 'manifest.json'),
      operations: [{ kind: 'file', path: join(directory, 'assets', 'note.md'), content: 'a note\n', mode: 0o600 }],
    } as never;

    await deps.provisioner.apply(plan, []);

    expect(await readFile(join(directory, 'assets', 'note.md'), 'utf8')).toBe('a note\n');
    expect(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))).toMatchObject({ version: 1 });
  });
});

const setupOver = async (world: FleetWorld, patch: Partial<Parameters<typeof fileFleetSetupDeps>[0]> = {}) => {
  const { host, directory, deps: catalog } = await catalogOver(world);
  const held: { name: string; value: string }[] = [];
  const setup = fileFleetSetupDeps({
    host,
    catalog: { layout: catalog.layout, locate: () => '/bin/claude' } as never,
    logins: fakeLogins(),
    tools: {} as never,
    daemonId: () => 'daemon-1',
    secrets: {
      list: async () => [
        { name: 'GITHUB_TOKEN', createdAt: '2027-01-01T00:00:00.000Z', updatedAt: '2027-01-02T00:00:00.000Z' },
      ],
      put: async (name, value) => {
        held.push({ name, value });
      },
    },
    ...patch,
  });
  return { setup, directory, held };
};

describe('the setup’s collaborators over the fleet folder', () => {
  it('names a secret, holds what it was given and never answers a value', async () => {
    const world = await fleetWorld();
    const { setup, held } = await setupOver(world);

    expect(await setup.secrets.names()).toEqual(['GITHUB_TOKEN']);
    expect(await setup.secrets.held()).toEqual([
      { name: 'GITHUB_TOKEN', createdAt: '2027-01-01T00:00:00.000Z', updatedAt: '2027-01-02T00:00:00.000Z' },
    ]);
    await setup.secrets.put('NEW_SECRET', 'placeholder-value');
    expect(held).toEqual([{ name: 'NEW_SECRET', value: 'placeholder-value' }]);
  });

  it('reads a folder as text and names a file that is not text', async () => {
    const world = await fleetWorld();
    const { setup, directory } = await setupOver(world);
    await mkdir(join(directory, 'assets', 'skills', 'review'), { recursive: true });
    await writeFile(join(directory, 'assets', 'skills', 'review', 'SKILL.md'), 'review');
    await writeFile(join(directory, 'assets', 'skills', 'review', 'blob.bin'), new Uint8Array([0xff, 0xfe, 0xfd]));

    const reading = await setup.readFolder(join(directory, 'assets', 'skills', 'review'));

    expect(reading.files).toEqual([{ path: 'SKILL.md', content: 'review' }]);
    expect(reading.skipped).toEqual([{ path: 'blob.bin', reason: 'it is not text' }]);
    expect(await setup.skillItems()).toEqual(['review']);
    expect(setup.digest('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(setup.randomBytes(16)).toHaveLength(16);
    expect(setup.daemonId()).toBe('daemon-1');
  });

  it('scans the person’s own setup through the harness roots', async () => {
    const world = await fleetWorld();
    await writeFile(join(world.person, '.claude', 'CLAUDE.md'), '# rules\n');
    const { setup } = await setupOver(world);

    const [claude, codex] = await setup.scan();

    expect(claude?.harness).toBe('claude');
    expect(claude?.command).toBe('/bin/claude');
    expect(claude?.instructions).toMatchObject({ kind: 'text', text: '# rules\n' });
    expect(codex?.harness).toBe('codex');
  });

  it('keeps the export keys and the clone record as files of the fleet folder', async () => {
    const world = await fleetWorld();
    const { setup, directory } = await setupOver(world);
    const keys = join(directory, 'setup', 'export-keys.json');
    const base = join(directory, 'setup', 'clone-base.json');

    expect(await setup.exportKeys.read(keys)).toBeUndefined();
    await setup.exportKeys.write(keys, '{"keys":1}');
    expect(await setup.exportKeys.read(keys)).toBe('{"keys":1}');
    expect(await setup.cloneBase.read(base)).toBeUndefined();
  });

  it('updates the clone record under the apply claim, and leaves the claim cleared', async () => {
    const world = await fleetWorld();
    const { setup, directory } = await setupOver(world);
    const base = join(directory, 'setup', 'clone-base.json');
    const seen: (string | undefined)[] = [];

    const first = await setup.cloneBase.update(base, current => {
      seen.push(current);
      return '{"n":1}';
    });
    const second = await setup.cloneBase.update(base, current => {
      seen.push(current);
      return current === undefined ? undefined : '{"n":2}';
    });
    const third = await setup.cloneBase.update(base, current => {
      seen.push(current);
      return undefined;
    });

    expect([first, second, third]).toEqual([true, true, false]);
    expect(seen).toEqual([undefined, '{"n":1}', '{"n":2}']);
    expect(await readFile(base, 'utf8')).toBe('{"n":2}');
    expect((await readdir(directory)).filter(name => name.startsWith('.fy-fleet-apply'))).toEqual([]);
  });

  it('raises what an update’s change threw, after clearing the claim', async () => {
    const world = await fleetWorld();
    const { setup, directory } = await setupOver(world);

    const act = setup.cloneBase.update(join(directory, 'setup', 'clone-base.json'), () => {
      throw new Error('the record is not what was expected');
    });

    await expect(act).rejects.toThrow('the record is not what was expected');
    expect((await readdir(directory)).filter(name => name.startsWith('.fy-fleet-apply'))).toEqual([]);
  });

  it('says so when the record was written but the apply claim could not be cleared', async () => {
    const world = await fleetWorld();
    const { setup, directory } = await setupOver(world);
    const lock = join(directory, '.fy-fleet-apply.lock');

    const act = setup.cloneBase.update(join(directory, 'setup', 'clone-base.json'), () => {
      // Something that is not this holder's lands in the claim folder while the update runs, so the folder is not emptied.
      writeFileSync(join(lock, 'stray'), 'somebody else’s');
      return '{"n":1}';
    });

    await expect(act).rejects.toThrow(
      `the record update finished, but the exclusive apply claim at ${lock} could not be cleared`,
    );
    expect(await readFile(join(directory, 'setup', 'clone-base.json'), 'utf8')).toBe('{"n":1}');
    expect(await readdir(lock)).toEqual(['stray']);
  });
});

describe('a copy’s settings merge over the config files service', () => {
  const service = (calls: string[]): ConfigFileService => ({
    file: async path => {
      calls.push(`file ${path}`);
      return { exists: true, text: 'a: 1\n', etag: 'etag-1' };
    },
    inEffect: async () => ({ evaluation: { effective: { warden: 'w', learning: 'l', voice: 'v' } } }),
    validate: async (_path, text) =>
      text === 'bad'
        ? [
            { severity: 'error', message: 'no good', line: 3 },
            { severity: 'warning', message: 'hm' },
          ]
        : [],
    write: async (path, text, ifMatch, mayLoosen, as) => {
      calls.push(`write ${path} ${text} ${ifMatch} ${String(mayLoosen)} ${as}`);
      return { outcome: 'pending' };
    },
  });

  it('reads a file with its etag, the settings in effect, and writes as the owner', async () => {
    const calls: string[] = [];
    const files = cloneConfigFilesOver(service(calls));

    expect(await files.file('warden.yaml')).toEqual({ exists: true, text: 'a: 1\n', etag: 'etag-1' });
    expect(await files.effective()).toEqual({ warden: 'w', learning: 'l', voice: 'v' });
    expect(await files.write('warden.yaml', 'a: 2\n', 'etag-1', true)).toEqual({ outcome: 'pending' });
    expect(calls).toEqual(['file warden.yaml', 'write warden.yaml a: 2\n etag-1 true owner']);
  });

  it('carries a validation issue’s line only when it has one', async () => {
    const files = cloneConfigFilesOver(service([]));

    expect(await files.validate('warden.yaml', 'bad')).toEqual([
      { severity: 'error', message: 'no good', line: 3 },
      { severity: 'warning', message: 'hm' },
    ]);
    expect(await files.validate('warden.yaml', 'fine')).toEqual([]);
  });
});
