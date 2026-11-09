/**
 * R2: two things the other R2 tests cannot show because they stand on the testing host, whose config files are VALUES
 * with a JSON etag.
 *
 * 1. The etag a caller reads from `profiles()` is the one the KERNEL's writer compares. Here the real config service
 *    runs over a memory filesystem, with a plain file, a CRLF file, a file with a byte-order mark and one that is not
 *    UTF-8, and the etag the host reads is paired with the writer's own and then used as `ifMatch` for a real write.
 * 2. The contract FAKE (`fakeRuntimes`) and the real service give the SAME outcome, and leave the same profiles, on one
 *    shared table of cases, so a wave-2 test driven by the fake cannot pass against an answer the daemon never gives.
 */
import { describe, it } from 'bun:test';
import { config as kernelConfig, state as kernelState } from '@ferretry/kernel/host';
import should from 'should';
import {
  type ProfileLayerChange,
  type ProfileLayerOutcome,
  PROFILE_ITEMS,
  RUNTIME_ITEMS,
  type RuntimesApi,
} from '../../../contract/index.ts';
import { fakeRuntimes } from '../../../contract/testing/index.ts';
import { documentRevision } from '../../../daemon/adapters/account-model-files.ts';
import { createProfileLayers } from '../../../daemon/lib/service/profile-layers.ts';

const HOME = '/home/fy';
const PROFILES = `${HOME}/config/profiles`;

const owner = { governed: false, decide: () => ({ allowed: true, refusal: 'granted' }) };
const denied = { governed: true, decide: () => ({ allowed: false, refusal: 'forbidden' }) };
const needsPasskey = { governed: true, decide: () => ({ allowed: false, refusal: 'step-up-required' }) };
const holdsOnly = (held: 'use' | 'configure') => ({
  governed: true,
  decide: (demand: { readonly axis: string }) =>
    demand.axis === held ? { allowed: true, refusal: 'granted' } : { allowed: false, refusal: 'forbidden' },
});
const throwing = {
  governed: true,
  decide: () => {
    throw new Error('the grant document is unreadable');
  },
};

/** The REAL service: Runtimes' profile layers over the kernel's real config service on memory. */
async function realWorld(files: Readonly<Record<string, string | Uint8Array>>) {
  const fs = kernelState.createMemoryHostFs();
  const cancel = () => undefined;
  const config = kernelConfig.createConfigFiles({
    home: HOME,
    fs,
    clock: { nowMs: () => 0, after: () => cancel, every: () => cancel },
    log: { debug() {}, info() {}, warn() {}, error() {}, child: () => undefined } as never,
    binary: 'fy',
    defs: [
      { plugin: 'runtimes', def: PROFILE_ITEMS as never },
      { plugin: 'runtimes', def: RUNTIME_ITEMS as never },
    ],
  });
  for (const [name, content] of Object.entries(files)) fs.seed(`${PROFILES}/${name}.yaml`, content);
  await config.reload();
  const port = config.port('runtimes');
  // The kernel's own answer for Runtimes' own file: the etag the writer below compares an `ifMatch` with.
  const etagOf = async (name: string): Promise<string> => await port.etag(PROFILE_ITEMS as never, name);
  const api: RuntimesApi = {
    ...fakeRuntimes(),
    ...createProfileLayers({
      runtimes: () => port.collection(RUNTIME_ITEMS as never),
      profiles: () => port.collection(PROFILE_ITEMS as never),
      etag: etagOf,
      state: name => port.fileState(PROFILE_ITEMS as never, name),
      writeAll: async documents => await port.writeAll(documents),
      serialise: async act => await act(),
    }),
  };
  return { api, fs, config, etagOf, diskOf: (name: string) => fs.snapshot().get(`${PROFILES}/${name}.yaml`) };
}

describe('R2 the etag profiles() gives is the kernel writer’s own', () => {
  const FILES: Record<string, string | Uint8Array> = {
    plain: 'contents:\n  - mcp/one\n',
    crlf: 'contents:\r\n  - mcp/one\r\n',
    bom: new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('contents:\n  - mcp/one\n')]),
    latin1: new Uint8Array([
      ...new TextEncoder().encode('# caf'),
      0xe9,
      ...new TextEncoder().encode('\ncontents:\n  - mcp/one\n'),
    ]),
  };

  for (const name of Object.keys(FILES)) {
    it(`R2 should read, from a ${name} file, the etag the real writer compares, and have it accepted as ifMatch`, async () => {
      // Arrange
      const { api, config, diskOf } = await realWorld(FILES);
      const written = await config.read('runtimes', PROFILE_ITEMS as never, name);

      // Act
      const summary = (await api.profiles()).find(profile => profile.name === name);
      const outcome = await api.changeProfileLayers(
        { kind: 'add', profile: name, layer: 'mcp/two', ifMatch: summary?.etag },
        owner,
      );

      // Assert — the etag IS the kernel's, and a real write pinned to it lands (not a permanent conflict).
      should(summary?.etag).equal(written?.etag);
      should(outcome).deepEqual({ kind: 'written', profiles: [name] });
      should(diskOf(name)).containEql('mcp/two');
    });
  }

  it('R2 should have hashed the raw bytes differently for a BOM and a non-UTF-8 file (why the kernel’s reckoning is used)', async () => {
    // Arrange
    const { fs, etagOf } = await realWorld(FILES);

    // Act + Assert — the raw-bytes revision (the apply's pin) differs from the writer's etag for exactly these two.
    for (const name of ['bom', 'latin1'])
      should(await documentRevision(fs, `${PROFILES}/${name}.yaml`)).not.equal(await etagOf(name));
    for (const name of ['plain', 'crlf'])
      should(await documentRevision(fs, `${PROFILES}/${name}.yaml`)).equal(await etagOf(name));
  });

  it('R2 should answer a stale etag of a BOM file as a conflict, and write nothing', async () => {
    // Arrange
    const { api, diskOf } = await realWorld(FILES);
    const before = diskOf('bom');

    // Act
    const outcome = await api.changeProfileLayers(
      { kind: 'add', profile: 'bom', layer: 'mcp/two', ifMatch: 'not-its-etag' },
      owner,
    );

    // Assert
    should(outcome).deepEqual({ kind: 'conflict', profile: 'bom' });
    should(diskOf('bom')).equal(before);
  });

  it('R2 should say the etag of a profile that is not there is the absent sentinel the writer uses', async () => {
    // Arrange
    const { etagOf } = await realWorld({});

    // Act + Assert
    should(await etagOf('nothing')).equal('absent');
  });
});

type Marker = 'fresh' | 'stale' | undefined;

interface Case {
  readonly name: string;
  /** The profile files, by name: the layers each names. */
  readonly profiles: Readonly<Record<string, readonly string[]>>;
  readonly change:
    | { readonly kind: 'add'; readonly profile: string; readonly layer: string; readonly ifMatch?: Marker }
    | { readonly kind: 'remove-everywhere'; readonly layer: string };
  readonly governance: unknown;
  readonly outcome: ProfileLayerOutcome;
}

const PROFILE_SET = {
  a: ['instructions/notes', 'mcp/shared'],
  b: ['mcp/shared', 'skills/pdf'],
  c: ['skills/pdf'],
} as const;
const refusedWith = (
  sentence: string,
  code: 'fleet_change_unknown' | 'fleet_change_refused' = 'fleet_change_refused',
) => ({ kind: 'refused', code, sentence }) as const;
const UNKNOWN_CALLER = refusedWith('this daemon cannot say whether this caller may change the fleet');
const NAME_SENTENCE = 'a layer name is letters and digits joined by single dashes, at most 64 characters';

const CASES: readonly Case[] = [
  {
    name: 'an owner adds a new layer',
    profiles: PROFILE_SET,
    change: { kind: 'add', profile: 'c', layer: 'mcp/notes' },
    governance: owner,
    outcome: { kind: 'written', profiles: ['c'] },
  },
  {
    name: 'an owner adds a layer with the etag it just read',
    profiles: PROFILE_SET,
    change: { kind: 'add', profile: 'c', layer: 'mcp/notes', ifMatch: 'fresh' },
    governance: owner,
    outcome: { kind: 'written', profiles: ['c'] },
  },
  {
    name: 'an add with a stale etag is a conflict',
    profiles: PROFILE_SET,
    change: { kind: 'add', profile: 'c', layer: 'mcp/notes', ifMatch: 'stale' },
    governance: owner,
    outcome: { kind: 'conflict', profile: 'c' },
  },
  {
    name: 'adding a layer already there is a no-op written',
    profiles: PROFILE_SET,
    change: { kind: 'add', profile: 'a', layer: 'mcp/shared' },
    governance: owner,
    outcome: { kind: 'written', profiles: [] },
  },
  {
    name: 'adding a layer already there with a stale etag is still a conflict',
    profiles: PROFILE_SET,
    change: { kind: 'add', profile: 'a', layer: 'mcp/shared', ifMatch: 'stale' },
    governance: owner,
    outcome: { kind: 'conflict', profile: 'a' },
  },
  {
    name: 'adding to a profile that does not exist',
    profiles: PROFILE_SET,
    change: { kind: 'add', profile: 'ghost', layer: 'mcp/x' },
    governance: owner,
    outcome: refusedWith('profile ghost does not exist', 'fleet_change_unknown'),
  },
  {
    name: 'a layer that is not mcp/ or skills/',
    profiles: PROFILE_SET,
    change: { kind: 'add', profile: 'c', layer: 'hooks/x' },
    governance: owner,
    outcome: refusedWith('a layer is written mcp/<name> or skills/<name>'),
  },
  {
    name: 'a layer name with a slash look-alike',
    profiles: PROFILE_SET,
    change: { kind: 'add', profile: 'c', layer: 'mcp/a∕b' },
    governance: owner,
    outcome: refusedWith(NAME_SENTENCE),
  },
  {
    name: 'a layer name with a direction override, on remove-everywhere',
    profiles: PROFILE_SET,
    change: { kind: 'remove-everywhere', layer: 'mcp/x‮exe' },
    governance: owner,
    outcome: refusedWith(NAME_SENTENCE),
  },
  {
    name: 'an add by a caller that carries no governance',
    profiles: PROFILE_SET,
    change: { kind: 'add', profile: 'c', layer: 'mcp/notes' },
    governance: undefined,
    outcome: UNKNOWN_CALLER,
  },
  {
    name: 'a thing that only looks like a governance',
    profiles: PROFILE_SET,
    change: { kind: 'add', profile: 'c', layer: 'mcp/notes' },
    governance: { governed: false },
    outcome: UNKNOWN_CALLER,
  },
  {
    name: 'a caller with no standing is judged before the layer name or the profile',
    profiles: PROFILE_SET,
    change: { kind: 'add', profile: 'ghost', layer: 'mcp/a∕b' },
    governance: undefined,
    outcome: UNKNOWN_CALLER,
  },
  {
    name: 'a device that may not configure the fleet',
    profiles: PROFILE_SET,
    change: { kind: 'add', profile: 'c', layer: 'mcp/notes' },
    governance: denied,
    outcome: refusedWith('this device may not change profiles/c.yaml'),
  },
  {
    name: 'a device that needs a passkey',
    profiles: PROFILE_SET,
    change: { kind: 'add', profile: 'c', layer: 'mcp/notes' },
    governance: needsPasskey,
    outcome: refusedWith('changing profiles/c.yaml from this device needs a passkey confirmation'),
  },
  {
    name: 'a device that holds only fleet.use',
    profiles: PROFILE_SET,
    change: { kind: 'add', profile: 'c', layer: 'mcp/notes' },
    governance: holdsOnly('use'),
    outcome: refusedWith('this device may not change profiles/c.yaml'),
  },
  {
    name: 'a device that holds only fleet.configure',
    profiles: PROFILE_SET,
    change: { kind: 'add', profile: 'c', layer: 'mcp/notes' },
    governance: holdsOnly('configure'),
    outcome: refusedWith('this device may not read profiles/c.yaml'),
  },
  {
    name: 'a standing that throws',
    profiles: PROFILE_SET,
    change: { kind: 'add', profile: 'c', layer: 'mcp/notes' },
    governance: throwing,
    outcome: UNKNOWN_CALLER,
  },
  {
    name: 'an owner removes a layer everywhere',
    profiles: PROFILE_SET,
    change: { kind: 'remove-everywhere', layer: 'mcp/shared' },
    governance: owner,
    outcome: { kind: 'written', profiles: ['a', 'b'] },
  },
  {
    name: 'removing a layer nobody names',
    profiles: PROFILE_SET,
    change: { kind: 'remove-everywhere', layer: 'mcp/nobody' },
    governance: owner,
    outcome: { kind: 'written', profiles: [] },
  },
  {
    name: 'remove-everywhere by a caller that carries no governance',
    profiles: PROFILE_SET,
    change: { kind: 'remove-everywhere', layer: 'mcp/shared' },
    governance: undefined,
    outcome: UNKNOWN_CALLER,
  },
  {
    name: 'remove-everywhere by a device that may not configure',
    profiles: PROFILE_SET,
    change: { kind: 'remove-everywhere', layer: 'mcp/shared' },
    governance: denied,
    outcome: refusedWith('this device may not change the profile files'),
  },
  {
    name: 'remove-everywhere by a device that needs a passkey',
    profiles: PROFILE_SET,
    change: { kind: 'remove-everywhere', layer: 'mcp/shared' },
    governance: needsPasskey,
    outcome: refusedWith('changing the profile files from this device needs a passkey confirmation'),
  },
];

const yamlOf = (layers: readonly string[]): string => `contents:\n${layers.map(layer => `  - ${layer}\n`).join('')}`;

describe('R2 the contract fake and the real service answer a change alike', () => {
  for (const found of CASES) {
    it(`R2 should answer "${found.name}" the same, and leave the same profiles`, async () => {
      // Arrange — the real service on the case's files, and the fake holding the very profiles it reads.
      const { api: real } = await realWorld(
        Object.fromEntries(Object.entries(found.profiles).map(([name, layers]) => [name, yamlOf(layers)])),
      );
      const fake = fakeRuntimes();
      fake.setProfiles(await real.profiles());
      const resolve = async (api: RuntimesApi): Promise<ProfileLayerChange> => {
        if (found.change.kind === 'remove-everywhere') return found.change as ProfileLayerChange;
        const marker = found.change.ifMatch;
        const etag =
          marker === 'fresh'
            ? (await api.profiles()).find(profile => profile.name === (found.change as { profile: string }).profile)
                ?.etag
            : marker === 'stale'
              ? 'not-the-etag'
              : undefined;
        return { ...found.change, ifMatch: etag } as ProfileLayerChange;
      };
      const stateOf = async (api: RuntimesApi) =>
        (await api.profiles()).map(profile => ({ name: profile.name, layers: profile.layers }));

      // Act
      const fromReal = await real.changeProfileLayers(await resolve(real), found.governance);
      const fromFake = await fake.changeProfileLayers(await resolve(fake), found.governance);

      // Assert
      should(fromReal).deepEqual(found.outcome);
      should(fromFake).deepEqual(fromReal);
      should(await stateOf(fake)).deepEqual(await stateOf(real));
    });
  }

  it('R2 should let a test drive held, which no profile edit of the real act can give, once the caller was judged', async () => {
    // Arrange
    const fake = fakeRuntimes();
    fake.setProfiles([{ name: 'c', layers: ['skills/pdf'], etag: 'e1' }]);
    fake.setChangeOutcome({ kind: 'held', sentence: 'held for the owner' });

    // Act
    const governed = await fake.changeProfileLayers({ kind: 'add', profile: 'c', layer: 'mcp/x' }, owner);
    const ungoverned = await fake.changeProfileLayers({ kind: 'add', profile: 'c', layer: 'mcp/x' });
    fake.setChangeOutcome(change =>
      change.kind === 'add' ? { kind: 'conflict', profile: change.profile } : undefined,
    );
    const conflict = await fake.changeProfileLayers({ kind: 'add', profile: 'c', layer: 'mcp/x' }, owner);
    const faithful = await fake.changeProfileLayers({ kind: 'remove-everywhere', layer: 'skills/pdf' }, owner);

    // Assert
    should(governed).deepEqual({ kind: 'held', sentence: 'held for the owner' });
    should(ungoverned).deepEqual(UNKNOWN_CALLER);
    should(conflict).deepEqual({ kind: 'conflict', profile: 'c' });
    should(faithful).deepEqual({ kind: 'written', profiles: ['c'] });
    should(fake.changes.length).equal(4);
  });

  it('R2 should give a profile a new etag when the fake edits it, so a stale ifMatch conflicts as the real one does', async () => {
    // Arrange
    const fake = fakeRuntimes();
    fake.setProfiles([{ name: 'c', layers: [], etag: 'e1' }]);

    // Act
    const first = await fake.changeProfileLayers({ kind: 'add', profile: 'c', layer: 'mcp/x', ifMatch: 'e1' }, owner);
    const again = await fake.changeProfileLayers({ kind: 'add', profile: 'c', layer: 'mcp/y', ifMatch: 'e1' }, owner);

    // Assert
    should(first).deepEqual({ kind: 'written', profiles: ['c'] });
    should(again).deepEqual({ kind: 'conflict', profile: 'c' });
    should((await fake.profiles())[0]?.etag).not.equal('e1');
  });
});
