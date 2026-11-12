/**
 * An unreadable DERIVED fleet manifest is regenerated, never fatal (a live v4 outage: an older daemon's strict reader
 * refused a manifest a neighbouring version wrote, and every session start was refused until a person intervened).
 *
 * Real adapters over a temp fleet folder (never a real home): the provisioner keeps the damaged file once and writes the
 * manifest again; the publishing side counts damage as "not published"; the launch-inventory readers refuse with a
 * RETRYABLE sentence until it has been rebuilt; the composed daemon rebuilds it once after start and a start resolves
 * its runtime from the rebuilt file with the same homes as before.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { type DaemonImplementation } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { fakeLoginChanges, fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { RuntimeHomeUnreadable } from '../../../contract/index.ts';
import { fleetHomes } from '../../../daemon/adapters/fleet-home-reader.ts';
import {
  FleetManifestUnreadableError,
  manifestIsUnreadable,
  readFleetManifest,
  readPublishedManifest,
} from '../../../daemon/adapters/manifest-file.ts';
import { launchFactsSource, manifestUnreadableProbe } from '../../../daemon/host-assembly.ts';
import { hostAssembly, runtimesDaemon } from '../../../daemon/index.ts';
import type { FleetManifest } from '../../../daemon/lib/manifest.ts';
import type { FleetApplyPlan } from '../../../daemon/lib/provisioning.ts';
import { FleetPublication } from '../../../daemon/lib/service/publication.ts';
import { cleanupWorlds, fleetWorld, type FleetWorld } from '../../unit/support/fleet-world.ts';
import { faultingDisk } from '../support/faulting-disk.ts';

afterEach(cleanupWorlds);

/** Text a sentence must never carry: it sits inside the damaged file. */
const MARKER = 'DAMAGED-FILE-CONTENT-MARKER';

const manifest = (): FleetManifest => ({
  version: 1,
  generatedAt: '2027-01-15T08:00:00.000Z',
  runtimes: [],
  accounts: [
    {
      secretEnv: {},
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'claude',
      mode: 'auto',
      wrapper: '/placeholder/bin/alias',
      home: '/placeholder/homes/one',
      displayName: 'Placeholder Account',
      defaultModel: 'model-one',
      models: [{ id: 'model-one', displayName: 'Model One', available: true }],
      available: true,
      unavailableReason: null,
    },
  ],
});

const planFor = (world: FleetWorld): FleetApplyPlan => ({
  manifest: manifest(),
  manifestPath: join(world.fleet, 'manifest.json'),
  operations: [],
});

/** Exactly the v4 shape that broke: an account row carrying a key this version's strict schema does not know. */
const withUnknownKey = (): string =>
  JSON.stringify({
    ...manifest(),
    accounts: [{ ...manifest().accounts[0], claudeEnvOverrides: { NOTE: MARKER } }],
  });
const truncated = (): string => `${JSON.stringify(manifest()).slice(0, 60)}${MARKER}`;

const kept = async (world: FleetWorld): Promise<string[]> =>
  (await readdir(world.fleet)).filter(name => name.startsWith('manifest.json.unreadable-')).toSorted();

const manifestPathOf = (world: FleetWorld): string => join(world.fleet, 'manifest.json');

describe('the provisioner rebuilds an unreadable manifest and keeps the old file once', () => {
  it.each([
    ['an unknown key on an account row (the v4 shape)', withUnknownKey],
    ['truncated JSON', truncated],
  ])(
    '%s: the apply succeeds, the manifest is whole again, a private copy is kept, one plain line is said',
    async (_name, damage) => {
      const world = await fleetWorld();
      await writeFile(manifestPathOf(world), damage());
      const said: string[] = [];

      const result = await world.provisioner({ say: sentence => said.push(sentence) }).apply(planFor(world));

      expect(result.accountCount).toBe(1);
      const rebuilt = JSON.parse(await readFile(manifestPathOf(world), 'utf8')) as FleetManifest;
      expect(rebuilt.accounts).toHaveLength(1);
      expect(rebuilt.accounts[0]).not.toHaveProperty('claudeEnvOverrides');
      const copies = await kept(world);
      expect(copies).toHaveLength(1);
      expect(await readFile(join(world.fleet, copies[0] ?? ''), 'utf8')).toBe(damage());
      expect((await stat(join(world.fleet, copies[0] ?? ''))).mode & 0o777).toBe(0o600);
      expect(said).toHaveLength(1);
      expect(said[0]).toContain(manifestPathOf(world));
      expect(said[0]).toContain(copies[0] ?? 'never');
      expect(said[0]).not.toContain(MARKER);
      expect(said[0]).not.toContain('\n');
    },
  );

  it('leaves a valid manifest alone: no copy, nothing said', async () => {
    const world = await fleetWorld();
    await writeFile(manifestPathOf(world), JSON.stringify(manifest()));
    const said: string[] = [];

    await world.provisioner({ say: sentence => said.push(sentence) }).apply(planFor(world));

    expect(await kept(world)).toEqual([]);
    expect(said).toEqual([]);
  });

  it('writes the first manifest of a machine that has none without a copy or a word', async () => {
    const world = await fleetWorld();
    const said: string[] = [];

    await world.provisioner({ say: sentence => said.push(sentence) }).apply(planFor(world));

    expect(await kept(world)).toEqual([]);
    expect(said).toEqual([]);
    expect(JSON.parse(await readFile(manifestPathOf(world), 'utf8'))).toMatchObject({ version: 1 });
  });

  it('keeps the same damage once, however many applies meet it', async () => {
    const world = await fleetWorld();
    const said: string[] = [];
    const provisioner = world.provisioner({ say: sentence => said.push(sentence) });
    await writeFile(manifestPathOf(world), withUnknownKey());
    await provisioner.apply(planFor(world));
    await writeFile(manifestPathOf(world), withUnknownKey());

    await provisioner.apply(planFor(world));

    expect(await kept(world)).toHaveLength(1);
    expect(said).toHaveLength(2);
    expect(said[1]).toContain((await kept(world))[0] ?? 'never');
  });

  it('runs without anyone listening', async () => {
    const world = await fleetWorld();
    await writeFile(manifestPathOf(world), truncated());

    await world.provisioner().apply(planFor(world));

    expect(await kept(world)).toHaveLength(1);
  });

  it('rebuilds a manifest too big to read, says the old file could not be kept, and still applies', async () => {
    const world = await fleetWorld();
    await writeFile(manifestPathOf(world), 'x'.repeat(5 * 1024 * 1024));
    const said: string[] = [];
    // Only the provisioner's own first look at the file is refused (as a bound would): the journal's reads go through.
    let refused = false;
    const disk = faultingDisk(world.disk, async (call, args) => {
      if (call !== 'readBytes' || refused || String(args[0]) !== manifestPathOf(world)) return;
      refused = true;
      throw new Error('larger than the bound');
    });

    await world.provisioner({ disk, say: sentence => said.push(sentence) }).apply(planFor(world));

    expect(await kept(world)).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('could not be kept aside');
    expect(JSON.parse(await readFile(manifestPathOf(world), 'utf8'))).toMatchObject({ version: 1 });
  });

  it('rebuilds the manifest even when the copy cannot be made, and says so', async () => {
    const world = await fleetWorld();
    await writeFile(manifestPathOf(world), truncated());
    const said: string[] = [];
    const disk = faultingDisk(world.disk, async (call, args) => {
      if (call === 'create' && String(args[0]).includes('.unreadable-')) throw new Error('disk refused the copy');
    });

    await world.provisioner({ disk, say: sentence => said.push(sentence) }).apply(planFor(world));

    expect(await kept(world)).toEqual([]);
    expect(said[0]).toContain('could not be kept aside');
    expect(JSON.parse(await readFile(manifestPathOf(world), 'utf8'))).toMatchObject({ version: 1 });
  });

  it('leaves the damaged file exactly as it was when the apply itself is rolled back', async () => {
    const world = await fleetWorld();
    await writeFile(manifestPathOf(world), withUnknownKey());
    const disk = faultingDisk(world.disk, async (call, args) => {
      if (call === 'create' && String(args[0]).endsWith('/manifest.json')) throw new Error('disk refused the manifest');
    });

    await expect(world.provisioner({ disk }).apply(planFor(world))).rejects.toThrow();

    expect(await readFile(manifestPathOf(world), 'utf8')).toBe(withUnknownKey());
  });

  it('does not treat something that is not a file at the manifest path as a damaged manifest', async () => {
    const world = await fleetWorld();
    await mkdir(manifestPathOf(world), { recursive: true });
    const said: string[] = [];

    await world
      .provisioner({ say: sentence => said.push(sentence) })
      .apply(planFor(world))
      .catch(() => undefined);

    expect(said).toEqual([]);
    expect(await kept(world)).toEqual([]);
  });
});

describe('the readers of the manifest', () => {
  const files = (world: FleetWorld) => ({
    readText: async (path: string): Promise<string | undefined> => await readFile(path, 'utf8').catch(() => undefined),
    world,
  });

  it('the launch-inventory reader refuses damage with a typed, retryable sentence that names the file', async () => {
    const world = await fleetWorld();
    await writeFile(manifestPathOf(world), withUnknownKey());

    const refusal = await readFleetManifest(files(world), manifestPathOf(world)).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(FleetManifestUnreadableError);
    expect((refusal as Error).message).toContain(manifestPathOf(world));
    expect((refusal as Error).message).toContain('try again');
    expect((refusal as Error).message).not.toContain(MARKER);
  });

  it('the launch-inventory reader reads a valid manifest and answers undefined for none', async () => {
    const world = await fleetWorld();
    expect(await readFleetManifest(files(world), manifestPathOf(world))).toBeUndefined();
    await writeFile(manifestPathOf(world), JSON.stringify(manifest()));
    expect((await readFleetManifest(files(world), manifestPathOf(world)))?.accounts).toHaveLength(1);
  });

  it('the publishing side counts damage as not published, so a republish is never refused by the file it replaces', async () => {
    const world = await fleetWorld();
    expect(await readPublishedManifest(files(world), manifestPathOf(world))).toBeUndefined();
    await writeFile(manifestPathOf(world), withUnknownKey());
    expect(await readPublishedManifest(files(world), manifestPathOf(world))).toBeUndefined();
    await writeFile(manifestPathOf(world), JSON.stringify(manifest()));
    expect((await readPublishedManifest(files(world), manifestPathOf(world)))?.accounts).toHaveLength(1);
  });

  it('tells damage from absence and from a good manifest', async () => {
    const world = await fleetWorld();
    expect(await manifestIsUnreadable(files(world), manifestPathOf(world))).toBe(false);
    await writeFile(manifestPathOf(world), truncated());
    expect(await manifestIsUnreadable(files(world), manifestPathOf(world))).toBe(true);
    await writeFile(manifestPathOf(world), JSON.stringify(manifest()));
    expect(await manifestIsUnreadable(files(world), manifestPathOf(world))).toBe(false);
  });

  it('the homes reader refuses damage as a retryable RuntimeHomeUnreadable and reads the rebuilt file', async () => {
    const world = await fleetWorld();
    await writeFile(manifestPathOf(world), withUnknownKey());
    const api = fleetHomes(world.roots, new FleetPublication());

    const refusal = await api.homes().catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RuntimeHomeUnreadable);
    expect((refusal as Error).message).toContain('try again');

    await world.provisioner().apply(planFor(world));
    expect(await api.homes()).toBeArray();
  });

  it('the boot probe sees damage only', async () => {
    const world = await fleetWorld();
    const probe = manifestUnreadableProbe({ roots: world.roots }, new FleetPublication());
    expect(await probe()).toBe(false);
    await writeFile(manifestPathOf(world), withUnknownKey());
    expect(await probe()).toBe(true);
    await writeFile(manifestPathOf(world), JSON.stringify(manifest()));
    expect(await probe()).toBe(false);
  });
});

// ── the composed daemon: boot repair, then a start resolves its runtime ─────────────────────────────────────────────

const CONFIG = {
  runtimes: { 'claude-default': { login: 'claude-you', profile: 'default', agent: true } },
  profiles: { default: { contents: ['modelSets/heavy'] } },
  'model-sets': { heavy: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' } },
};

async function compose(logins = [sampleLogin('claude-you', { store: 'ferretry' })]) {
  const world = await fleetWorld();
  const host = await testHost({
    plugins: [
      runtimesDaemon(ctx =>
        hostAssembly({ ...ctx, kernel: { ...ctx.kernel, roots: world.roots } } as never),
      ) as DaemonImplementation<any>,
    ],
    fakes: { ferrets: new FakeFerrets(), logins: fakeLogins(logins), loginChanges: fakeLoginChanges() },
    gate: new StandInAdmission(() => ownerStanding()),
    config: CONFIG,
    ownerHome: world.person,
    executables: ['/fixture/bin/claude', '/fixture/bin/codex'],
    searchPath: '/fixture/bin',
    spawn: () => ({ code: 0, stdout: '', stderr: '' }) as never,
  });
  return { host, world };
}

const publishOnce = async (host: TestHost): Promise<void> => {
  const staged = await host.request('POST', '/v1/runtimes/proposals', {
    body: {
      change: {
        kind: 'runtime.put',
        name: 'claude-work',
        credential: 'claude-you',
        profile: 'default',
        agent: true,
        create: true,
        addAnother: true,
      },
    },
  });
  const { id } = staged.json<{ id: string }>();
  const applied = await host.request('POST', `/v1/runtimes/proposals/${id}/apply`, { body: {} });
  expect(applied.status).toBe(200);
};

const REPAIR = 'runtimes.manifest-repair';

describe('the composed daemon rebuilds an unreadable manifest after start', () => {
  it('registers the repair as a once-after-start job', async () => {
    const { host } = await compose();
    expect(host.jobIds()).toContain(REPAIR);
  });

  it('the v4-shaped manifest: starts are refused retryably, the repair rebuilds it, the same homes and runtimes come back', async () => {
    const { host, world } = await compose();
    await publishOnce(host);
    const publication = new FleetPublication();
    const homesBefore = await fleetHomes(world.roots, publication).homes();
    expect(homesBefore.length).toBeGreaterThan(0);
    const good = JSON.parse(await readFile(manifestPathOf(world), 'utf8')) as FleetManifest;
    await writeFile(
      manifestPathOf(world),
      JSON.stringify({ ...good, accounts: good.accounts.map(row => ({ ...row, claudeEnvOverrides: { A: MARKER } })) }),
    );
    const facts = launchFactsSource({ roots: world.roots }, publication);
    await expect(facts.facts('claude-default')).rejects.toBeInstanceOf(FleetManifestUnreadableError);

    await host.runJob(REPAIR);

    const rebuilt = JSON.parse(await readFile(manifestPathOf(world), 'utf8')) as FleetManifest;
    expect(rebuilt.runtimes.map(runtime => runtime.name).toSorted()).toEqual(['claude-default', 'claude-work']);
    expect(rebuilt.accounts[0]).not.toHaveProperty('claudeEnvOverrides');
    expect(await kept(world)).toHaveLength(1);
    expect(
      host.logs.some(line => line.message.includes(manifestPathOf(world)) && line.message.includes('rebuilt')),
    ).toBe(true);
    expect(host.logs.map(line => line.message).join('\n')).not.toContain(MARKER);
    // The start path resolves its runtime again, and the harness homes (the credential binding) are exactly as before.
    expect(await facts.facts('claude-default')).toMatchObject({ kind: 'claude' });
    expect(await fleetHomes(world.roots, publication).homes()).toEqual(homesBefore);
  });

  it('a truncated manifest is rebuilt the same way', async () => {
    const { host, world } = await compose();
    await publishOnce(host);
    await writeFile(manifestPathOf(world), '{"version":1,"gener');

    await host.runJob(REPAIR);

    expect(JSON.parse(await readFile(manifestPathOf(world), 'utf8'))).toMatchObject({ version: 1 });
    expect(await kept(world)).toHaveLength(1);
  });

  it('a valid manifest is left alone: the repair publishes nothing', async () => {
    const { host, world } = await compose();
    await publishOnce(host);
    const before = await readFile(manifestPathOf(world), 'utf8');

    await host.runJob(REPAIR);

    expect(await readFile(manifestPathOf(world), 'utf8')).toBe(before);
    expect(await kept(world)).toEqual([]);
  });

  it('a machine with no manifest yet is left alone too', async () => {
    const { host, world } = await compose();

    await host.runJob(REPAIR);

    expect(await readdir(world.fleet)).not.toContain('manifest.json');
  });

  it('says so, and does not fail, when the manifest is unreadable and the configuration cannot be published yet', async () => {
    const { host, world } = await compose([]);
    await writeFile(manifestPathOf(world), withUnknownKey());

    await host.runJob(REPAIR);

    expect(host.logs.some(line => line.message.includes('could not be rebuilt yet'))).toBe(true);
    expect(await readFile(manifestPathOf(world), 'utf8')).toBe(withUnknownKey());
  });
});
