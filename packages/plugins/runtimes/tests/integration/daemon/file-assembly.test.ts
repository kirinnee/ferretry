/**
 * The catalogue and the setup composed over the files: the host the adapters stand on (roots, claim, clock), the one
 * change that lands configuration documents ALL OR NONE before the fleet, and what is still unavailable and says so.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configThenFleet, fileFleetCatalogDeps } from '../../../daemon/adapters/account-model-files.ts';
import { readTextFolder } from '../../../daemon/adapters/setup-files.ts';
import { fileAssembly, fleetHost } from '../../../daemon/host-assembly.ts';
import { FleetPublication } from '../../../daemon/lib/service/publication.ts';
import { ConfigWriteInvalid } from '../../../daemon/lib/service/ports.ts';
import { FleetApplyAfterConfigError, type FleetApplyPlan } from '../../../daemon/lib/provisioning.ts';
import { cleanupWorlds, fleetWorld, type FleetWorld } from '../../unit/support/fleet-world.ts';
import { kernelOver } from '../support/kernel-over.ts';

afterEach(cleanupWorlds);

describe('the host the file adapters stand on', () => {
  it('names the fleet folder, claims on the kernel clock and keeps its records inside the fleet folder', async () => {
    const world = await fleetWorld();
    const { host, directory } = fleetHost(kernelOver(world).kernel);

    expect(directory).toBe(world.fleet);
    const claim = host.claimFor(join(directory, 'manifest.json'));
    const token = await claim.acquire();
    expect(claim.path).toBe(join(directory, '.fy-fleet-apply.lock'));
    expect(await claim.release(token)).toBeUndefined();

    await host.texts.write(join(directory, 'setup', 'clone-base.json'), '{"a":1}');
    expect(await host.texts.read(join(directory, 'setup', 'clone-base.json'))).toBe('{"a":1}');
    expect(await host.texts.read(join(directory, 'setup', 'nothing.json'))).toBeNull();
    await expect(host.texts.write(join(world.home, 'config', 'machine.yaml'), 'x')).rejects.toThrow(
      /refusing to write outside configured fleet roots/u,
    );
  });

  it('reads the published manifest and the person’s own harness files through roots, nothing else', async () => {
    const world = await fleetWorld();
    await writeFile(join(world.fleet, 'manifest.json'), '{"x":1}');
    await writeFile(join(world.person, '.claude', 'CLAUDE.md'), 'mine');
    await writeFile(join(world.home, 'machine.yaml'), 'daemon');
    const { host } = fleetHost(kernelOver(world).kernel);

    expect(await host.files.readText(join(world.fleet, 'manifest.json'))).toBe('{"x":1}');
    expect(await host.files.readText(join(world.person, '.claude', 'CLAUDE.md'))).toBe('mine');
    await expect(host.files.readText(join(world.home, 'machine.yaml'))).rejects.toThrow(
      /outside the folders Runtimes may read/u,
    );
  });
});

describe('S43 the host reads of the fleet folder serve assets/ through a fence of its own', () => {
  it('refuses a component folder or file in assets/ that is a link out of it, and reads a real one', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.fleet, 'credentials', 'one'), { recursive: true });
    await writeFile(join(world.fleet, 'credentials', 'one', 'auth.json'), 'INERT_SIGN_IN_FIXTURE');
    await mkdir(join(world.fleet, 'assets', 'skills', 'real'), { recursive: true });
    await writeFile(join(world.fleet, 'assets', 'skills', 'real', 'SKILL.md'), 'a skill');
    await symlink('../../credentials', join(world.fleet, 'assets', 'skills', 'sneaky'));
    await symlink('../credentials/one/auth.json', join(world.fleet, 'assets', 'leak.md'));
    const { host } = fleetHost(kernelOver(world).kernel);

    const real = await readTextFolder(host.files, join(world.fleet, 'assets', 'skills', 'real'));
    expect(real.files).toEqual([{ path: 'SKILL.md', content: 'a skill' }]);
    await expect(readTextFolder(host.files, join(world.fleet, 'assets', 'skills', 'sneaky'))).rejects.toThrow();
    await expect(host.files.readText(join(world.fleet, 'assets', 'leak.md'))).rejects.toThrow();
    // The rest of the fleet folder is still read as before (the manifest, the ids).
    await writeFile(join(world.fleet, 'ids.json'), '{}');
    expect(await host.files.readText(join(world.fleet, 'ids.json'))).toBe('{}');
  });

  it('reads a folder of assets/ that is not there yet as empty, as it did through the whole fleet root', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.fleet, 'assets'), { recursive: true });
    const { host } = fleetHost(kernelOver(world).kernel);

    expect(await readTextFolder(host.files, join(world.fleet, 'assets', 'skills', 'none'))).toEqual({
      files: [],
      skipped: [],
    });
    expect(await host.files.stat(join(world.fleet, 'assets'))).toMatchObject({ kind: 'directory' });
  });
});

describe('the composed catalogue and setup', () => {
  it('answers a read of the model with real data (not the plain sentence) now the evaluator reads the files', async () => {
    const world = await fleetWorld();
    const { kernel } = kernelOver(world);
    const needs = {
      logins: { list: async () => ({ logins: [] }), environmentTemplates: async () => [] },
      loginChanges: {},
      ferrets: { list: async () => [] },
    } as never;

    const services = fileAssembly({ kernel, needs, hooks: { provider: () => 'unavailable' } }, new FleetPublication());

    const machine = await services.catalog.machine(undefined);
    expect(machine).toMatchObject({ format: 'none' });
  });

  it('S144 R8 a path that climbs out of the setup folder is never read as one of the fleet’s own records: a sign-in under credentials/ stays unread', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.fleet, 'credentials', 'one'), { recursive: true });
    await writeFile(join(world.fleet, 'credentials', 'one', '.credentials.json'), 'INERT_SIGN_IN_FIXTURE');
    await mkdir(join(world.fleet, 'setup'), { recursive: true });
    await writeFile(join(world.fleet, 'setup', 'import.json'), '{"record":true}');
    const { host, directory } = fleetHost(kernelOver(world).kernel);
    const deps = fileFleetCatalogDeps({
      host,
      paths: { home: world.home, fleet: directory, fleetManifest: join(directory, 'manifest.json') },
      userHome: world.person,
      sessionStatuses: async () => [],
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
    });

    // The fleet's own record is read as a text file; the climb goes to the component-source fence, which refuses it.
    expect(await deps.readAsset(join(directory, 'setup', 'import.json'))).toBe('{"record":true}');
    await expect(deps.readAsset(`${directory}/setup/../credentials/one/.credentials.json`)).rejects.toThrow(
      /outside the folders Runtimes may read a component from/u,
    );
  });
});

describe('one change lands its configuration documents, then its fleet', () => {
  const plan = (world: FleetWorld): FleetApplyPlan => ({
    manifest: { version: 1, generatedAt: '2027-01-15T08:00:00.000Z', runtimes: [], accounts: [] },
    manifestPath: join(world.fleet, 'manifest.json'),
    operations: [],
  });

  it('writes the configuration set first, the asset documents with the plan, and refuses any other place', async () => {
    const world = await fleetWorld();
    const order: string[] = [];
    const inner = {
      preview: async () => ({}) as never,
      apply: async (_plan: FleetApplyPlan, documents: readonly { path: string }[] = []) => {
        order.push(`fleet:${documents.map(document => document.path).join(',')}`);
        return {} as never;
      },
    };
    const writer = {
      write: async (documents: readonly { path: string }[]) => {
        order.push(`config:${documents.map(document => document.path).join(',')}`);
      },
    };
    const configDirectory = join(world.home, 'config');
    const subject = configThenFleet(inner, writer, { load: async () => ({}) as never }, configDirectory, world.disk);
    const asset = { path: join(world.fleet, 'assets', 'a.md'), content: 'a', mode: 0o600 };
    const setting = { path: join(configDirectory, 'runtimes.yaml'), content: 'b', mode: 0o600 };

    await subject.apply(plan(world), [asset, setting]);
    expect(order).toEqual([`config:${setting.path}`, `fleet:${asset.path}`]);

    const elsewhere = { path: join(world.parent, 'elsewhere.txt'), content: 'c', mode: 0o600 };
    await expect(subject.apply(plan(world), [elsewhere])).rejects.toThrow(
      /neither a file of the fleet folder nor of the configuration folder; nothing was changed/u,
    );
    expect(order).toHaveLength(2);
  });

  it('R2-M1 tells the caller which configuration files landed when the fleet then fails, and only then', async () => {
    const world = await fleetWorld();
    const configDirectory = join(world.home, 'config');
    const setting = { path: join(configDirectory, 'runtimes.yaml'), content: 'b', mode: 0o600 };
    const asset = { path: join(world.fleet, 'assets', 'a.md'), content: 'a', mode: 0o600 };
    const refusing = {
      preview: async () => ({}) as never,
      apply: async () => {
        throw new Error('a source leads out of the folder');
      },
    };
    const landed: string[] = [];
    const writer = {
      write: async (documents: readonly { path: string }[]) => void landed.push(...documents.map(d => d.path)),
    };
    const load = { load: async () => ({}) as never };
    const subject = configThenFleet(refusing, writer, load, configDirectory, world.disk);

    // The files landed, then the fleet refused: the error says which files, and keeps the fleet's own error.
    const failure = await subject.apply(plan(world), [asset, setting]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FleetApplyAfterConfigError);
    expect((failure as FleetApplyAfterConfigError).written).toEqual([setting.path]);
    expect((failure as FleetApplyAfterConfigError).failure).toEqual(new Error('a source leads out of the folder'));
    expect(landed).toEqual([setting.path]);

    // No configuration file in the change: nothing landed first, so the fleet's own error is not wrapped.
    const plain = await subject.apply(plan(world), [asset]).catch((error: unknown) => error);
    expect(plain).not.toBeInstanceOf(FleetApplyAfterConfigError);
    expect((plain as Error).message).toBe('a source leads out of the folder');

    // The configuration set itself refused: nothing landed, so nothing is claimed.
    const held = configThenFleet(
      refusing,
      {
        write: async () => {
          throw new ConfigWriteInvalid('held for the owner; nothing was written');
        },
      },
      load,
      configDirectory,
      world.disk,
    );
    const refused = await held.apply(plan(world), [setting]).catch((error: unknown) => error);
    expect(refused).not.toBeInstanceOf(FleetApplyAfterConfigError);
  });

  it('writes no fleet file when the configuration set is held or refused: the whole change waits', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.fleet), { recursive: true });
    const fleetCalls: string[] = [];
    const inner = {
      preview: async () => ({}) as never,
      apply: async () => {
        fleetCalls.push('apply');
        return {} as never;
      },
    };
    const writer = {
      write: async () => {
        throw new ConfigWriteInvalid('this change loosens a limit, so it is held for the owner; nothing was written');
      },
    };
    const configDirectory = join(world.home, 'config');
    const subject = configThenFleet(inner, writer, { load: async () => ({}) as never }, configDirectory, world.disk);

    const act = subject.apply(plan(world), [
      { path: join(configDirectory, 'runtimes.yaml'), content: 'b', mode: 0o600 },
    ]);

    await expect(act).rejects.toThrow(/held for the owner; nothing was written/u);
    expect(fleetCalls).toEqual([]);
    expect(await readFile(join(world.fleet, '.keep'), 'utf8').catch(() => 'none')).toBe('none');
  });
});
