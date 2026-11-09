/**
 * R2: `profiles()`, `layers()` and `changeProfileLayers()` on the `runtimes` port, through the kernel's testing host
 * (the real config rules: per-document `ifMatch`, the same judge, all-or-none). A spy on `ConfigPort.writeAll` sees every
 * document the act writes, so "exactly one profile file" and "nothing else" are asserted on what was handed to the
 * writer, and the files' own values are compared before and after.
 */
import { afterEach, describe, it } from 'bun:test';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { ConfigCollectionDef, ConfigWriteAllDocument, KernelPorts } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import { fakeLoginChanges, fakeLogins } from '@ferretry/plugin-logins/contract/testing';
import should from 'should';
import {
  MODEL_SET_ITEMS,
  PROFILE_ITEMS,
  RUNTIME_ITEMS,
  RuntimeIdSchema,
  RuntimesPort,
  type RuntimesApi,
} from '../../../contract/index.ts';
import { type RuntimesAssembly, runtimesDaemon, unavailableAssembly } from '../../../daemon/index.ts';
import { layerNameRefusal } from '../../../daemon/lib/service/profile-layers.ts';

const stoppers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stoppers.splice(0)) await stop();
});

const owner = { governed: false, decide: () => ({ allowed: true, refusal: 'granted' }) };
const denied = { governed: true, decide: () => ({ allowed: false, refusal: 'forbidden' }) };
const needsPasskey = { governed: true, decide: () => ({ allowed: false, refusal: 'step-up-required' }) };

const FILES = {
  runtimes: {
    work: { login: 'claude-you', profile: 'a', agent: true },
    other: { login: 'claude-you', profile: 'c' },
  },
  profiles: {
    a: { contents: ['instructions/notes', 'mcp/shared'] },
    b: { contents: ['mcp/shared', 'skills/pdf'] },
    c: { contents: ['skills/pdf'] },
  },
  'model-sets': { fast: { models: ['m1'], default: 'm1' } },
};

interface World {
  readonly kernel: KernelPorts;
  readonly port: RuntimesApi;
  /** Every document handed to `writeAll`, one array per call. */
  readonly writes: (readonly ConfigWriteAllDocument[])[];
  readonly values: (def: ConfigCollectionDef<unknown>) => string;
}

async function world(files: Record<string, unknown> = FILES, options: { etag?: boolean } = {}): Promise<World> {
  const seen: { kernel?: KernelPorts } = {};
  const host = await testHost({
    plugins: [
      runtimesDaemon(ctx => {
        seen.kernel = ctx.kernel;
        const assembly: RuntimesAssembly = unavailableAssembly(ctx);
        // The testing host's own etag of a stored profile: its value's JSON, as its writes answer it.
        return options.etag === false
          ? assembly
          : {
              ...assembly,
              profileEtag: async name =>
                JSON.stringify(
                  ctx.kernel.config.collection(PROFILE_ITEMS as unknown as ConfigCollectionDef<unknown>).get(name),
                ),
            };
      }),
    ] as never,
    fakes: { ferrets: new FakeFerrets(), logins: fakeLogins([]), loginChanges: fakeLoginChanges() },
    gate: new StandInAdmission(() => ownerStanding()),
    config: files,
  });
  stoppers.push(async () => await host.stop());
  const kernel = seen.kernel as KernelPorts;
  const writes: (readonly ConfigWriteAllDocument[])[] = [];
  const real = kernel.config.writeAll.bind(kernel.config);
  (kernel.config as { writeAll: typeof kernel.config.writeAll }).writeAll = async documents => {
    writes.push(documents);
    return await real(documents);
  };
  return {
    kernel,
    port: host.provided(RuntimesPort),
    writes,
    values: def => JSON.stringify([...kernel.config.collection(def).entries()]),
  };
}

const names = (documents: readonly ConfigWriteAllDocument[]): (string | undefined)[] =>
  documents.map(document => document.name);

describe('R2 changeProfileLayers — add', () => {
  it('R2 should land a layer in exactly one profile file and nothing else', async () => {
    // Arrange
    const { kernel, port: runtimes, writes, values } = await world();
    const others = values(RUNTIME_ITEMS as never) + values(MODEL_SET_ITEMS as never);
    const untouched = JSON.stringify(
      [...kernel.config.collection(PROFILE_ITEMS as never).entries()].filter(([name]) => name !== 'c'),
    );

    // Act
    const outcome = await runtimes.changeProfileLayers({ kind: 'add', profile: 'c', layer: 'mcp/notes' }, owner);

    // Assert
    should(outcome).deepEqual({ kind: 'written', profiles: ['c'] });
    should(writes.length).equal(1);
    should(writes[0]?.length).equal(1);
    should(names(writes[0] ?? [])).deepEqual(['c']);
    should(kernel.config.collection(PROFILE_ITEMS as never).get('c')).containEql({
      contents: ['skills/pdf', 'mcp/notes'],
    });
    should(
      JSON.stringify([...kernel.config.collection(PROFILE_ITEMS as never).entries()].filter(([name]) => name !== 'c')),
    ).equal(untouched);
    should(values(RUNTIME_ITEMS as never) + values(MODEL_SET_ITEMS as never)).equal(others);
  });

  it('R2 should write nothing and answer a conflict when the profile moved since ifMatch', async () => {
    // Arrange
    const { kernel, port: runtimes, writes } = await world();
    const stale = (await runtimes.profiles()).find(profile => profile.name === 'c')?.etag as string;
    await runtimes.changeProfileLayers({ kind: 'add', profile: 'c', layer: 'mcp/first' }, owner);
    writes.length = 0;
    const before = JSON.stringify(kernel.config.collection(PROFILE_ITEMS as never).get('c'));

    // Act
    const outcome = await runtimes.changeProfileLayers(
      { kind: 'add', profile: 'c', layer: 'mcp/second', ifMatch: stale },
      owner,
    );

    // Assert
    should(outcome).deepEqual({ kind: 'conflict', profile: 'c' });
    should(JSON.stringify(kernel.config.collection(PROFILE_ITEMS as never).get('c'))).equal(before);
  });

  it('R2 should accept the etag profiles() gave when the profile has not moved', async () => {
    // Arrange
    const { port: runtimes } = await world();
    const fresh = (await runtimes.profiles()).find(profile => profile.name === 'c')?.etag as string;

    // Act
    const outcome = await runtimes.changeProfileLayers(
      { kind: 'add', profile: 'c', layer: 'mcp/second', ifMatch: fresh },
      owner,
    );

    // Assert
    should(outcome).deepEqual({ kind: 'written', profiles: ['c'] });
  });

  it('R2 should refuse a caller whose standing is unknown, writing nothing', async () => {
    // Arrange
    const { port: runtimes, writes } = await world();

    // Act
    const outcome = await runtimes.changeProfileLayers({ kind: 'add', profile: 'c', layer: 'mcp/notes' });

    // Assert
    should(outcome).deepEqual({
      kind: 'refused',
      code: 'fleet_change_refused',
      sentence: 'this daemon cannot say whether this caller may change the fleet',
    });
    should(writes).deepEqual([]);
  });

  it('R2 should refuse a governed caller that may not configure the fleet, or has no passkey, writing nothing', async () => {
    // Arrange
    const { port: runtimes, writes } = await world();

    // Act
    const forbidden = await runtimes.changeProfileLayers({ kind: 'add', profile: 'c', layer: 'mcp/notes' }, denied);
    const stepUp = await runtimes.changeProfileLayers({ kind: 'add', profile: 'c', layer: 'mcp/notes' }, needsPasskey);
    const removal = await runtimes.changeProfileLayers({ kind: 'remove-everywhere', layer: 'mcp/shared' }, denied);

    // Assert
    should(forbidden).match({ kind: 'refused', code: 'fleet_change_refused' });
    should((forbidden as { sentence: string }).sentence).containEql('may not');
    should((stepUp as { sentence: string }).sentence).containEql('passkey');
    should(removal).match({ kind: 'refused', code: 'fleet_change_refused' });
    should(writes).deepEqual([]);
  });

  it('R2 should treat a thing that only looks like a governance as an unknown caller', async () => {
    // Arrange
    const { port: runtimes, writes } = await world();

    // Act
    const outcome = await runtimes.changeProfileLayers({ kind: 'add', profile: 'c', layer: 'mcp/notes' }, {
      governed: false,
    } as never);

    // Assert
    should(outcome).match({ kind: 'refused', code: 'fleet_change_refused' });
    should(writes).deepEqual([]);
  });

  it('R2 should add a layer already present as a no-op written with no write', async () => {
    // Arrange
    const { port: runtimes, writes } = await world();

    // Act
    const again = await runtimes.changeProfileLayers({ kind: 'add', profile: 'a', layer: 'mcp/shared' }, owner);
    const first = await runtimes.changeProfileLayers({ kind: 'add', profile: 'a', layer: 'mcp/new' }, owner);
    const second = await runtimes.changeProfileLayers({ kind: 'add', profile: 'a', layer: 'mcp/new' }, owner);

    // Assert
    should(again).deepEqual({ kind: 'written', profiles: [] });
    should(first).deepEqual({ kind: 'written', profiles: ['a'] });
    should(second).deepEqual({ kind: 'written', profiles: [] });
    should(writes.length).equal(1);
  });

  it('R2 should refuse a profile that does not exist, in the unknown code, writing nothing', async () => {
    // Arrange
    const { port: runtimes, writes } = await world();

    // Act
    const outcome = await runtimes.changeProfileLayers({ kind: 'add', profile: 'ghost', layer: 'mcp/x' }, owner);

    // Assert
    should(outcome).deepEqual({
      kind: 'refused',
      code: 'fleet_change_unknown',
      sentence: 'profile ghost does not exist',
    });
    should(writes).deepEqual([]);
  });

  it('R2 should refuse a layer name that is not a plain mcp/<name> or skills/<name>, writing nothing', async () => {
    // Arrange
    const { port: runtimes, writes } = await world();
    const bad = [
      'mcp/../x',
      'mcp/..',
      'mcp/.',
      'mcp/a/b',
      'skills/..\\x',
      'mcp/',
      'mcp/\u0000x',
      'mcp/\nx',
      `mcp/${'x'.repeat(65)}`,
      'hooks/x',
      'profile/a',
      'mcp',
      '../mcp/x',
    ];

    // Act
    const added: unknown[] = [];
    const removed: unknown[] = [];
    for (const layer of bad) {
      added.push(await runtimes.changeProfileLayers({ kind: 'add', profile: 'c', layer: layer as never }, owner));
      removed.push(await runtimes.changeProfileLayers({ kind: 'remove-everywhere', layer: layer as never }, owner));
    }

    // Assert
    for (const outcome of [...added, ...removed])
      should(outcome).match({ kind: 'refused', code: 'fleet_change_refused' });
    should(writes).deepEqual([]);
    should(layerNameRefusal('mcp/notes')).be.undefined();
    should(layerNameRefusal('skills/pdf-tools')).be.undefined();
  });

  it('R2 should answer a sentence, never a success, when the profile files cannot be read', async () => {
    // Arrange
    const { port: runtimes, writes } = await world(FILES, { etag: false });

    // Act
    const outcome = await runtimes.changeProfileLayers({ kind: 'add', profile: 'c', layer: 'mcp/x' }, owner);
    const listing = await runtimes.profiles().then(
      () => 'answered',
      (error: unknown) => (error as Error).message,
    );

    // Assert
    should(outcome).match({ kind: 'refused', code: 'fleet_change_refused' });
    should((outcome as { sentence: string }).sentence).containEql('could not be read');
    should(listing).containEql('cannot read its profile files');
    should(writes).deepEqual([]);
  });
});

describe('R2 changeProfileLayers — remove-everywhere', () => {
  it('R2 should touch every profile naming the layer, with one write each, and no other file', async () => {
    // Arrange
    const { kernel, port: runtimes, writes, values } = await world();
    const profileC = JSON.stringify(kernel.config.collection(PROFILE_ITEMS as never).get('c'));
    const others = values(RUNTIME_ITEMS as never) + values(MODEL_SET_ITEMS as never);

    // Act
    const outcome = await runtimes.changeProfileLayers({ kind: 'remove-everywhere', layer: 'mcp/shared' }, owner);

    // Assert
    should(outcome).deepEqual({ kind: 'written', profiles: ['a', 'b'] });
    should(writes.map(documents => names(documents))).deepEqual([['a'], ['b']]);
    const profiles = kernel.config.collection(PROFILE_ITEMS as never);
    should(profiles.get('a')).containEql({ contents: ['instructions/notes'] });
    should(profiles.get('b')).containEql({ contents: ['skills/pdf'] });
    should(JSON.stringify(profiles.get('c'))).equal(profileC);
    should(values(RUNTIME_ITEMS as never) + values(MODEL_SET_ITEMS as never)).equal(others);
  });

  it('R2 should write nothing when no profile names the layer', async () => {
    // Arrange
    const { port: runtimes, writes } = await world();

    // Act
    const outcome = await runtimes.changeProfileLayers({ kind: 'remove-everywhere', layer: 'mcp/nobody' }, owner);

    // Assert
    should(outcome).deepEqual({ kind: 'written', profiles: [] });
    should(writes).deepEqual([]);
  });

  it('R2 should not remove a layer of another kind that shares the name', async () => {
    // Arrange
    const { kernel, port: runtimes } = await world({
      profiles: { a: { contents: ['mcp/pdf', 'skills/pdf'] } },
    });

    // Act
    const outcome = await runtimes.changeProfileLayers({ kind: 'remove-everywhere', layer: 'skills/pdf' }, owner);

    // Assert
    should(outcome).deepEqual({ kind: 'written', profiles: ['a'] });
    should(kernel.config.collection(PROFILE_ITEMS as never).get('a')).containEql({ contents: ['mcp/pdf'] });
  });
});

describe('R2 layers and profiles', () => {
  const runtime = (name: string) => RuntimeIdSchema.parse(name);

  it('R2 should resolve profile/<base> layers in layer order and keep each item once, at its newest place', async () => {
    // Arrange
    const { port: runtimes } = await world({
      runtimes: { work: { login: 'claude-you', profile: 'top', agent: true } },
      profiles: {
        top: { contents: ['mcp/own', 'profile/mid', 'skills/last'] },
        mid: { contents: ['mcp/shared', 'profile/base', 'skills/mid'] },
        base: { contents: ['mcp/base', 'mcp/shared', 'skills/base', 'instructions/ignored'] },
      },
    });

    // Act
    const layers = await runtimes.layers(runtime('work'));

    // Assert — oldest first; `mcp/shared` appears once (its newest position, from `mid`).
    should(layers).deepEqual({
      runtime: 'work',
      profile: 'top',
      mcp: ['own', 'base', 'shared'],
      skills: ['base', 'mid', 'last'],
    });
  });

  it('R2 should keep a base two profiles share and refuse only a loop', async () => {
    // Arrange
    const { port: runtimes } = await world({
      runtimes: { work: { login: 'claude-you', profile: 'top', agent: true } },
      profiles: {
        top: { contents: ['profile/left', 'profile/right'] },
        left: { contents: ['profile/base'] },
        right: { contents: ['profile/base', 'mcp/r'] },
        base: { contents: ['mcp/b'] },
      },
    });

    // Act
    const layers = await runtimes.layers(runtime('work'));

    // Assert
    should(layers?.mcp).deepEqual(['b', 'r']);
  });

  it('R2 should refuse a cycle of bases in a sentence', async () => {
    // Arrange
    const { port: runtimes } = await world({
      runtimes: { work: { login: 'claude-you', profile: 'a', agent: true } },
      profiles: { a: { contents: ['profile/b'] }, b: { contents: ['profile/a'] } },
    });

    // Act
    const sentence = await runtimes.layers(runtime('work')).then(
      () => 'answered',
      (error: unknown) => (error as Error).message,
    );

    // Assert
    should(sentence).containEql('leads back to itself');
    should(sentence).containEql('a → b → a');
  });

  it('R2 should refuse a profile that names itself', async () => {
    // Arrange
    const { port: runtimes } = await world({
      runtimes: { work: { login: 'claude-you', profile: 'a', agent: true } },
      profiles: { a: { contents: ['profile/a'] } },
    });

    // Act
    const sentence = await runtimes.layers(runtime('work')).then(
      () => 'answered',
      (error: unknown) => (error as Error).message,
    );

    // Assert
    should(sentence).containEql('leads back to itself');
  });

  it('R2 should refuse a missing base, and a runtime whose profile is missing, in a sentence', async () => {
    // Arrange
    const { port: runtimes } = await world({
      runtimes: {
        work: { login: 'claude-you', profile: 'a', agent: true },
        lost: { login: 'claude-you', profile: 'ghost' },
      },
      profiles: { a: { contents: ['profile/gone'] } },
    });
    const sentenceOf = async (id: string): Promise<string> =>
      await runtimes.layers(runtime(id)).then(
        () => 'answered',
        (error: unknown) => (error as Error).message,
      );

    // Act + Assert
    should(await sentenceOf('work')).containEql('names the base profile gone, which does not exist');
    should(await sentenceOf('lost')).containEql('profile ghost does not exist');
  });

  it('R2 should answer undefined for a runtime that does not exist', async () => {
    // Arrange
    const { port: runtimes } = await world();

    // Act + Assert
    should(await runtimes.layers(runtime('nope'))).be.undefined();
  });

  it('R2 should list every profile with its layers and the etag of its file, in name order', async () => {
    // Arrange
    const { port: runtimes } = await world();

    // Act
    const profiles = await runtimes.profiles();

    // Assert
    should(profiles.map(profile => profile.name)).deepEqual(['a', 'b', 'c']);
    should(profiles[0]?.layers).deepEqual(['instructions/notes', 'mcp/shared']);
    should(new Set(profiles.map(profile => profile.etag)).size).equal(3);
  });

  it('R2 should read every time: a file that moved is seen at once by profiles() and layers()', async () => {
    // Arrange
    const { kernel, port: runtimes } = await world();
    const before = await runtimes.layers(runtime('work'));
    const etag = (await runtimes.profiles()).find(profile => profile.name === 'a')?.etag;

    // Act — the file changes under the port, not through it.
    await kernel.config.write(PROFILE_ITEMS as never, 'a', { patch: { contents: ['mcp/fresh'] } });
    const after = await runtimes.layers(runtime('work'));
    const moved = (await runtimes.profiles()).find(profile => profile.name === 'a');

    // Assert
    should(before?.mcp).deepEqual(['shared']);
    should(after?.mcp).deepEqual(['fresh']);
    should(moved?.layers).deepEqual(['mcp/fresh']);
    should(moved?.etag).not.equal(etag);
  });
});
