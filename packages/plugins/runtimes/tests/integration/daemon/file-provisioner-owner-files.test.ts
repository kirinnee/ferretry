/**
 * V-B28 / E-270: keep owner entries and refresh only entries proven written by Ferretry. All fixtures are synthetic.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { appendFile, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FleetApplyFailureError, type FleetApplyPlan } from '../../../daemon/lib/provisioning.ts';
import type { FleetDisk } from '../../../daemon/adapters/fleet-disk.ts';
import type { FleetManifest } from '../../../daemon/lib/manifest.ts';
import { cleanupWorlds, fleetWorld, type FleetWorld } from '../../unit/support/fleet-world.ts';

afterEach(cleanupWorlds);

const manifest = (): FleetManifest => ({
  version: 1,
  generatedAt: '2027-01-15T08:00:00.000Z',
  runtimes: [],
  accounts: [],
});

/** One apply: copy the `hooks` asset folder into a runtime home under a record, as the account materialiser plans it. */
async function applyHooks(world: FleetWorld, bytes: string | undefined, disk?: FleetDisk) {
  const source = join(world.fleet, 'assets', 'hooks');
  await mkdir(source, { recursive: true });
  if (bytes === undefined) await rm(join(source, 'pre.sh'), { force: true });
  else await writeFile(join(source, 'pre.sh'), bytes);
  const home = join(world.fleet, 'homes', 'one');
  const record = join(home, '.fy', 'materialised.json');
  const plan: FleetApplyPlan = {
    manifest: manifest(),
    manifestPath: join(world.fleet, 'manifest.json'),
    operations: [
      { kind: 'directory', path: join(home, '.fy'), mode: 0o700 },
      { kind: 'copy', source, path: join(home, 'hooks'), unlessUnrecorded: { record, key: 'hooks' } },
      {
        kind: 'file',
        path: record,
        content: `${JSON.stringify({ version: 1, entries: ['hooks'], hashes: {}, links: {}, dirs: [], members: {} })}\n`,
        mode: 0o600,
        recordsMaterialised: true,
      },
    ],
  };
  const outcome = await world.provisioner(disk === undefined ? undefined : { disk }).apply(plan);
  return { hooks: join(home, 'hooks'), outcome };
}

describe('a copied folder in a runtime home', () => {
  it('E-270 is replaced when untouched, and kept with its added file when the person added one', async () => {
    const world = await fleetWorld();
    const first = await applyHooks(world, 'v1\n');
    expect(await readFile(join(first.hooks, 'pre.sh'), 'utf8')).toBe('v1\n');

    // Untouched since Ferretry copied it: the next copy replaces it whole.
    await applyHooks(world, 'v2\n');
    expect(await readFile(join(first.hooks, 'pre.sh'), 'utf8')).toBe('v2\n');

    // The person adds a hook of their own beside Ferretry's.
    await writeFile(join(first.hooks, 'mine.sh'), 'my own hook\n');
    const third = await applyHooks(world, 'v3\n');

    expect(await readFile(join(first.hooks, 'mine.sh'), 'utf8')).toBe('my own hook\n');
    expect(await readFile(join(first.hooks, 'pre.sh'), 'utf8')).toBe('v3\n');
    expect(third.outcome.skipped?.map(entry => entry.path)).toContain(join(first.hooks, 'mine.sh'));
  });

  for (const dirs of [undefined, ['hooks']]) {
    it(`MUST 1 keeps an incompletely recorded tree (dirs=${String(dirs)}) and reports it`, async () => {
      const world = await fleetWorld();
      const { hooks } = await applyHooks(world, 'old-guard');
      await mkdir(join(hooks, 'nested'));
      await writeFile(join(hooks, 'nested', 'mine.sh'), 'owner');
      await symlink('nested/mine.sh', join(hooks, 'owner-link'));
      await writeFile(
        join(hooks, '..', '.fy', 'materialised.json'),
        JSON.stringify({ version: 1, entries: ['hooks'], dirs }),
      );
      const { outcome } = await applyHooks(world, 'new-guard');
      expect(await readFile(join(hooks, 'nested', 'mine.sh'), 'utf8')).toBe('owner');
      expect(await readlink(join(hooks, 'owner-link'))).toBe('nested/mine.sh');
      expect(outcome.skipped?.map(entry => entry.path)).toContain(hooks);
    });
  }

  it('MUST 2 keeps and reports a file with an owner appendix past the read bound', async () => {
    const world = await fleetWorld();
    const bytes = '#'.repeat(4 * 1024 * 1024);
    const { hooks } = await applyHooks(world, bytes);
    await appendFile(join(hooks, 'pre.sh'), '\nowner appendix\n');
    const { outcome } = await applyHooks(world, 'new-guard');
    expect(await readFile(join(hooks, 'pre.sh'), 'utf8')).toBe(`${bytes}\nowner appendix\n`);
    expect(outcome.skipped?.map(entry => entry.path)).toContain(join(hooks, 'pre.sh'));
  });

  it('MUST 2 keeps an oversized owner config.toml whole and reports it', async () => {
    const world = await fleetWorld();
    const config = join(world.fleet, 'config.toml');
    const bytes = `#${'x'.repeat(4 * 1024 * 1024)}\nowner_key = "kept"\n`;
    await writeFile(config, bytes);
    const result = await world.provisioner().apply({
      manifest: manifest(),
      manifestPath: join(world.fleet, 'manifest.json'),
      operations: [
        {
          kind: 'settings',
          path: config,
          format: 'toml',
          mode: 0o600,
          preserveExisting: true,
          layers: [{ from: 'inline', settings: { model: 'planned' } }],
        },
      ],
    });
    expect(await readFile(config, 'utf8')).toBe(bytes);
    expect(result.skipped?.map(entry => entry.path)).toContain(config);
  });

  it('MUST 3 does not claim a file that arrives immediately after publishing a copy', async () => {
    const world = await fleetWorld();
    const hooks = join(world.fleet, 'homes', 'one', 'hooks');
    const disk = afterPublish(
      world.disk,
      hooks,
      async () => await writeFile(join(hooks, 'mine.sh'), 'concurrent owner'),
    );
    await applyHooks(world, 'old-guard', disk);
    const { outcome } = await applyHooks(world, 'new-guard');
    expect(await readFile(join(hooks, 'mine.sh'), 'utf8')).toBe('concurrent owner');
    expect(await readFile(join(hooks, 'pre.sh'), 'utf8')).toBe('new-guard');
    expect(outcome.skipped?.map(entry => entry.path)).toContain(join(hooks, 'mine.sh'));
  });

  it('MUST 3 rollback keeps a concurrent file after a later failure and reports incomplete restoration', async () => {
    const world = await fleetWorld();
    const hooks = join(world.fleet, 'homes', 'one', 'hooks');
    const disk = afterPublish(
      world.disk,
      hooks,
      async () => await writeFile(join(hooks, 'mine.sh'), 'concurrent owner'),
      true,
    );
    const failure = await applyHooks(world, 'old-guard', disk).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FleetApplyFailureError);
    expect((failure as FleetApplyFailureError).failure.kind).toBe('rollback-incomplete');
    expect(await readFile(join(hooks, 'mine.sh'), 'utf8')).toBe('concurrent owner');
  });

  it('MUST 4 skips only an owner symlink while updating the active guard', async () => {
    const world = await fleetWorld();
    const { hooks } = await applyHooks(world, 'old-guard');
    await symlink('pre.sh', join(hooks, 'owner-link'));
    const { outcome } = await applyHooks(world, 'new-guard');
    expect(await readlink(join(hooks, 'owner-link'))).toBe('pre.sh');
    expect(await readFile(join(hooks, 'pre.sh'), 'utf8')).toBe('new-guard');
    expect(outcome.skipped?.map(entry => entry.path)).toEqual([join(hooks, 'owner-link')]);
  });

  it('restores the original guard when publication fails before the staged copy moves', async () => {
    const world = await fleetWorld();
    const { hooks } = await applyHooks(world, 'old-guard');
    const disk = new Proxy(world.disk, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'rename')
          return async (from: string, to: string) => {
            if (to === join(hooks, 'pre.sh') && from.includes('.fy-fleet-staged-')) throw new Error('publish fault');
            await target.rename(from, to);
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const failure = await applyHooks(world, 'new-guard', disk).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FleetApplyFailureError);
    expect((failure as FleetApplyFailureError).failure.kind).toBe('rolled-back');
    expect(await readFile(join(hooks, 'pre.sh'), 'utf8')).toBe('old-guard');
  });

  it('MUST 4 can add the guard again after its last owned child was retired', async () => {
    const world = await fleetWorld();
    const { hooks } = await applyHooks(world, 'old-guard');
    await symlink('pre.sh', join(hooks, 'owner-link'));
    await applyHooks(world, undefined);
    const { outcome } = await applyHooks(world, 'new-guard');
    expect(await readFile(join(hooks, 'pre.sh'), 'utf8')).toBe('new-guard');
    expect(await readlink(join(hooks, 'owner-link'))).toBe('pre.sh');
    expect(outcome.skipped?.map(entry => entry.path)).toEqual([join(hooks, 'owner-link')]);
  });

  it('E-273 keeps concurrent .claude.json live and names the backup containing the original', async () => {
    const world = await fleetWorld();
    const config = join(world.fleet, '.claude.json');
    await writeFile(config, '{"original":true}');
    const disk = new Proxy(world.disk, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'setMode')
          return async () => {
            await writeFile(config, '{"concurrent":true}');
            throw new Error('later fault');
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const failure = await world
      .provisioner({ disk })
      .apply({
        manifest: manifest(),
        manifestPath: join(world.fleet, 'manifest.json'),
        operations: [
          { kind: 'file', path: config, content: '{"planned":true}', mode: 0o600 },
          { kind: 'directory', path: join(world.fleet, 'bin'), mode: 0o700 },
        ],
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FleetApplyFailureError);
    const outcome = (failure as FleetApplyFailureError).failure;
    expect(outcome.kind).toBe('rollback-incomplete');
    if (outcome.kind !== 'rollback-incomplete') throw new Error('expected incomplete rollback');
    const backup = outcome.unrestored.find(entry => entry.path === config)?.backup;
    expect(backup).toContain('.fy-fleet-backup-');
    expect(await readFile(config, 'utf8')).toBe('{"concurrent":true}');
    expect(await readFile(backup as string, 'utf8')).toBe('{"original":true}');
  });
});

/** Inject the second writer after the REAL rename returns; no production entry point is bypassed. */
function afterPublish(disk: FleetDisk, destination: string, write: () => Promise<void>, failLater = false): FleetDisk {
  let published = false;
  return new Proxy(disk, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'rename')
        return async (from: string, to: string) => {
          await target.rename(from, to);
          if (to === destination && !published) {
            published = true;
            await write();
          }
        };
      if (property === 'create' && failLater)
        return async (...args: Parameters<FleetDisk['create']>) => {
          if (published && args[0].endsWith('/materialised.json')) throw new Error('later write fault');
          await target.create(...args);
        };
      return value.bind(target);
    },
  });
}
