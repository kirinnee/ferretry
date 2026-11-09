/**
 * The catalogue and the setup composed over the files: the host the adapters stand on (roots, claim, clock), the one
 * change that lands configuration documents ALL OR NONE before the fleet, and what is still unavailable and says so.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KernelPorts } from '@ferretry/kernel/contract';
import { configThenFleet } from '../../../daemon/adapters/account-model-files.ts';
import { readTextFolder } from '../../../daemon/adapters/setup-files.ts';
import { fileAssembly, fleetHost } from '../../../daemon/host-assembly.ts';
import { UNAVAILABLE } from '../../../daemon/lib/service/assembly.ts';
import { FleetPublication } from '../../../daemon/lib/service/publication.ts';
import { ConfigWriteInvalid } from '../../../daemon/lib/service/ports.ts';
import type { FleetApplyPlan } from '../../../daemon/lib/provisioning.ts';
import { cleanupWorlds, fleetWorld, type FleetWorld } from '../support/fleet-world.ts';

afterEach(cleanupWorlds);

const kernelOver = (world: FleetWorld) => {
  let now = 1_000;
  const warned: string[] = [];
  const kernel = {
    roots: world.roots,
    paths: { home: () => world.person },
    clock: {
      nowMs: () => now,
      after: (_duration: unknown, run: () => void) => {
        now += 25;
        queueMicrotask(run);
        return () => undefined;
      },
    },
    log: { warn: (message: string) => warned.push(message) },
    config: { writeAll: async () => ({ kind: 'written' as const }) },
  } as unknown as Pick<KernelPorts, 'roots' | 'paths' | 'clock' | 'log'> & {
    config: Pick<KernelPorts['config'], 'writeAll'>;
  };
  return { kernel, warned };
};

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
  it('still answers the plain sentence for a read of the model, because the evaluator is not ported', async () => {
    const world = await fleetWorld();
    const { kernel } = kernelOver(world);
    const needs = { logins: { list: async () => ({ logins: [] }) }, loginChanges: {} } as never;

    const services = fileAssembly({ kernel, needs }, new FleetPublication());

    await expect(services.catalog.machine(undefined)).rejects.toThrow(UNAVAILABLE);
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
