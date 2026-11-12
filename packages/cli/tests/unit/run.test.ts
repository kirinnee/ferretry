import { describe, it } from 'bun:test';
import { defineEvent } from '@ferretry/kernel/contract';
import {
  definePlugin,
  implementCli,
  type PluginClient,
  type PluginSocket,
  type PluginSocketListeners,
  socket,
  verb,
} from '@ferretry/kernel/manifest';
import should from 'should';
import { z } from 'zod';
import type { FollowingClient } from '../../src/lib/client.ts';
import { runFy } from '../../src/lib/run.ts';
import {
  boardEntry,
  boardManifest,
  callsThenOk,
  entry,
  fakeWorld,
  FeedingTransport,
  inventoryOf,
  RecordingTransport,
  registryOf,
  skeletonEntry,
} from './fakes.ts';

const SCOPE = { minimum: 'authenticated', audit: { skip: 'test' }, guard: { none: 'test' } } as const;

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
    should(io.stderr()).equal('Not in 5.0 yet: Board.\n');
  });

  it('should hand a plugin verb events through the guarded connection, opened when it first listens', async () => {
    // Arrange
    const calls: { client?: PluginClient } = {};
    const transport = new FeedingTransport();
    const { world, connects } = fakeWorld({
      registry: registryOf(boardEntry(calls)),
      inventory: inventoryOf({ id: 'board', contract: 'h-board' }),
      transport,
    });
    await runFy(['board'], world);
    const moved = defineEvent('board.moved', z.strictObject({ id: z.string() }));
    const heard: string[] = [];

    // Act
    calls.client?.subscribe(moved, payload => heard.push(payload.id));
    await Bun.sleep(10);
    transport.push('board.moved', { id: 'c1' });
    await Bun.sleep(10);

    // Assert
    should(connects.length).equal(1);
    should(heard).deepEqual(['c1']);
  });

  it('a socket with a missing or dot-segment parameter fails the caller at once, before the daemon is reached', async () => {
    // Arrange
    const manifest = definePlugin({
      ...boardManifest,
      actions: { ...boardManifest.actions, sockets: [socket('GET /v1/cards/:id/stream', { ...SCOPE, caller: 'any' })] },
    });
    const refusals: string[] = [];
    const closes: string[] = [];
    const half = implementCli(manifest, {
      build: ctx => ({
        verbs: {
          board: async () => 0,
          'card move': async () => 0,
          'card show': async () => {
            for (const params of [{} as Record<string, string>, { id: '..' }, { id: '.' }]) {
              try {
                ctx.client.socket?.('GET /v1/cards/:id/stream', params, {
                  onFrame: () => {},
                  onClose: reason => closes.push(reason),
                });
              } catch (error) {
                refusals.push(error instanceof Error ? error.message : String(error));
              }
            }
            return 0;
          },
        },
      }),
    });
    const { world, connects } = fakeWorld({
      registry: registryOf(entry(manifest, 'h-board', half)),
      inventory: inventoryOf({ id: 'board', contract: 'h-board' }),
    });

    // Act
    const code = await runFy(['card', 'show'], world);
    await Bun.sleep(20);

    // Assert
    should(code).equal(0);
    should(refusals).have.length(3);
    should(refusals[0]).match(/needs the parameter "id"/u);
    should(refusals[1]).match(/cannot be/u);
    should(closes).deepEqual([]);
    should(connects).deepEqual([]);
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

  it('should list a verb’s declared options under its summary for --help, and print nothing for a verb that declares none', async () => {
    const withOptions = definePlugin({
      id: 'sized',
      title: 'Sized',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: ['command'],
      actions: {
        cli: [
          verb('size', {
            summary: 'size a thing',
            options: [
              {
                flag: '--at <tokens|auto>',
                help: "squeeze it at this many tokens (e.g. 250k); auto leaves the thing's own trigger",
              },
            ],
          }),
          verb('plain', { summary: 'a verb with no options' }),
        ],
      },
    });
    const { world, io } = fakeWorld({ registry: registryOf(skeletonEntry(withOptions)) });
    should(await runFy(['size', '--help'], world)).equal(0);
    should(io.stdout()).equal(
      "fy size: size a thing\n\noptions:\n  --at <tokens|auto>\n      squeeze it at this many tokens (e.g. 250k); auto leaves the thing's own trigger\n",
    );
    should(await runFy(['plain', '-h'], world)).equal(0);
    should(io.stdout().endsWith('fy plain: a verb with no options\n')).be.true();
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

describe('the client a plugin verb is handed opens its connection lazily', () => {
  const streaming = definePlugin({
    ...boardManifest,
    actions: { ...boardManifest.actions, sockets: [socket('GET /v1/cards/:id/stream', { ...SCOPE, caller: 'any' })] },
  });

  /** A verb run that keeps the client it was handed, in a world whose transport and connection a test shapes. */
  async function withClient(options: { transport?: RecordingTransport; refuse?: string } = {}) {
    const calls: { client?: FollowingClient } = {};
    const half = implementCli(streaming, {
      build: ctx => {
        calls.client = ctx.client as FollowingClient;
        return { verbs: { board: async () => 0, 'card move': async () => 0, 'card show': async () => 0 } };
      },
    });
    const made = fakeWorld({
      registry: registryOf(entry(streaming, 'h-board', half)),
      inventory: inventoryOf({ id: 'board', contract: 'h-board' }),
      ...(options.transport === undefined ? {} : { transport: options.transport }),
    });
    const world =
      options.refuse === undefined
        ? made.world
        : {
            ...made.world,
            connect: async () => {
              throw new Error(options.refuse);
            },
          };
    await runFy(['board'], world);
    const client = calls.client as FollowingClient;
    return { client, ...made };
  }

  const moved = defineEvent('board.moved', z.strictObject({ id: z.string() }));

  class SocketTransport extends RecordingTransport {
    readonly opened: { path: string; listeners: PluginSocketListeners }[] = [];
    readonly sent2: (string | Uint8Array)[] = [];
    readonly closes: { code?: number; reason?: string }[] = [];
    socket(path: string, listeners: PluginSocketListeners): PluginSocket {
      this.opened.push({ path, listeners });
      return {
        send: frame => {
          this.sent2.push(frame);
        },
        close: (code, reason) => {
          this.closes.push({
            ...(code === undefined ? {} : { code }),
            ...(reason === undefined ? {} : { reason }),
          });
        },
      };
    }
  }

  it('ends a follow with the words of a refused connection', async () => {
    const { client } = await withClient({ refuse: 'the daemon is unreachable' });
    const ended: string[] = [];

    client.follow(
      moved,
      () => undefined,
      reason => ended.push(reason),
    );
    await Bun.sleep(10);

    should(ended).deepEqual(['the daemon is unreachable']);
  });

  it('ends a follow over a connection that cannot hold a feed, with the reason', async () => {
    const { client } = await withClient();
    const ended: string[] = [];

    client.follow(
      moved,
      () => undefined,
      reason => ended.push(reason),
    );
    await Bun.sleep(10);

    should(ended).deepEqual(['fy does not subscribe to events on this connection']);
  });

  it('opens no feed for a follow cancelled before the connection was ready, and closes the one a cancel finds open', async () => {
    const transport = new FeedingTransport();
    const { client } = await withClient({ transport });

    client.follow(
      moved,
      () => undefined,
      () => undefined,
    )();
    await Bun.sleep(10);
    should(transport.opened).equal(0);

    const cancel = client.follow(
      moved,
      () => undefined,
      () => undefined,
    );
    await Bun.sleep(10);
    should(transport.opened).equal(1);
    cancel();
    should(transport.cancelled).equal(1);
  });

  it('runs a declared tool through the connection, and refuses an undeclared one before connecting', async () => {
    const { client, transport, connects } = await withClient();

    await client.tool('card_show', { id: 'a' });
    should(transport.sent).deepEqual([
      { method: 'POST', path: '/v1/agent/tools', body: { tool: 'card_show', input: { id: 'a' } } },
    ]);
    should(connects).have.length(1);
    await should(client.tool('nope', {})).be.rejectedWith(/no plugin declares the tool/u);
    should(connects).have.length(1);
  });

  it('opens a socket once the connection is ready, passes sends and a close on, and ignores a send before then', async () => {
    const transport = new SocketTransport();
    const { client } = await withClient({ transport });

    const stream = client.socket?.('GET /v1/cards/:id/stream', { id: 'a' }, { onFrame: () => {}, onClose: () => {} });
    stream?.send('too early');
    await Bun.sleep(10);
    stream?.send('ping');
    stream?.close(1000, 'done');

    should(transport.opened.map(open => open.path)).deepEqual(['/v1/cards/a/stream']);
    should(transport.sent2).deepEqual(['ping']);
    should(transport.closes).deepEqual([{ code: 1000, reason: 'done' }]);
  });

  it('never opens a socket closed before the connection was ready', async () => {
    const transport = new SocketTransport();
    const { client } = await withClient({ transport });

    client.socket?.('GET /v1/cards/:id/stream', { id: 'a' }, { onFrame: () => {}, onClose: () => {} }).close();
    await Bun.sleep(10);

    should(transport.opened).deepEqual([]);
  });

  it('tells a socket’s listener why when the connection is refused, or the transport cannot hold a stream', async () => {
    const refused: string[] = [];
    const refusing = await withClient({ refuse: 'the daemon is unreachable' });
    refusing.client.socket?.(
      'GET /v1/cards/:id/stream',
      { id: 'a' },
      { onFrame: () => {}, onClose: r => refused.push(r) },
    );
    await Bun.sleep(10);
    should(refused).deepEqual(['the daemon is unreachable']);

    const unable: string[] = [];
    const plain = await withClient();
    plain.client.socket?.('GET /v1/cards/:id/stream', { id: 'a' }, { onFrame: () => {}, onClose: r => unable.push(r) });
    await Bun.sleep(10);
    should(unable).deepEqual(['fy does not open streams on this connection']);
  });
});
