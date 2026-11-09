/**
 * R2 (m-B): the daemon's REAL etag wiring. `fileAssembly(...).profileEtag` is what `profiles()` hands a caller and what a
 * change is pinned to; every other test injects an etag or stands on the testing host. Here nothing is injected:
 *
 * - the kernel's REAL config service runs on a real temporary home (a plain, a CRLF and a byte-order-mark profile file);
 * - `fileAssembly` is built over its port and the kernel's real roots;
 * - the profile layers are composed exactly as the daemon composes them (`daemon/index.ts`): the assembly's etag, the
 *   port's `writeAll`, the catalogue's one-at-a-time section.
 *
 * So `profiles()`, `changeProfileLayers` add and remove run against the writer that judges the `ifMatch`. The old reading
 * (the files through `host.files`) refused every one of these paths: `config/` is no folder Runtimes may read.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config as kernelConfig, state as kernelState } from '@ferretry/kernel/host';
import type { KernelPorts } from '@ferretry/kernel/contract';
import { PROFILE_ITEMS, RUNTIME_ITEMS, type RuntimesApi } from '../../../contract/index.ts';
import { documentRevision } from '../../../daemon/adapters/account-model-files.ts';
import { fileAssembly } from '../../../daemon/host-assembly.ts';
import { createProfileLayers } from '../../../daemon/lib/service/profile-layers.ts';
import { FleetPublication } from '../../../daemon/lib/service/publication.ts';
import { cleanupWorlds, fleetWorld, type FleetWorld } from '../support/fleet-world.ts';

afterEach(cleanupWorlds);

const owner = { governed: false, decide: () => ({ allowed: true, refusal: 'granted' }) };

const FILES: Readonly<Record<string, string | Uint8Array>> = {
  plain: 'contents:\n  - mcp/one\n',
  crlf: 'contents:\r\n  - mcp/one\r\n',
  bom: new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('contents:\n  - mcp/one\n')]),
};

const needs = {
  logins: { list: async () => ({ logins: [] }), environmentTemplates: async () => [] },
  loginChanges: {},
  ferrets: { list: async () => [] },
} as never;

async function realWorld(world: FleetWorld) {
  const profiles = join(world.home, 'config', 'profiles');
  await mkdir(profiles, { recursive: true });
  for (const [name, content] of Object.entries(FILES)) await writeFile(join(profiles, `${name}.yaml`), content);
  const cancel = () => undefined;
  const config = kernelConfig.createConfigFiles({
    home: world.home,
    fs: kernelState.createNodeHostFs(),
    clock: { nowMs: () => 1_000, after: () => cancel, every: () => cancel },
    log: { debug() {}, info() {}, warn() {}, error() {}, child: () => undefined } as never,
    binary: 'fy',
    defs: [
      { plugin: 'runtimes', def: PROFILE_ITEMS as never },
      { plugin: 'runtimes', def: RUNTIME_ITEMS as never },
    ],
  });
  await config.reload();
  const port = config.port('runtimes');
  const kernel = {
    roots: world.roots,
    paths: { home: () => world.person, which: async () => undefined },
    clock: { nowMs: () => 1_000, after: () => () => undefined },
    log: { warn: () => undefined },
    config: port,
  } as unknown as Pick<KernelPorts, 'roots' | 'paths' | 'clock' | 'log'> & {
    config: Pick<KernelPorts['config'], 'writeAll' | 'collection' | 'file' | 'etag'>;
  };
  const assembly = fileAssembly({ kernel, needs, hooks: { provider: () => 'unavailable' } }, new FleetPublication());
  const api: Pick<RuntimesApi, 'profiles' | 'changeProfileLayers'> = createProfileLayers({
    runtimes: () => port.collection(RUNTIME_ITEMS as never),
    profiles: () => port.collection(PROFILE_ITEMS as never),
    etag: assembly.profileEtag,
    writeAll: async documents => await port.writeAll(documents),
    serialise: async act => await assembly.catalog.serialise(act),
  });
  return {
    api,
    assembly,
    /** The etag the kernel's config service reckons for the file, read from the service itself. */
    kernelEtag: async (name: string): Promise<string | undefined> =>
      (await config.read('runtimes', PROFILE_ITEMS as never, name))?.etag,
    onDisk: async (name: string): Promise<string> => await readFile(join(profiles, `${name}.yaml`), 'utf8'),
    profilesDirectory: profiles,
  };
}

describe('R2 the profile layers over the kernel’s real config service, nothing injected', () => {
  for (const name of Object.keys(FILES)) {
    it(`R2 should list a ${name} profile with the etag the kernel reckons, and take it as ifMatch for an add`, async () => {
      // Arrange
      const world = await realWorld(await fleetWorld());

      // Act
      const listed = (await world.api.profiles()).find(profile => profile.name === name);
      const reckoned = await world.kernelEtag(name);
      const outcome = await world.api.changeProfileLayers(
        { kind: 'add', profile: name, layer: 'mcp/two', ifMatch: listed?.etag },
        owner,
      );

      // Assert — the etag IS the kernel's, and a real write pinned to it lands (not a permanent conflict).
      expect(reckoned).toBeDefined();
      expect(listed?.etag).toBe(reckoned as string);
      expect(outcome).toEqual({ kind: 'written', profiles: [name] });
      expect(await world.onDisk(name)).toContain('mcp/two');
    });
  }

  it('R2 should answer a conflict, and write nothing, for the etag a profile had before it moved', async () => {
    // Arrange
    const world = await realWorld(await fleetWorld());
    const stale = (await world.api.profiles()).find(profile => profile.name === 'bom')?.etag;
    await world.api.changeProfileLayers({ kind: 'add', profile: 'bom', layer: 'mcp/first' }, owner);
    const before = await world.onDisk('bom');

    // Act
    const outcome = await world.api.changeProfileLayers(
      { kind: 'add', profile: 'bom', layer: 'mcp/second', ifMatch: stale },
      owner,
    );

    // Assert
    expect(outcome).toEqual({ kind: 'conflict', profile: 'bom' });
    expect(await world.onDisk('bom')).toBe(before);
  });

  it('R2 should remove a layer from every profile that names it, a BOM and a CRLF file included, in one set', async () => {
    // Arrange
    const world = await realWorld(await fleetWorld());

    // Act
    const outcome = await world.api.changeProfileLayers({ kind: 'remove-everywhere', layer: 'mcp/one' }, owner);

    // Assert
    expect(outcome).toEqual({ kind: 'written', profiles: ['bom', 'crlf', 'plain'] });
    for (const name of Object.keys(FILES)) expect(await world.onDisk(name)).not.toContain('mcp/one');
  });

  it('R2 should not answer the raw-bytes revision an apply is pinned to, for the byte-order-mark file', async () => {
    // Arrange
    const world = await realWorld(await fleetWorld());
    const raw = await documentRevision(
      { readBytes: async path => new Uint8Array(await Bun.file(path).arrayBuffer()) },
      join(world.profilesDirectory, 'bom.yaml'),
    );

    // Act + Assert
    expect(await world.assembly.profileEtag('bom')).not.toBe(raw);
  });

  it('R2 should answer the absent sentinel for a profile that has no file', async () => {
    // Arrange
    const world = await realWorld(await fleetWorld());

    // Act + Assert
    expect(await world.assembly.profileEtag('nothing')).toBe('absent');
  });
});
