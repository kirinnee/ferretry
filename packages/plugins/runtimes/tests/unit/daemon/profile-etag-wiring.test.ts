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
  /** Runs right after an etag is answered and before its caller reads the value: the window an edit can land in. */
  const hooks: { afterEtag?: (name: string) => Promise<void>; beforeWrite?: () => Promise<void> } = {};
  const api: Pick<RuntimesApi, 'profiles' | 'changeProfileLayers'> = createProfileLayers({
    runtimes: () => port.collection(RUNTIME_ITEMS as never),
    profiles: () => port.collection(PROFILE_ITEMS as never),
    etag: async name => {
      const answered = await assembly.profileEtag(name);
      await hooks.afterEtag?.(name);
      return answered;
    },
    state: name => port.fileState(PROFILE_ITEMS as never, name),
    writeAll: async documents => {
      await hooks.beforeWrite?.();
      return await port.writeAll(documents);
    },
    serialise: async act => await assembly.catalog.serialise(act),
  });
  return {
    api,
    assembly,
    hooks,
    /** The kernel's config service reloads from disk (what the watcher does after its debounce). */
    reload: async (): Promise<void> => {
      await config.reload();
    },
    /** Someone edits the file behind the service: written to disk, no reload (the watcher's debounce, or no watcher). */
    editBehind: async (name: string, text: string): Promise<void> => {
      await writeFile(join(profiles, `${name}.yaml`), text);
    },
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

  const THEIRS = 'contents:\n  - mcp/one\n  - mcp/theirs\n';

  it('R2 M-1 should keep an on-disk edit the service has not reloaded when a layer is added without an ifMatch', async () => {
    // Arrange — the service loaded `plain`, then someone edited the file; nothing has reloaded it.
    const world = await realWorld(await fleetWorld());
    await world.editBehind('plain', THEIRS);

    // Act
    const outcome = await world.api.changeProfileLayers({ kind: 'add', profile: 'plain', layer: 'mcp/two' }, owner);

    // Assert — the edit was read before the write was built: it is still there, and the new layer is on top of it.
    expect(outcome).toEqual({ kind: 'written', profiles: ['plain'] });
    expect((await world.onDisk('plain')).split('contents:\n')[1]).toBe('  - mcp/one\n  - mcp/theirs\n  - mcp/two\n');
  });

  it('R2 M-1 should keep an on-disk edit the service has not reloaded when a layer is removed everywhere', async () => {
    // Arrange
    const world = await realWorld(await fleetWorld());
    await world.editBehind('plain', THEIRS);

    // Act
    const outcome = await world.api.changeProfileLayers({ kind: 'remove-everywhere', layer: 'mcp/one' }, owner);

    // Assert — only the named layer went from the edited file; their addition survives.
    expect(outcome).toEqual({ kind: 'written', profiles: ['bom', 'crlf', 'plain'] });
    expect((await world.onDisk('plain')).split('contents:\n')[1]).toBe('  - mcp/theirs\n');
  });

  it('R2 M-1 should refuse an add, and leave an edit that lands between the etag and the read byte for byte', async () => {
    // Arrange — the file moves AFTER its etag was answered and BEFORE the value is read.
    const world = await realWorld(await fleetWorld());
    world.hooks.afterEtag = async name => {
      world.hooks.afterEtag = undefined;
      await world.editBehind(name, THEIRS);
    };

    // Act
    const outcome = await world.api.changeProfileLayers({ kind: 'add', profile: 'plain', layer: 'mcp/two' }, owner);

    // Assert — the value read is older than the disk, so the writer's ifMatch fails: a conflict, nothing written.
    expect(outcome).toEqual({ kind: 'conflict', profile: 'plain' });
    expect(await world.onDisk('plain')).toBe(THEIRS);
  });

  it('R2 M-1 should refuse a remove-everywhere, and leave an edit that lands between an etag and its read byte for byte', async () => {
    // Arrange — every profile's etag is taken first; `plain` moves right after its own etag.
    const world = await realWorld(await fleetWorld());
    world.hooks.afterEtag = async name => {
      if (name !== 'plain') return;
      world.hooks.afterEtag = undefined;
      await world.editBehind(name, THEIRS);
    };

    // Act
    const outcome = await world.api.changeProfileLayers({ kind: 'remove-everywhere', layer: 'mcp/one' }, owner);

    // Assert — one set: the stale pin refuses the WHOLE set, so no other profile changed either.
    expect(outcome).toEqual({ kind: 'conflict', profile: 'plain' });
    expect(await world.onDisk('plain')).toBe(THEIRS);
    expect(await world.onDisk('crlf')).toBe(FILES.crlf as string);
  });

  it('R2 M-1 should list the layers an unreloaded edit made, under the etag that describes them', async () => {
    // Arrange
    const world = await realWorld(await fleetWorld());
    await world.editBehind('plain', THEIRS);

    // Act
    const listed = (await world.api.profiles()).find(profile => profile.name === 'plain');
    const outcome = await world.api.changeProfileLayers(
      { kind: 'add', profile: 'plain', layer: 'mcp/two', ifMatch: listed?.etag },
      owner,
    );

    // Assert — the listing is not stale layers under a fresh etag: a write pinned to it lands on the edited file.
    expect(listed?.layers).toEqual(['mcp/one', 'mcp/theirs']);
    expect(outcome).toEqual({ kind: 'written', profiles: ['plain'] });
  });

  it('R2 should answer the absent sentinel for a profile that has no file', async () => {
    // Arrange
    const world = await realWorld(await fleetWorld());

    // Act + Assert
    expect(await world.assembly.profileEtag('nothing')).toBe('absent');
  });

  describe('R2 M-1 a profile file that is BROKEN on disk is never written over', () => {
    const BAD_YAML = '# my careful notes\ncontents:\n  - mcp/one\n  - mcp/theirs\nbroken: [unclosed\n';
    const BAD_LAYER = '# notes\ncontents:\n  - mcp/one\n  - mcp/theirs\n  - Not A Layer\n';
    const NOT_A_STRING = 'contents:\n  - mcp/one\n  - { a: 1 }\n';
    const FIXED = 'contents:\n  - mcp/one\n  - mcp/theirs\n';
    const BROKEN: readonly (readonly [string, string])[] = [
      ['bad YAML', BAD_YAML],
      ['a layer that names nothing', BAD_LAYER],
      ['a layer that is not a string', NOT_A_STRING],
    ];

    for (const [kind, text] of BROKEN) {
      it(`R2 M-1 should refuse an add, naming the file and the problem, for a profile with ${kind}, and leave its bytes`, async () => {
        // Arrange — `plain` was good when loaded; the owner then breaks it by hand (the last good value stays in effect).
        const world = await realWorld(await fleetWorld());
        await world.editBehind('plain', text);

        // Act
        const outcome = await world.api.changeProfileLayers({ kind: 'add', profile: 'plain', layer: 'mcp/two' }, owner);

        // Assert
        expect(outcome.kind).toBe('refused');
        const sentence = outcome.kind === 'refused' ? outcome.sentence : '';
        expect(sentence).toContain('profiles/plain.yaml');
        expect(sentence).toContain('nothing was changed');
        expect(await world.onDisk('plain')).toBe(text);
      });

      it(`R2 M-1 should refuse the WHOLE remove-everywhere set when one of three profiles has ${kind}, writing nothing`, async () => {
        // Arrange — all three name `mcp/one`; only `crlf` is broken.
        const world = await realWorld(await fleetWorld());
        await world.editBehind('crlf', text);
        const before = { plain: await world.onDisk('plain'), crlf: text, bom: await world.onDisk('bom') };

        // Act
        const outcome = await world.api.changeProfileLayers({ kind: 'remove-everywhere', layer: 'mcp/one' }, owner);

        // Assert — refused, and the two good files are byte for byte what they were (atomic).
        expect(outcome.kind).toBe('refused');
        expect(outcome.kind === 'refused' ? outcome.sentence : '').toContain('profiles/crlf.yaml');
        expect(await world.onDisk('plain')).toBe(before.plain);
        expect(await world.onDisk('crlf')).toBe(before.crlf);
        expect(await world.onDisk('bom')).toBe(before.bom);
      });
    }

    it('R2 M-1 should write the same add once the owner has fixed the file', async () => {
      // Arrange
      const world = await realWorld(await fleetWorld());
      await world.editBehind('plain', BAD_YAML);
      const call = () => world.api.changeProfileLayers({ kind: 'add', profile: 'plain', layer: 'mcp/two' }, owner);
      expect((await call()).kind).toBe('refused');

      // Act — the owner fixes the file; the very same call.
      await world.editBehind('plain', FIXED);
      const outcome = await call();

      // Assert
      expect(outcome).toEqual({ kind: 'written', profiles: ['plain'] });
      expect((await world.onDisk('plain')).split('contents:\n')[1]).toBe('  - mcp/one\n  - mcp/theirs\n  - mcp/two\n');
    });

    it('R2 M-1 should write the same remove-everywhere once the owner has fixed the file', async () => {
      // Arrange
      const world = await realWorld(await fleetWorld());
      await world.editBehind('crlf', BAD_LAYER);
      const call = () => world.api.changeProfileLayers({ kind: 'remove-everywhere', layer: 'mcp/one' }, owner);
      expect((await call()).kind).toBe('refused');

      // Act
      await world.editBehind('crlf', FIXED);
      const outcome = await call();

      // Assert
      expect(outcome).toEqual({ kind: 'written', profiles: ['bom', 'crlf', 'plain'] });
      expect((await world.onDisk('crlf')).split('contents:\n')[1]).toBe('  - mcp/theirs\n');
    });
  });

  it('R2 M-1 should answer a conflict, and write nothing, when an edit AND a reload land between the value read and the write', async () => {
    // Arrange — the `ifMatch` pin is the only thing that can see this: after the reload the kernel's own view agrees with
    // the disk, so a write without the pin would land on the value read before the edit and lose it.
    const world = await realWorld(await fleetWorld());
    world.hooks.beforeWrite = async () => {
      world.hooks.beforeWrite = undefined;
      await world.editBehind('plain', THEIRS);
      await world.reload();
    };

    // Act
    const outcome = await world.api.changeProfileLayers({ kind: 'add', profile: 'plain', layer: 'mcp/two' }, owner);

    // Assert
    expect(outcome).toEqual({ kind: 'conflict', profile: 'plain' });
    expect(await world.onDisk('plain')).toBe(THEIRS);
  });
});
