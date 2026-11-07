import { describe, it } from 'bun:test';
import should from 'should';

import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { type DaemonFleetPort, DaemonFleetStore } from '../../src/lib/fleet-store.ts';
import { sessionView } from '../support/sessions.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const daemonARotated = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://a.example.test',
  deviceId: 'token-a-rotated',
});

const LIVE_AT = 9_000;
const CACHED_AT = 5_000;

const portReturning = (...answers: ReturnType<typeof sessionView>[][]): DaemonFleetPort => {
  const queue = [...answers];
  return {
    list: async () => queue.shift() ?? [],
    get: async () => sessionView('unused'),
  };
};

describe('DaemonFleetStore seed', () => {
  it('draws a cached list into an unread slice, stamped as cached', () => {
    // Arrange
    const store = new DaemonFleetStore(portReturning(), () => LIVE_AT);
    const rows = [sessionView('s-1'), sessionView('s-2')];

    // Act
    const actual = store.seed(daemonA, rows, CACHED_AT);

    // Assert
    const slice = store.fleet(daemonA.daemonId);
    should(actual).be.true();
    should(slice.sessions?.map(view => view.config.id)).eql(['s-1', 's-2']);
    should(slice.byId.get('s-1')?.config.id).equal('s-1');
    should(slice.readAt).equal(CACHED_AT);
    should(slice.cachedAt).equal(CACHED_AT);
  });

  it('refuses when a live read already produced rows, and keeps them', async () => {
    // Arrange
    const store = new DaemonFleetStore(portReturning([sessionView('live')]), () => LIVE_AT);
    await store.hydrate(daemonA);

    // Act
    const actual = store.seed(daemonA, [sessionView('cached')], CACHED_AT);

    // Assert
    const slice = store.fleet(daemonA.daemonId);
    should(actual).be.false();
    should(slice.sessions?.map(view => view.config.id)).eql(['live']);
    should(slice.cachedAt).be.undefined();
  });

  it('refuses a second seed rather than replacing the first', () => {
    // Arrange
    const store = new DaemonFleetStore(portReturning(), () => LIVE_AT);
    store.seed(daemonA, [sessionView('first')], CACHED_AT);

    // Act
    const actual = store.seed(daemonA, [sessionView('second')], CACHED_AT + 1);

    // Assert
    should(actual).be.false();
    should(store.fleet(daemonA.daemonId).sessions?.map(view => view.config.id)).eql(['first']);
  });

  it('is replaced by the first live read, which clears cachedAt and moves readAt to the live clock', async () => {
    // Arrange
    const store = new DaemonFleetStore(portReturning([sessionView('live')]), () => LIVE_AT);
    store.seed(daemonA, [sessionView('cached')], CACHED_AT);

    // Act
    await store.hydrate(daemonA);

    // Assert
    const slice = store.fleet(daemonA.daemonId);
    should(slice.sessions?.map(view => view.config.id)).eql(['live']);
    should(slice.cachedAt).be.undefined();
    should(slice.readAt).equal(LIVE_AT);
  });

  it('keeps the cached rows and cachedAt when the live read fails', async () => {
    // Arrange
    const port: DaemonFleetPort = {
      list: async () => {
        throw new Error('offline');
      },
      get: async () => sessionView('unused'),
    };
    const store = new DaemonFleetStore(port, () => LIVE_AT);
    store.seed(daemonA, [sessionView('cached')], CACHED_AT);

    // Act
    await store.hydrate(daemonA).catch(() => undefined);

    // Assert
    const slice = store.fleet(daemonA.daemonId);
    should(slice.sessions?.map(view => view.config.id)).eql(['cached']);
    should(slice.cachedAt).equal(CACHED_AT);
    should(slice.status).equal('error');
  });

  it('drops seeded rows when the machine is re-paired under a new credential', async () => {
    // Arrange
    const store = new DaemonFleetStore(portReturning(), () => LIVE_AT);
    store.seed(daemonA, [sessionView('cached')], CACHED_AT);

    // Act
    const reading = store.hydrate(daemonARotated);
    const during = store.fleet(daemonA.daemonId);
    await reading;

    // Assert
    should(during.sessions).be.null();
    should(during.cachedAt).be.undefined();
  });
});
