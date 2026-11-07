import { describe, it } from 'bun:test';
import { definePlugin, socket } from '@ferretry/kernel/manifest';
import type { PluginSocket, PluginSocketListeners } from '@ferretry/kernel/manifest';
import should from 'should';
import { pluginClient } from '../../src/lib/client.ts';
import { ShellError } from '../../src/lib/errors.ts';
import { PERSON_ONLY_REFUSAL } from '../../src/lib/credential.ts';
import { depsOf, entry, inventoryOf, RecordingTransport, registryOf } from './fakes.ts';
import { skeletonCli } from '@ferretry/kernel/manifest';

const SCOPE = { minimum: 'authenticated', audit: { skip: 'test' }, guard: { none: 'test' } } as const;
const tracksManifest = definePlugin({
  id: 'tracks',
  title: 'Tracks',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  actions: {
    sockets: [
      socket('GET /v1/tracks/:id/stream', { ...SCOPE, caller: 'any' }),
      socket('GET /v1/tracks/own', { ...SCOPE, caller: 'person' }),
    ],
  },
});
const registry = registryOf(entry(tracksManifest, 'h-tracks', skeletonCli(tracksManifest)));
const healthy = inventoryOf({ id: 'tracks', contract: 'h-tracks' });

/** A transport that records every stream it is asked to open and lets a test drive it. */
class StreamingTransport extends RecordingTransport {
  readonly opened: { readonly path: string; readonly listeners: PluginSocketListeners }[] = [];
  readonly sentFrames: (string | Uint8Array)[] = [];
  readonly closes: { readonly code?: number; readonly reason?: string }[] = [];

  socket(path: string, listeners: PluginSocketListeners): PluginSocket {
    this.opened.push({ path, listeners });
    return {
      send: frame => {
        this.sentFrames.push(frame);
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

const settle = async (): Promise<void> => {
  for (let round = 0; round < 10; round++) await Promise.resolve();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
};

describe('the guarded client opens a socket route', () => {
  it('carries the query onto the opened path, encoded, and params fill only the placeholders', async () => {
    const transport = new StreamingTransport();
    const { deps } = depsOf(registry, healthy, { transport });

    pluginClient(deps, 'tracks').socket(
      'GET /v1/tracks/:id/stream',
      { id: 'a b' },
      { onFrame: () => {}, onClose: () => {} },
      { after: '3', sessionId: 'x&y=z' },
    );
    await settle();

    should(transport.opened.map(open => open.path)).deepEqual(['/v1/tracks/a%20b/stream?after=3&sessionId=x%26y%3Dz']);
  });

  it('opens the bare path when no query is given', async () => {
    const transport = new StreamingTransport();
    const { deps } = depsOf(registry, healthy, { transport });

    pluginClient(deps, 'tracks').socket(
      'GET /v1/tracks/:id/stream',
      { id: 'a' },
      { onFrame: () => {}, onClose: () => {} },
    );
    await settle();

    should(transport.opened.map(open => open.path)).deepEqual(['/v1/tracks/a/stream']);
  });

  it('refuses a parameter the path does not take, and one it needs, before anything is contacted', async () => {
    const transport = new StreamingTransport();
    const { deps, reads } = depsOf(registry, healthy, { transport });
    const client = pluginClient(deps, 'tracks');
    const listeners = { onFrame: () => {}, onClose: () => {} };

    should(() => client.socket('GET /v1/tracks/:id/stream', {}, listeners)).throw(/needs the parameter "id"/u);
    should(() => client.socket('GET /v1/tracks/:id/stream', { id: 'a', other: 'b' }, listeners)).throw(
      /has no parameter "other"/u,
    );
    await settle();

    should(transport.opened).deepEqual([]);
    should(reads.count).equal(0);
  });

  it('refuses an undeclared socket and a person-only one in a pane, unopened and with the inventory unread', async () => {
    const transport = new StreamingTransport();
    const { deps, reads } = depsOf(registry, healthy, { transport, inPane: true });
    const client = pluginClient(deps, 'tracks');
    const listeners = { onFrame: () => {}, onClose: () => {} };

    should(() => client.socket('GET /v1/nothing', {}, listeners)).throw(ShellError);
    should(() => client.socket('GET /v1/tracks/own', {}, listeners)).throw(PERSON_ONLY_REFUSAL);
    await settle();

    should(transport.opened).deepEqual([]);
    should(reads.count).equal(0);
  });

  it('says so when the transport cannot hold a stream open', () => {
    const { deps } = depsOf(registry, healthy);

    should(() =>
      pluginClient(deps, 'tracks').socket(
        'GET /v1/tracks/:id/stream',
        { id: 'a' },
        { onFrame: () => {}, onClose: () => {} },
      ),
    ).throw('fy does not open streams on this connection');
  });

  it('opens nothing and tells the listener why when the plugin is not agreed on', async () => {
    const transport = new StreamingTransport();
    const { deps } = depsOf(registry, inventoryOf({ id: 'tracks', contract: 'other' }), { transport });
    const closed: { reason: string; code?: number }[] = [];

    pluginClient(deps, 'tracks').socket(
      'GET /v1/tracks/:id/stream',
      { id: 'a' },
      {
        onFrame: () => {},
        onClose: (reason, code) => closed.push({ reason, ...(code === undefined ? {} : { code }) }),
      },
    );
    await settle();

    should(transport.opened).deepEqual([]);
    should(closed).have.length(1);
  });

  it('hands frames over in order, passes sends and close on, and goes quiet after close', async () => {
    const transport = new StreamingTransport();
    const { deps } = depsOf(registry, healthy, { transport });
    const heard: (string | Uint8Array)[] = [];
    const closed: string[] = [];

    const opened = pluginClient(deps, 'tracks').socket(
      'GET /v1/tracks/:id/stream',
      { id: 'a' },
      { onFrame: frame => heard.push(frame), onClose: reason => closed.push(reason) },
    );
    await settle();
    const [stream] = transport.opened;
    stream?.listeners.onFrame('one');
    stream?.listeners.onFrame('two');
    await settle();
    opened.send('ping');
    opened.close(1000, 'event stream cancelled');
    stream?.listeners.onFrame('late');
    stream?.listeners.onClose('gone', 1006);
    await settle();

    should(heard).deepEqual(['one', 'two']);
    should(transport.sentFrames).deepEqual(['ping']);
    should(transport.closes).deepEqual([{ code: 1000, reason: 'event stream cancelled' }]);
    should(closed).deepEqual([]);
  });

  it('never opens a stream closed before the guard answered', async () => {
    const transport = new StreamingTransport();
    const { deps } = depsOf(registry, healthy, { transport });

    const opened = pluginClient(deps, 'tracks').socket(
      'GET /v1/tracks/:id/stream',
      { id: 'a' },
      { onFrame: () => {}, onClose: () => {} },
    );
    opened.close();
    await settle();

    should(transport.opened).deepEqual([]);
  });

  it('reports an unexpected close with its reason and code', async () => {
    const transport = new StreamingTransport();
    const { deps } = depsOf(registry, healthy, { transport });
    const closed: { reason: string; code?: number }[] = [];

    pluginClient(deps, 'tracks').socket(
      'GET /v1/tracks/:id/stream',
      { id: 'a' },
      {
        onFrame: () => {},
        onClose: (reason, code) => closed.push({ reason, ...(code === undefined ? {} : { code }) }),
      },
    );
    await settle();
    transport.opened[0]?.listeners.onClose('invalid input', 1008);
    await settle();

    should(closed).deepEqual([{ reason: 'invalid input', code: 1008 }]);
  });
});
