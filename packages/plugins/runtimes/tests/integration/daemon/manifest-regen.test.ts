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
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { type DaemonImplementation } from '@ferretry/kernel/manifest';
import { fixedClock, type TestHost, testHost } from '@ferretry/kernel/testing';
import { fakeLoginChanges, fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { RuntimeHomeUnreadable } from '../../../contract/index.ts';
import { fleetHomes } from '../../../daemon/adapters/fleet-home-reader.ts';
import {
  FleetManifestUnreadableError,
  manifestIsUnreadable,
  readFleetManifest,
  readPublishedManifest,
} from '../../../daemon/adapters/manifest-file.ts';
import {
  launchFactsSource,
  MANIFEST_REPAIR_JOB,
  manifestUnreadableProbe,
  repairRequester,
} from '../../../daemon/host-assembly.ts';
import { hostAssembly, runtimesDaemon } from '../../../daemon/index.ts';
import { MAX_KEPT_UNREADABLE_MANIFESTS } from '../../../daemon/lib/manifest-reading.ts';
import { LaunchGate } from '../../../daemon/lib/launch-gate.ts';
import type { FleetManifest } from '../../../daemon/lib/manifest.ts';
import type { FleetApplyPlan } from '../../../daemon/lib/provisioning.ts';
import { FleetPublication } from '../../../daemon/lib/service/publication.ts';
import { JobRunner } from '../../../../../core/kernel/host/jobs.ts';
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

describe('the copies kept aside are bounded and verified', () => {
  const copyOf = async (world: FleetWorld): Promise<string> => join(world.fleet, (await kept(world))[0] ?? 'never');

  it('keeps at most the most recent few copies across many different damages, never touching anything else', async () => {
    const world = await fleetWorld();
    const outside = join(world.person, 'fixture-evidence');
    await writeFile(outside, 'safe fixture marker');
    const stranger = join(world.fleet, 'manifest.json.unreadable-not-ours');
    await symlink(outside, stranger);
    const unrelated = join(world.fleet, 'other.json.unreadable-0123456789ab');
    await writeFile(unrelated, 'someone else');
    const payloads = Array.from({ length: 8 }, (_, n) => `${truncated()}-${n}`);

    for (const [n, payload] of payloads.entries()) {
      await writeFile(manifestPathOf(world), payload);
      await world.provisioner().apply(planFor(world));
      // Distinct, increasing ages: "the most recent" is then decided by time, not by chance.
      for (const name of await kept(world)) {
        if (name === 'manifest.json.unreadable-not-ours') continue;
        if ((await readFile(join(world.fleet, name), 'utf8')) === payload)
          await utimes(join(world.fleet, name), 1_000 + n, 1_000 + n);
      }
    }

    const left = await kept(world);
    expect(left).toHaveLength(MAX_KEPT_UNREADABLE_MANIFESTS + 1); // three real copies and the symlink that is not ours
    const bodies = await Promise.all(
      left
        .filter(name => name !== 'manifest.json.unreadable-not-ours')
        .map(async name => await readFile(join(world.fleet, name), 'utf8')),
    );
    expect(bodies.toSorted()).toEqual(payloads.slice(-MAX_KEPT_UNREADABLE_MANIFESTS).toSorted());
    expect((await lstat(stranger)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, 'utf8')).toBe('safe fixture marker');
    expect(await readFile(unrelated, 'utf8')).toBe('someone else');
  });

  it('still rebuilds when the older copies cannot be listed', async () => {
    const world = await fleetWorld();
    await writeFile(manifestPathOf(world), truncated());
    let armed = false;
    const disk = faultingDisk(world.disk, async (call, args) => {
      if (call === 'create' && String(args[0]).includes('.unreadable-')) armed = true;
      if (call === 'entries' && armed && String(args[0]) === world.fleet) {
        armed = false;
        throw new Error('disk refused the listing');
      }
    });

    await world.provisioner({ disk }).apply(planFor(world));

    expect(await kept(world)).toHaveLength(1);
    expect(JSON.parse(await readFile(manifestPathOf(world), 'utf8'))).toMatchObject({ version: 1 });
  });

  it('keeps the existing copy of the same damage when it is verified: a regular, owner-only file holding the same bytes', async () => {
    const world = await fleetWorld();
    await writeFile(manifestPathOf(world), truncated());
    await world.provisioner().apply(planFor(world));
    const copy = await copyOf(world);
    const before = await stat(copy);
    await writeFile(manifestPathOf(world), truncated());
    const said: string[] = [];

    await world.provisioner({ say: sentence => said.push(sentence) }).apply(planFor(world));

    expect((await stat(copy)).ino).toBe(before.ino);
    expect(said[0]).toContain('(owner-only)');
  });

  it('does not call an existing world-readable copy owner-only: it is replaced by a private one', async () => {
    const world = await fleetWorld();
    await writeFile(manifestPathOf(world), truncated());
    await world.provisioner().apply(planFor(world));
    const copy = await copyOf(world);
    await chmod(copy, 0o644);
    await writeFile(manifestPathOf(world), truncated());
    const said: string[] = [];

    await world.provisioner({ say: sentence => said.push(sentence) }).apply(planFor(world));

    expect((await stat(copy)).mode & 0o777).toBe(0o600);
    expect(await readFile(copy, 'utf8')).toBe(truncated());
    expect(said[0]).toContain('(owner-only)');
  });

  it('replaces an existing entry of that name that holds other bytes', async () => {
    const world = await fleetWorld();
    await writeFile(manifestPathOf(world), truncated());
    await world.provisioner().apply(planFor(world));
    const copy = await copyOf(world);
    await writeFile(copy, 'not what was there', { mode: 0o600 });
    await writeFile(manifestPathOf(world), truncated());

    await world.provisioner().apply(planFor(world));

    expect(await readFile(copy, 'utf8')).toBe(truncated());
  });

  it('replaces a link at that name without following or changing what it points at', async () => {
    const world = await fleetWorld();
    await writeFile(manifestPathOf(world), truncated());
    await world.provisioner().apply(planFor(world));
    const copy = await copyOf(world);
    const target = join(world.person, 'fixture-evidence');
    await writeFile(target, 'safe fixture marker');
    await unlink(copy);
    await symlink(target, copy);
    await writeFile(manifestPathOf(world), truncated());

    await world.provisioner().apply(planFor(world));

    expect(await readFile(target, 'utf8')).toBe('safe fixture marker');
    expect((await lstat(copy)).isFile()).toBe(true);
    expect(await readFile(copy, 'utf8')).toBe(truncated());
  });

  it('replaces a copy that has a second name, leaving the other name as it was', async () => {
    const world = await fleetWorld();
    await writeFile(manifestPathOf(world), truncated());
    await world.provisioner().apply(planFor(world));
    const copy = await copyOf(world);
    const other = join(world.person, 'fixture-second-name');
    await link(copy, other);
    await writeFile(manifestPathOf(world), truncated());

    await world.provisioner().apply(planFor(world));

    expect((await stat(copy)).nlink).toBe(1);
    expect(await readFile(other, 'utf8')).toBe(truncated());
  });

  it('says no private copy was kept when something that is not a file holds the name', async () => {
    const world = await fleetWorld();
    await writeFile(manifestPathOf(world), truncated());
    await world.provisioner().apply(planFor(world));
    const copy = await copyOf(world);
    await unlink(copy);
    await mkdir(copy);
    await writeFile(manifestPathOf(world), truncated());
    const said: string[] = [];

    await world.provisioner({ say: sentence => said.push(sentence) }).apply(planFor(world));

    expect(said[0]).toContain('could not be kept aside');
    expect(said[0]).not.toContain('owner-only');
    expect((await lstat(copy)).isDirectory()).toBe(true);
  });

  it('says no private copy was kept when an unverified one cannot be replaced', async () => {
    const world = await fleetWorld();
    await writeFile(manifestPathOf(world), truncated());
    await world.provisioner().apply(planFor(world));
    const copy = await copyOf(world);
    await chmod(copy, 0o644);
    await writeFile(manifestPathOf(world), truncated());
    const said: string[] = [];
    const disk = faultingDisk(world.disk, async (call, args) => {
      if (call === 'remove' && String(args[0]) === copy) throw new Error('disk refused the removal');
    });

    await world.provisioner({ disk, say: sentence => said.push(sentence) }).apply(planFor(world));

    expect(said[0]).toContain('could not be kept aside');
    expect(said[0]).not.toContain('owner-only');
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

  it('says so, and FAILS the job (so the runner retries it), when the manifest is unreadable and the configuration cannot be published yet', async () => {
    const { host, world } = await compose([]);
    await writeFile(manifestPathOf(world), withUnknownKey());

    await expect(host.runJob(REPAIR)).rejects.toThrow('could not be rebuilt yet');

    expect(host.logs.some(line => line.message.includes('could not be rebuilt yet'))).toBe(true);
    expect(await readFile(manifestPathOf(world), 'utf8')).toBe(withUnknownKey());
  });
});

describe('the homes reader on a manifest it cannot read for another reason', () => {
  it('keeps its plain sentence (not the retryable one) when the manifest cannot be read as a file at all', async () => {
    const world = await fleetWorld();
    await mkdir(manifestPathOf(world), { recursive: true });
    const api = fleetHomes(world.roots, new FleetPublication());

    const refusal = await api.homes().catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(RuntimeHomeUnreadable);
    expect((refusal as Error).message).toStartWith(`The fleet manifest at ${manifestPathOf(world)} could not be read.`);
    expect((refusal as Error).message).not.toContain('try again');
  });

  it('asks for the repair when it meets damage, and never when the manifest is fine or the failure is another one', async () => {
    const world = await fleetWorld();
    let asked = 0;
    const api = fleetHomes(
      world.roots,
      new FleetPublication(),
      () => {},
      () => {
        asked += 1;
      },
    );
    await writeFile(manifestPathOf(world), JSON.stringify(manifest()));
    await api.homes();
    await rmFile(manifestPathOf(world));
    await mkdir(manifestPathOf(world));
    await api.homes().catch(() => undefined);
    expect(asked).toBe(0);
    await rmFile(manifestPathOf(world));
    await writeFile(manifestPathOf(world), truncated());
    await api.homes().catch(() => undefined);
    expect(asked).toBe(1);
  });
});

const rmFile = async (path: string): Promise<void> => {
  await import('node:fs/promises').then(async fs => await fs.rm(path, { recursive: true, force: true }));
};

describe('the start boundary says the manifest is being rebuilt', () => {
  const START = { ferret: 'fixture-ferret', harness: 'claude-code', runtime: 'claude-default', by: 'start' } as never;

  it('LaunchGate.decide refuses a start over a damaged manifest with the retryable sentence, naming the file and no contents', async () => {
    const { host, world } = await compose();
    await publishOnce(host);
    await writeFile(manifestPathOf(world), withUnknownKey());
    const gate = new LaunchGate({ source: launchFactsSource({ roots: world.roots }) });

    const decision = await gate.decide(START);

    expect(decision.allow).toBe(false);
    const reason = (decision as { reason: string }).reason;
    expect(reason).toContain('runtime claude-default was not started');
    expect(reason).toContain(manifestPathOf(world));
    expect(reason).toContain('try again');
    expect(reason).not.toContain(MARKER);
  });

  it('any other failure to read the facts keeps the existing refusal', async () => {
    const gate = new LaunchGate({
      source: {
        facts: async () => {
          throw new Error('some other disk problem');
        },
      },
    });

    const decision = await gate.decide(START);

    expect(decision).toEqual({
      allow: false,
      reason:
        'the published runtimes could not be read, so runtime claude-default was not started: its compaction trigger cannot be checked against its model',
    });
  });
});

// ── the real JobRunner over a driven clock ──────────────────────────────────────────────────────────────────────────

async function scheduledCompose(failures = 0) {
  const world = await fleetWorld();
  const clock = fixedClock();
  const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
  const runner = new JobRunner(clock, silent as never);
  let attempts = 0;
  let assembled: ReturnType<typeof hostAssembly> | undefined;
  const host = await testHost({
    plugins: [
      runtimesDaemon(ctx => {
        const jobs = ctx.kernel.jobs;
        const add = jobs.add.bind(jobs);
        jobs.add = spec => {
          add(spec);
          if (spec.id === MANIFEST_REPAIR_JOB) runner.portFor('runtimes').add(spec);
        };
        jobs.kick = id => runner.portFor('runtimes').kick(id);
        const assembly = hostAssembly({ ...ctx, kernel: { ...ctx.kernel, roots: world.roots } } as never);
        const catalog = new Proxy(assembly.catalog, {
          get(target, property) {
            if (property === 'republish')
              return async (options: never) => {
                attempts += 1;
                if (attempts <= failures) throw new Error('temporary fixture provider failure');
                return await target.republish?.(options);
              };
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        assembled = { ...assembly, catalog };
        return assembled;
      }) as DaemonImplementation<any>,
    ],
    fakes: {
      ferrets: new FakeFerrets(),
      logins: fakeLogins([sampleLogin('claude-you', { store: 'ferretry' })]),
      loginChanges: fakeLoginChanges(),
    },
    gate: new StandInAdmission(() => ownerStanding()),
    config: CONFIG,
    ownerHome: world.person,
    executables: ['/fixture/bin/claude', '/fixture/bin/codex'],
    searchPath: '/fixture/bin',
    spawn: () => ({ code: 0, stdout: '', stderr: '' }) as never,
  });
  const advance = async (ms: number): Promise<void> => {
    await clock.advance(ms);
    await runner.settle();
  };
  const boot = async (): Promise<void> => {
    runner.start();
    await Promise.resolve();
    await advance(0);
  };
  const facts = () => {
    if (assembled?.launchFacts === undefined) throw new Error('the composed daemon has no launch facts');
    return assembled.launchFacts;
  };
  return { host, world, runner, clock, advance, boot, facts, assembly: () => assembled, attempts: () => attempts };
}

describe('the repair is retried by the real JobRunner until it works', () => {
  it('one transient failure: the job fails (not a successful terminal run), is retried with backoff, and then repairs on its own', async () => {
    const f = await scheduledCompose(1);
    try {
      await publishOnce(f.host);
      await writeFile(manifestPathOf(f.world), truncated());

      await f.boot();

      expect(f.attempts()).toBe(1);
      expect(f.runner.reports()[0]).toMatchObject({ runs: 0, failures: 1 });
      expect(f.clock.pending()).toBeGreaterThan(0);
      await expect(f.facts().facts('claude-default')).rejects.toBeInstanceOf(FleetManifestUnreadableError);

      await f.advance(1_000);

      expect(f.attempts()).toBe(2);
      expect(f.runner.reports()[0]).toMatchObject({ runs: 1, failures: 1 });
      expect(await f.facts().facts('claude-default')).toMatchObject({ kind: 'claude' });
      expect(await kept(f.world)).toHaveLength(1);
    } finally {
      await f.runner.stop();
    }
  });

  it('a repair that keeps failing keeps being retried, and a later success ends it', async () => {
    const f = await scheduledCompose(3);
    try {
      await publishOnce(f.host);
      await writeFile(manifestPathOf(f.world), withUnknownKey());
      await f.boot();
      await f.advance(1_000);
      await f.advance(5_000);
      expect(f.attempts()).toBe(3);
      await expect(f.facts().facts('claude-default')).rejects.toBeInstanceOf(FleetManifestUnreadableError);

      await f.advance(30_000);

      expect(f.attempts()).toBe(4);
      expect(await f.facts().facts('claude-default')).toMatchObject({ kind: 'claude' });
    } finally {
      await f.runner.stop();
    }
  });
});

describe('damage after a healthy boot is repaired without anyone asking', () => {
  const START = { ferret: 'fixture-ferret', harness: 'claude-code', runtime: 'claude-default', by: 'start' } as never;

  it('a healthy boot and healthy starts never publish', async () => {
    const f = await scheduledCompose();
    try {
      await publishOnce(f.host);
      const before = await readFile(manifestPathOf(f.world), 'utf8');
      await f.boot();
      const gate = new LaunchGate({ source: f.facts() });

      expect(await gate.decide(START)).toEqual({ allow: true });
      await f.advance(24 * 3_600_000);

      expect(f.attempts()).toBe(0);
      expect(await readFile(manifestPathOf(f.world), 'utf8')).toBe(before);
      expect(await kept(f.world)).toEqual([]);
    } finally {
      await f.runner.stop();
    }
  });

  it('healthy boot, then truncation: a start is refused retryably, the repair runs by itself, the next start passes', async () => {
    const f = await scheduledCompose();
    try {
      await publishOnce(f.host);
      await f.boot();
      expect(f.attempts()).toBe(0);
      await writeFile(manifestPathOf(f.world), truncated());
      const gate = new LaunchGate({ source: f.facts() });

      const refused = await gate.decide(START);

      expect(refused.allow).toBe(false);
      expect((refused as { reason: string }).reason).toContain('try again');
      await f.advance(0);
      expect(f.attempts()).toBe(1);
      expect(await gate.decide(START)).toEqual({ allow: true });
      expect(f.attempts()).toBe(1);
      expect(await kept(f.world)).toHaveLength(1);
    } finally {
      await f.runner.stop();
    }
  });

  it('a refused start never publishes by itself: only the repair job does, one at a time', async () => {
    const f = await scheduledCompose();
    try {
      await publishOnce(f.host);
      await f.boot();
      await writeFile(manifestPathOf(f.world), truncated());
      const source = f.facts();

      const refusals = await Promise.all(
        [1, 2, 3].map(() => source.facts('claude-default').catch((error: unknown) => error)),
      );
      await f.advance(0);

      for (const refusal of refusals) expect(refusal).toBeInstanceOf(FleetManifestUnreadableError);
      expect(f.attempts()).toBeLessThanOrEqual(2);
      expect(await source.facts('claude-default')).toMatchObject({ kind: 'claude' });
    } finally {
      await f.runner.stop();
    }
  });

  it('the homes reader asks for the repair too (a Codex start never reads the launch facts)', async () => {
    const f = await scheduledCompose();
    try {
      await publishOnce(f.host);
      await f.boot();
      await writeFile(manifestPathOf(f.world), withUnknownKey());
      const homes = f.assembly()?.homes;
      if (homes === undefined) throw new Error('the composed daemon has no homes reader');

      await expect(homes.homes()).rejects.toBeInstanceOf(RuntimeHomeUnreadable);
      await f.advance(0);

      expect(f.attempts()).toBe(1);
      expect((await homes.homes()).length).toBeGreaterThan(0);
    } finally {
      await f.runner.stop();
    }
  });
});

describe('the repair requester', () => {
  it('asks the job runner to run the repair job, and says nothing when this daemon has no such job', () => {
    const asked: string[] = [];
    repairRequester({ jobs: { add: () => {}, kick: id => asked.push(id) } })();
    expect(asked).toEqual([MANIFEST_REPAIR_JOB]);
    expect(() =>
      repairRequester({
        jobs: {
          add: () => {},
          kick: () => {
            throw new TypeError('no job');
          },
        },
      })(),
    ).not.toThrow();
  });
});
