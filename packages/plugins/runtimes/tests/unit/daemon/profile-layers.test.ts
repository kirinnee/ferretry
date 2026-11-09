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
  layerNameRefusal,
  MODEL_SET_ITEMS,
  PROFILE_ITEMS,
  RUNTIME_ITEMS,
  RuntimeIdSchema,
  RuntimesPort,
  type RuntimesApi,
} from '../../../contract/index.ts';
import { type RuntimesAssembly, runtimesDaemon, unavailableAssembly } from '../../../daemon/index.ts';

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
  /** The catalogue's one-at-a-time section, the one every apply runs in (the very one `changeProfileLayers` must use). */
  readonly section: <T>(act: () => Promise<T>) => Promise<T>;
}

interface WorldOptions {
  /** `false`: the profile files cannot be read (no etag seam). */
  readonly etag?: boolean;
  /** Runs right AFTER a profile's etag was read and BEFORE anything is written: a concurrent edit lands here. */
  readonly afterEtag?: (profile: string, kernel: KernelPorts) => Promise<void>;
}

async function world(files: Record<string, unknown> = FILES, options: WorldOptions = {}): Promise<World> {
  const seen: { kernel?: KernelPorts; section?: World['section'] } = {};
  const host = await testHost({
    plugins: [
      runtimesDaemon(ctx => {
        seen.kernel = ctx.kernel;
        const assembly: RuntimesAssembly = unavailableAssembly(ctx);
        seen.section = async act => await assembly.catalog.serialise(act);
        // The testing host's own etag of a stored profile: its value's JSON, as its writes answer it.
        return options.etag === false
          ? assembly
          : {
              ...assembly,
              profileEtag: async name => {
                // A profile with no file is `'absent'`, as the port's contract says (`ProfileLayerDeps.etag`).
                const etag =
                  JSON.stringify(
                    ctx.kernel.config.collection(PROFILE_ITEMS as unknown as ConfigCollectionDef<unknown>).get(name),
                  ) ?? 'absent';
                await options.afterEtag?.(name, ctx.kernel);
                return etag;
              },
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
    section: act => (seen.section as World['section'])(act),
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
    // What no owner can name an item, however it looks on screen: each class of look-alike and invisible character.
    const spoofed = [
      'mcp/a∕b', // division slash
      'mcp/a／b', // fullwidth solidus
      'mcp/a⁄b', // fraction slash
      'mcp/a⧸b', // big solidus
      'mcp/x‮exe', // right-to-left override
      'mcp/x‪exe', // left-to-right embedding
      'mcp/x⁦exe', // isolate
      'mcp/a​b', // zero-width space
      'mcp/a‍b', // zero-width joiner
      'mcp/a﻿b', // byte-order mark
      'mcp/a­b', // soft hyphen
      'mcp/a\u0085b', // C1 control (next line)
      'mcp/a\u009Fb', // C1 control
      'mcp/a b', // line separator
      'mcp/a b', // space
      'mcp/a\tb', // tab
      'mcp/a.b', // a dot
      'mcp/.hidden',
      'mcp/a_b',
      'mcp/-a',
      'mcp/a-',
      'mcp/a--b',
      'mcp/аbc', // Cyrillic a
      'mcp/é', // é
      'skills/\u{1F600}', // an emoji
      'mcp/a\n', // a trailing newline
    ];

    // Act
    const added: unknown[] = [];
    const removed: unknown[] = [];
    for (const layer of [...bad, ...spoofed]) {
      added.push(await runtimes.changeProfileLayers({ kind: 'add', profile: 'c', layer: layer as never }, owner));
      removed.push(await runtimes.changeProfileLayers({ kind: 'remove-everywhere', layer: layer as never }, owner));
    }

    // Assert
    for (const outcome of [...added, ...removed])
      should(outcome).match({ kind: 'refused', code: 'fleet_change_refused' });
    should(writes).deepEqual([]);
    should(layerNameRefusal('mcp/notes')).be.undefined();
    should(layerNameRefusal('skills/pdf-tools')).be.undefined();
    should(layerNameRefusal('mcp/Notes2-Go')).be.undefined();
    should(layerNameRefusal(`mcp/${'x'.repeat(64)}`)).be.undefined();
  });

  it('R2 should refuse each spoofed layer name by itself (no class passes for want of another)', () => {
    // Arrange
    const spoofed = [
      'mcp/a∕b',
      'mcp/a／b',
      'mcp/x‮exe',
      'mcp/a​b',
      'mcp/a\u0085b',
      'mcp/a b',
      'mcp/.hidden',
      'mcp/a.b',
      'skills/\u{1F600}',
    ];

    // Act + Assert
    for (const layer of spoofed) should(layerNameRefusal(layer)).be.a.String();
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
  it('R2 should touch every profile naming the layer in ONE all-or-none write, and no other file', async () => {
    // Arrange
    const { kernel, port: runtimes, writes, values } = await world();
    const profileC = JSON.stringify(kernel.config.collection(PROFILE_ITEMS as never).get('c'));
    const others = values(RUNTIME_ITEMS as never) + values(MODEL_SET_ITEMS as never);

    // Act
    const outcome = await runtimes.changeProfileLayers({ kind: 'remove-everywhere', layer: 'mcp/shared' }, owner);

    // Assert
    should(outcome).deepEqual({ kind: 'written', profiles: ['a', 'b'] });
    should(writes.map(documents => names(documents))).deepEqual([['a', 'b']]);
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

/** A governance that holds only the one axis it names. */
const holdsOnly = (held: 'use' | 'configure') => ({
  governed: true,
  decide: (demand: { readonly axis: string }) =>
    demand.axis === held ? { allowed: true, refusal: 'granted' } : { allowed: false, refusal: 'forbidden' },
});

describe('R2 changeProfileLayers — who is asking', () => {
  it('R2 should refuse a caller that holds only one of fleet.use and fleet.configure, on add and on remove-everywhere', async () => {
    // Arrange
    const { port: runtimes, writes } = await world();
    const add = { kind: 'add', profile: 'c', layer: 'mcp/notes' } as const;
    const remove = { kind: 'remove-everywhere', layer: 'mcp/shared' } as const;

    // Act
    const noRead = [
      await runtimes.changeProfileLayers(add, holdsOnly('configure')),
      await runtimes.changeProfileLayers(remove, holdsOnly('configure')),
    ];
    const noWrite = [
      await runtimes.changeProfileLayers(add, holdsOnly('use')),
      await runtimes.changeProfileLayers(remove, holdsOnly('use')),
    ];

    // Assert — configure alone is not enough (the caller must also be able to read what it changes), nor use alone.
    for (const outcome of noRead) {
      should(outcome).match({ kind: 'refused', code: 'fleet_change_refused' });
      should((outcome as { sentence: string }).sentence).containEql('may not read');
    }
    for (const outcome of noWrite) {
      should(outcome).match({ kind: 'refused', code: 'fleet_change_refused' });
      should((outcome as { sentence: string }).sentence).containEql('may not change');
    }
    should(writes).deepEqual([]);
  });

  it('R2 should refuse remove-everywhere with no governance at all, writing nothing', async () => {
    // Arrange
    const { port: runtimes, writes, kernel } = await world();
    const before = JSON.stringify([...kernel.config.collection(PROFILE_ITEMS as never).entries()]);

    // Act
    const outcome = await runtimes.changeProfileLayers({ kind: 'remove-everywhere', layer: 'mcp/shared' });

    // Assert
    should(outcome).deepEqual({
      kind: 'refused',
      code: 'fleet_change_refused',
      sentence: 'this daemon cannot say whether this caller may change the fleet',
    });
    should(writes).deepEqual([]);
    should(JSON.stringify([...kernel.config.collection(PROFILE_ITEMS as never).entries()])).equal(before);
  });

  it('R2 should answer refused, never reject, when the standing itself throws', async () => {
    // Arrange
    const { port: runtimes, writes } = await world();
    const broken = {
      governed: true,
      decide: () => {
        throw new Error('the grant document is unreadable');
      },
    };

    // Act
    const added = await runtimes.changeProfileLayers({ kind: 'add', profile: 'c', layer: 'mcp/x' }, broken);
    const removed = await runtimes.changeProfileLayers({ kind: 'remove-everywhere', layer: 'mcp/shared' }, broken);

    // Assert
    should(added).match({ kind: 'refused', code: 'fleet_change_refused' });
    should(removed).match({ kind: 'refused', code: 'fleet_change_refused' });
    should(writes).deepEqual([]);
  });
});

describe('R2 changeProfileLayers — remove-everywhere is all or nothing', () => {
  it('R2 should write NOTHING, and never say conflict after writing, when a naming profile moved after it was read', async () => {
    // Arrange — profile b is edited by someone else right after its etag was read, before the set is written.
    const {
      kernel,
      port: runtimes,
      writes,
    } = await world(FILES, {
      afterEtag: async (profile, ports) => {
        if (profile === 'b')
          await ports.config.write(PROFILE_ITEMS as never, 'b', {
            patch: { contents: ['mcp/shared', 'skills/pdf', 'skills/theirs'] },
          });
      },
    });

    // Act
    const outcome = await runtimes.changeProfileLayers({ kind: 'remove-everywhere', layer: 'mcp/shared' }, owner);

    // Assert — a (which was readable and unchanged) was NOT written either: all or none.
    should(outcome).deepEqual({ kind: 'conflict', profile: 'b' });
    const profiles = kernel.config.collection(PROFILE_ITEMS as never);
    should(profiles.get('a')).containEql({ contents: ['instructions/notes', 'mcp/shared'] });
    should(profiles.get('b')).containEql({ contents: ['mcp/shared', 'skills/pdf', 'skills/theirs'] });
    should(writes.length).equal(1);
    should(names(writes[0] ?? [])).deepEqual(['a', 'b']);
  });

  it('R2 should leave a profile that names the layer THROUGH a base alone: only the profile naming it directly changes', async () => {
    // Arrange
    const {
      kernel,
      port: runtimes,
      writes,
    } = await world({
      runtimes: { work: { login: 'claude-you', profile: 'child', agent: true } },
      profiles: {
        base: { contents: ['mcp/x', 'skills/keep'] },
        child: { contents: ['profile/base', 'skills/y'] },
        other: { contents: ['mcp/x'] },
      },
    });
    const child = JSON.stringify(kernel.config.collection(PROFILE_ITEMS as never).get('child'));

    // Act
    const outcome = await runtimes.changeProfileLayers({ kind: 'remove-everywhere', layer: 'mcp/x' }, owner);
    const layers = await runtimes.layers(RuntimeIdSchema.parse('work'));

    // Assert
    should(outcome).deepEqual({ kind: 'written', profiles: ['base', 'other'] });
    should(names(writes[0] ?? [])).deepEqual(['base', 'other']);
    should(JSON.stringify(kernel.config.collection(PROFILE_ITEMS as never).get('child'))).equal(child);
    should(layers?.mcp).deepEqual([]);
    should(layers?.skills).deepEqual(['keep', 'y']);
  });
});

describe('R2 changeProfileLayers — one section with apply (S67)', () => {
  it('R2 should wait for an apply in flight, then act on the profile that apply left, never over it', async () => {
    // Arrange — an apply holds the section and edits profile c (a key patch with no etag) before it lets go.
    const { kernel, port: runtimes, section, writes } = await world();
    let release: () => void = () => undefined;
    const holding = new Promise<void>(resolve => {
      release = resolve;
    });
    const apply = section(async () => {
      await holding;
      await kernel.config.write(PROFILE_ITEMS as never, 'c', { patch: { contents: ['skills/pdf', 'skills/applied'] } });
    });

    // Act
    const change = runtimes.changeProfileLayers({ kind: 'add', profile: 'c', layer: 'mcp/notes' }, owner);
    await new Promise(resolve => setTimeout(resolve, 25));
    const readsBefore = writes.length;
    release();
    await apply;
    const outcome = await change;

    // Assert — nothing was read or written while the apply held the section; afterwards BOTH edits stand.
    should(readsBefore).equal(0);
    should(outcome).deepEqual({ kind: 'written', profiles: ['c'] });
    should(kernel.config.collection(PROFILE_ITEMS as never).get('c')).containEql({
      contents: ['skills/pdf', 'skills/applied', 'mcp/notes'],
    });
  });

  it('R2 should serialise two concurrent changes of the same profile: both layers land, neither is lost', async () => {
    // Arrange
    const { kernel, port: runtimes } = await world();

    // Act
    const outcomes = await Promise.all([
      runtimes.changeProfileLayers({ kind: 'add', profile: 'c', layer: 'mcp/one' }, owner),
      runtimes.changeProfileLayers({ kind: 'add', profile: 'c', layer: 'mcp/two' }, owner),
      runtimes.changeProfileLayers({ kind: 'remove-everywhere', layer: 'skills/pdf' }, owner),
    ]);

    // Assert
    should(outcomes.map(outcome => outcome.kind)).deepEqual(['written', 'written', 'written']);
    const contents = (kernel.config.collection(PROFILE_ITEMS as never).get('c') as { contents: string[] }).contents;
    should([...contents].toSorted()).deepEqual(['mcp/one', 'mcp/two']);
  });

  it('R2 should run the act in the catalogue section of the real assembly, one at a time with an apply', async () => {
    // Arrange
    const { section } = await world();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const holding = new Promise<void>(resolve => {
      release = resolve;
    });

    // Act
    const first = section(async () => {
      order.push('first:start');
      await holding;
      order.push('first:end');
    });
    const second = section(async () => {
      order.push('second');
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    release();
    await Promise.all([first, second]);

    // Assert
    should(order).deepEqual(['first:start', 'first:end', 'second']);
  });
});

describe('R2 layers — a lattice of shared bases', () => {
  const runtime = RuntimeIdSchema.parse('work');
  const mcpNames = (layers: readonly string[]): readonly string[] =>
    layers.filter(layer => layer.startsWith('mcp/')).map(layer => layer.slice(4));

  /** Two profiles per level, each naming BOTH profiles of the next level and one item of its own. */
  const lattice = (depth: number): Record<string, { contents: string[] }> => {
    const profiles: Record<string, { contents: string[] }> = {};
    for (let level = 0; level <= depth; level++)
      for (const side of ['a', 'b'])
        profiles[`${side}${String(level)}`] = {
          contents:
            level === depth
              ? [`mcp/${side}${String(level)}`]
              : [`profile/a${String(level + 1)}`, `profile/b${String(level + 1)}`, `mcp/${side}${String(level)}`],
        };
    return profiles;
  };

  /** The rule as a person states it: expand every base where it stands (every path), keep each item at its newest place. */
  const naive = (profiles: Record<string, { contents: string[] }>, name: string): readonly string[] => {
    const seen: string[] = [];
    const walk = (current: string): void => {
      for (const layer of profiles[current]?.contents ?? []) {
        if (layer.startsWith('profile/')) walk(layer.slice('profile/'.length));
        else seen.push(layer);
      }
    };
    walk(name);
    return seen.filter((layer, index) => seen.lastIndexOf(layer) === index);
  };

  it('R2 should give the naive list on small lattices, in the same layer order', async () => {
    for (const depth of [1, 2, 3, 5, 7]) {
      // Arrange
      const profiles = lattice(depth);
      const { port: runtimes } = await world({
        runtimes: { work: { login: 'claude-you', profile: 'a0', agent: true } },
        profiles,
      });

      // Act
      const layers = await runtimes.layers(runtime);

      // Assert
      should(layers?.mcp).deepEqual(mcpNames(naive(profiles, 'a0')));
    }
  });

  it('R2 should keep a shared base once and the NEWEST copy of a repeated item, as the naive expansion does', async () => {
    // Arrange
    const profiles = {
      top: { contents: ['mcp/dup', 'profile/left', 'profile/right', 'skills/dup', 'mcp/last'] },
      left: { contents: ['profile/base', 'mcp/dup', 'mcp/l'] },
      right: { contents: ['mcp/r', 'profile/base'] },
      base: { contents: ['mcp/b', 'mcp/dup', 'skills/dup'] },
    };
    const { port: runtimes } = await world({
      runtimes: { work: { login: 'claude-you', profile: 'top', agent: true } },
      profiles,
    });

    // Act
    const layers = await runtimes.layers(runtime);

    // Assert
    const expected = naive(profiles, 'top');
    should(layers?.mcp).deepEqual(mcpNames(expected));
    should(layers?.skills).deepEqual(
      expected.filter(layer => layer.startsWith('skills/')).map(layer => layer.slice(7)),
    );
  });

  it('R2 should resolve a 20-deep lattice (about a million paths) at once', async () => {
    // Arrange
    const { port: runtimes } = await world({
      runtimes: { work: { login: 'claude-you', profile: 'a0', agent: true } },
      profiles: lattice(20),
    });

    // Act
    const started = performance.now();
    const layers = await runtimes.layers(runtime);
    const took = performance.now() - started;

    // Assert — all 41 items reachable from a0 (every profile but b0) once, a0's own item last; an expansion per path
    // would take minutes.
    should(layers?.mcp.length).equal(41);
    should(new Set(layers?.mcp).size).equal(41);
    should(layers?.mcp.at(-1)).equal('a0');
    should(took).be.below(1000);
  });

  it('R2 should list the profiles and change one of a 20-deep lattice (about a million paths) at once', async () => {
    // Arrange
    const { port: runtimes } = await world({
      runtimes: { work: { login: 'claude-you', profile: 'a0', agent: true } },
      profiles: lattice(20),
    });

    // Act
    const listedAt = performance.now();
    const listed = await runtimes.profiles();
    const listedTook = performance.now() - listedAt;
    const addedAt = performance.now();
    const added = await runtimes.changeProfileLayers({ kind: 'add', profile: 'a0', layer: 'mcp/extra' }, owner);
    const addedTook = performance.now() - addedAt;
    const removedAt = performance.now();
    const removed = await runtimes.changeProfileLayers({ kind: 'remove-everywhere', layer: 'mcp/extra' }, owner);
    const removedTook = performance.now() - removedAt;

    // Assert
    should(listed.length).equal(42);
    should(added).deepEqual({ kind: 'written', profiles: ['a0'] });
    should(removed).deepEqual({ kind: 'written', profiles: ['a0'] });
    should(listedTook).be.below(1000);
    should(addedTook).be.below(1000);
    should(removedTook).be.below(1000);
  });

  it('R2 should refuse a loop with the exact path, however deep the way into it', async () => {
    // Arrange
    const { port: runtimes } = await world({
      runtimes: { work: { login: 'claude-you', profile: 'top', agent: true } },
      profiles: {
        top: { contents: ['profile/x'] },
        x: { contents: ['profile/y'] },
        y: { contents: ['mcp/ok', 'profile/x'] },
      },
    });

    // Act
    const sentence = await runtimes.layers(runtime).then(
      () => 'answered',
      (error: unknown) => (error as Error).message,
    );

    // Assert
    should(sentence).equal('work: profile y names the base profile x, which leads back to itself (x → y → x)');
  });
});
