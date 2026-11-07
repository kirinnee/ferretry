import { describe, it } from 'bun:test';
import { definePlugin, implementCli, type PluginClient, verb } from '@ferretry/kernel/manifest';
import should from 'should';
import { runFy } from '../../src/lib/run.ts';
import {
  boardEntry,
  boardManifest,
  callsThenOk,
  entry,
  fakeWorld,
  inventoryOf,
  registryOf,
  skeletonEntry,
} from './fakes.ts';

describe('runFy', () => {
  it('should print the version and exit 0', async () => {
    const { world, io } = fakeWorld();
    should(await runFy(['--version'], world)).equal(0);
    should(io.stdout()).equal('5.0.0\n');
  });

  it('should print help for no verb and for --help, naming the binary and each plugin’s verbs', async () => {
    const { world, io } = fakeWorld({ registry: registryOf(boardEntry()) });
    should(await runFy([], world)).equal(0);
    should(await runFy(['--help'], world)).equal(0);
    should(io.stdout()).containEql('Usage: fy <verb>');
    should(io.stdout()).containEql('card move');
  });

  it('should answer an unknown verb with the near ones and exit 2', async () => {
    const { world, io } = fakeWorld({ registry: registryOf(boardEntry()) });
    should(await runFy(['card', 'zap'], world)).equal(2);
    should(io.stderr()).containEql('unknown verb "card zap"');
    should(io.stderr()).containEql('fy card show');
  });

  it('should refuse an unknown leading option', async () => {
    const { world, io } = fakeWorld();
    should(await runFy(['--bogus', 'doctor'], world)).equal(2);
    should(io.stderr()).containEql('unknown option --bogus');
  });

  it('should hand the plugin’s own cli half the arguments after the verb', async () => {
    // Arrange
    const calls: { args?: readonly string[] } = {};
    const { world } = fakeWorld({ registry: registryOf(boardEntry(calls)) });

    // Act
    const code = await runFy(['card', 'move', 'c1', '--to', 'done'], world);

    // Assert
    should(code).equal(0);
    should(calls.args).deepEqual(['c1']);
  });

  it('should answer a skeleton half with the not-built-yet sentence and exit 69', async () => {
    const { world, io } = fakeWorld({ registry: registryOf(skeletonEntry(boardManifest)) });
    should(await runFy(['board'], world)).equal(69);
    should(io.stderr()).equal('Board is not built yet in this version of Ferretry.\n');
  });

  it('should refuse a verb that subscribes to events, which this build does not offer', async () => {
    // Arrange
    const calls: { client?: PluginClient } = {};
    const { world } = fakeWorld({ registry: registryOf(boardEntry(calls)) });
    await runFy(['board'], world);

    // Act
    const subscribing = (): unknown => calls.client?.subscribe({} as never, () => undefined);

    // Assert
    should(subscribing).throw(/events are not available/u);
  });

  it('should not open a connection for a verb that never calls the daemon', async () => {
    const { world, connects } = fakeWorld({ registry: registryOf(boardEntry()) });
    await runFy(['board'], world);
    should(connects).deepEqual([]);
  });

  it('should open the connection on the first call, with --as-owner passed through', async () => {
    // Arrange
    const manifest = definePlugin({
      ...boardManifest,
      actions: { ...boardManifest.actions, cli: [verb('card show')] },
    });
    const half = implementCli(manifest, {
      build: ctx => ({
        verbs: { 'card show': callsThenOk(ctx.client, 'GET /v1/cards/:id', { params: { id: 'a' } }) },
      }),
    });
    const { world, connects, transport } = fakeWorld({
      registry: registryOf(entry(manifest, 'h-board', half)),
      inventory: inventoryOf({ id: 'board', contract: 'h-board' }),
    });

    // Act
    const code = await runFy(['--as-owner', 'card', 'show'], world);

    // Assert
    should(code).equal(0);
    should(connects).deepEqual([{ asOwner: true }]);
    should(transport.sent.map(sent => sent.path)).deepEqual(['/v1/cards/a']);
  });

  it('S58 --as-owner inside a pane prints its stderr line before acting', async () => {
    const manifest = definePlugin({ ...boardManifest, actions: { ...boardManifest.actions, cli: [verb('board')] } });
    const half = implementCli(manifest, {
      build: ctx => ({
        verbs: { board: callsThenOk(ctx.client, 'GET /v1/cards/:id', { params: { id: 'a' } }) },
      }),
    });
    const { world, io } = fakeWorld({
      registry: registryOf(entry(manifest, 'h-board', half)),
      inventory: inventoryOf({ id: 'board', contract: 'h-board' }),
      environment: { FY_SESSION_ID: 's1', FY_SESSION_TOKEN: 'fys_abc' },
    });
    await runFy(['--as-owner', 'board'], world);
    should(io.stderr()).containEql('--as-owner: acting with the host admin token, not this ferret’s credential');
  });

  it('should print a plugin that is blocked as plugin_paused with its fix, exit 69, and send nothing', async () => {
    const manifest = definePlugin({ ...boardManifest });
    const half = implementCli(manifest, {
      build: ctx => ({
        verbs: {
          'card show': callsThenOk(ctx.client, 'GET /v1/cards/:id', { params: { id: 'a' } }),
          'card move': async () => 0,
          board: async () => 0,
        },
      }),
    });
    const { world, io, transport } = fakeWorld({
      registry: registryOf(entry(manifest, 'h-board', half)),
      inventory: inventoryOf({ id: 'board', on: false, contract: 'h-board' }),
    });
    should(await runFy(['card', 'show'], world)).equal(69);
    should(io.stderr()).containEql('Board is turned off: turn it on with `fy plugin on board`.');
    should(transport.sent).deepEqual([]);
  });

  it('should report a declared verb its half does not implement, and a half that will not load', async () => {
    const manifest = definePlugin({ ...boardManifest });
    const missing = entry(manifest, 'h', implementCli(manifest, { build: () => ({ verbs: {} as never }) }));
    const broken = entry(manifest, 'h', async () => {
      throw new Error('boom');
    });
    const first = fakeWorld({ registry: registryOf(missing) });
    should(await runFy(['board'], first.world)).equal(1);
    should(first.io.stderr()).containEql('implements none');
    const second = fakeWorld({ registry: registryOf(broken) });
    should(await runFy(['board'], second.world)).equal(1);
    should(second.io.stderr()).containEql('boom');
  });

  it('S59 a person-only call from a pane is refused before any connection is opened', async () => {
    // Arrange
    const manifest = definePlugin({ ...boardManifest });
    let ran = false;
    const half = implementCli(manifest, {
      build: ctx => ({
        verbs: {
          'card move': async () => {
            ran = true;
            await ctx.client.call('POST /v1/cards/:id/move', { params: { id: 'a' } });
            return 0;
          },
          'card show': async () => 0,
          board: async () => 0,
        },
      }),
    });
    const { world, io, connects, transport } = fakeWorld({
      registry: registryOf(entry(manifest, 'h-board', half)),
      inventory: inventoryOf({ id: 'board', contract: 'h-board' }),
      environment: { FY_SESSION_ID: 's1' },
    });

    // Act
    const code = await runFy(['card', 'move', 'a'], world);

    // Assert
    should(ran).be.true();
    should(code).equal(1);
    should(io.stderr()).containEql("this is the owner's command; a ferret's pane can't run it");
    should(connects).deepEqual([]);
    should(transport.sent).deepEqual([]);
  });

  for (const argv of [
    ['card', 'move', '-h'],
    ['card', 'move', '-h', 'a'],
    ['card', 'move', 'a', '--help', 'b'],
    ['card', 'move', '--to', 'done', '-h'],
  ])
    it(`should show help for ${argv.join(' ')} and never connect or run the handler`, async () => {
      // Arrange
      const calls: { args?: readonly string[] } = {};
      const { world, io, connects } = fakeWorld({ registry: registryOf(boardEntry(calls)) });

      // Act
      const code = await runFy(argv, world);

      // Assert
      should(code).equal(0);
      should(io.stdout()).equal('fy card move: move a card\n');
      should(calls.args).be.undefined();
      should(connects).deepEqual([]);
    });

  it('should pass -h through as an argument after --', async () => {
    const calls: { args?: readonly string[] } = {};
    const { world } = fakeWorld({ registry: registryOf(boardEntry(calls)) });
    should(await runFy(['card', 'show', '--', '-h'], world)).equal(0);
    should(calls.args).deepEqual(['-h']);
  });

  it('should print a verb’s summary for --help after it', async () => {
    const { world, io } = fakeWorld({ registry: registryOf(boardEntry()) });
    should(await runFy(['card', 'move', '--help'], world)).equal(0);
    should(io.stdout()).equal('fy card move: move a card\n');
  });

  it('should run an alias as the verb it names, with the arguments carried over', async () => {
    const calls: { args?: readonly string[] } = {};
    const aliasPlugin = definePlugin({
      id: 'quick',
      title: 'Quick',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: ['command'],
      actions: { cli: [verb('done', { alias: 'card move --to done' })] },
    });
    const { world } = fakeWorld({ registry: registryOf(boardEntry(calls), skeletonEntry(aliasPlugin)) });
    should(await runFy(['done', 'c9'], world)).equal(0);
    should(calls.args).deepEqual(['c9']);
  });

  it('should stop an alias that loops', async () => {
    const loop = definePlugin({
      id: 'loop',
      title: 'Loop',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: ['command'],
      actions: { cli: [verb('spin', { alias: 'spin' })] },
    });
    const { world, io } = fakeWorld({ registry: registryOf(skeletonEntry(loop)) });
    should(await runFy(['spin'], world)).equal(1);
    should(io.stderr()).containEql('too many times');
  });
});
