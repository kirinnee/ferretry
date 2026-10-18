import { describe, expect, it } from 'bun:test';
import type { ConfigChangeFrame } from '@ferretry/protocol';
import type { FyApiClient } from '@ferretry/protocol/client';
import {
  browserConfigChangeFeedEnvironment,
  type ConfigChangeFeedEnvironment,
  useConfigChangeFeed,
} from '../../src/hooks/use-config-change-feed.ts';
import { DaemonConfigChangeStore } from '../../src/lib/config-changes.ts';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import { type AppStore, useConfigChangeCounter, useConfigChangeEffect } from '../../src/lib/store.tsx';
import { interact, mount } from '../support/dom.ts';
import { configChangeHarness } from './config-change-support.tsx';

const STUDIO = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd1' });
const MOVED = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd1' });

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
};

/** A daemon whose configuration stream a test drives, and a browser whose foreground it fakes. */
const feedFixture = (clientFails = 0, held = false) => {
  let release: () => void = () => undefined;
  const gate = held ? new Promise<void>(resolve => (release = resolve)) : Promise.resolve();
  const opens: { readonly onFrame: (frame: ConfigChangeFrame) => void; readonly signal?: AbortSignal }[] = [];
  let failures = clientFails;
  let clientAsks = 0;
  const api = {
    configChanges: (onFrame: (frame: ConfigChangeFrame) => void, signal?: AbortSignal) => {
      opens.push({ onFrame, ...(signal === undefined ? {} : { signal }) });
      return new Promise<void>(() => undefined);
    },
  } as unknown as FyApiClient;
  const configChanges = new DaemonConfigChangeStore();
  const store = {
    configChanges,
    clients: {
      client: async () => {
        clientAsks += 1;
        await gate;
        if (failures > 0) {
          failures -= 1;
          throw new Error('not reachable yet');
        }
        return api;
      },
    },
  } as unknown as Pick<AppStore, 'clients' | 'configChanges'>;
  const returns = new Set<() => void>();
  const environment: ConfigChangeFeedEnvironment = {
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    random: () => 0,
    onReturn: callback => {
      returns.add(callback);
      return () => returns.delete(callback);
    },
  };
  return {
    opens,
    configChanges,
    store,
    environment,
    returns,
    clientAsks: () => clientAsks,
    release: () => release(),
    comeBack: async () => {
      await interact(() => {
        for (const callback of returns) callback();
      });
    },
  };
};

function FeedHost({
  fixture,
  connection,
}: {
  readonly fixture: ReturnType<typeof feedFixture>;
  readonly connection: DaemonConnection | undefined;
}) {
  useConfigChangeFeed(fixture.store, connection, fixture.environment);
  return null;
}

describe('useConfigChangeFeed', () => {
  it('folds the machine on screen’s frames into the store', async () => {
    const fixture = feedFixture();
    const view = await mount(<FeedHost fixture={fixture} connection={STUDIO} />);
    await settle();

    fixture.opens[0]?.onFrame({ kind: 'config', epoch: 'b', revision: 0, kinds: [] });
    fixture.opens[0]?.onFrame({ kind: 'config', epoch: 'b', revision: 1, kinds: ['runtimes'] });

    expect(fixture.configChanges.counter(STUDIO.daemonId, ['runtimes'])).toBe(1);
    await view.unmount();
    expect(fixture.opens[0]?.signal?.aborted).toBe(true);
    expect(fixture.returns.size).toBe(0);
  });

  it('reopens the stream when the app comes back, and keeps one stream for a re-made connection', async () => {
    const fixture = feedFixture();
    const view = await mount(<FeedHost fixture={fixture} connection={STUDIO} />);
    await settle();
    await view.render(<FeedHost fixture={fixture} connection={MOVED} />);
    await settle();

    await fixture.comeBack();

    expect(fixture.opens).toHaveLength(2);
    expect(fixture.opens[0]?.signal?.aborted).toBe(true);
    await view.unmount();
  });

  it('opens nothing without a machine on screen', async () => {
    const fixture = feedFixture();
    const view = await mount(<FeedHost fixture={fixture} connection={undefined} />);
    await settle();

    expect(fixture.clientAsks()).toBe(0);
    expect(fixture.returns.size).toBe(0);
    await view.unmount();
  });

  it('tries again on the next return when the machine could not be reached at first', async () => {
    const fixture = feedFixture(1);
    const view = await mount(<FeedHost fixture={fixture} connection={STUDIO} />);
    await settle();
    expect(fixture.opens).toHaveLength(0);

    await fixture.comeBack();
    await settle();

    expect(fixture.clientAsks()).toBe(2);
    expect(fixture.opens).toHaveLength(1);
    await view.unmount();
  });

  it('opens nothing when the screen left before the client was ready', async () => {
    const fixture = feedFixture(0, true);
    const view = await mount(<FeedHost fixture={fixture} connection={STUDIO} />);
    await view.unmount();
    fixture.release();
    await settle();

    expect(fixture.opens).toHaveLength(0);
  });

  it('joins a second return that arrives while the client is still being made', async () => {
    const fixture = feedFixture(1);
    const view = await mount(<FeedHost fixture={fixture} connection={STUDIO} />);
    await settle();

    await interact(() => {
      for (const callback of fixture.returns) {
        callback();
        callback();
      }
    });
    await settle();

    expect(fixture.clientAsks()).toBe(2);
    await view.unmount();
  });
});

function CounterHost({
  kinds,
  onMove,
}: {
  readonly kinds: readonly ('runtimes' | 'warden')[];
  readonly onMove: () => void;
}) {
  const counter = useConfigChangeCounter(STUDIO.daemonId, kinds);
  useConfigChangeEffect(STUDIO.daemonId, kinds, onMove);
  return <p data-counter={counter} />;
}

describe('useConfigChangeCounter and useConfigChangeEffect', () => {
  it('re-run a read only for the kinds a screen shows, and never on mount', async () => {
    const harness = configChangeHarness(STUDIO.daemonId);
    let moves = 0;
    const view = await mount(harness.wrap(<CounterHost kinds={['runtimes']} onMove={() => (moves += 1)} />));
    expect(moves).toBe(0);

    await harness.move(['warden']);
    expect(moves).toBe(0);
    await harness.move(['files', 'runtimes']);

    expect(moves).toBe(1);
    expect(view.container.querySelector('p')?.getAttribute('data-counter')).toBe('1');
    await view.unmount();
  });

  it('never move outside a store', async () => {
    let moves = 0;
    const view = await mount(<CounterHost kinds={['runtimes', 'warden']} onMove={() => (moves += 1)} />);

    expect(view.container.querySelector('p')?.getAttribute('data-counter')).toBe('0');
    expect(moves).toBe(0);
    await view.unmount();
  });
});

describe('browserConfigChangeFeedEnvironment', () => {
  it('calls back when the page is visible again or the network returns, and stops when released', () => {
    let returns = 0;
    const release = browserConfigChangeFeedEnvironment.onReturn(() => {
      returns += 1;
    });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    globalThis.dispatchEvent(new Event('online'));
    release();
    globalThis.dispatchEvent(new Event('online'));
    delete (document as { visibilityState?: unknown }).visibilityState;

    expect(returns).toBe(2);
  });

  it('runs its timers on the page clock', async () => {
    let fired = false;
    const handle = browserConfigChangeFeedEnvironment.setTimeout(() => {
      fired = true;
    }, 0);
    const cancelled = browserConfigChangeFeedEnvironment.setTimeout(() => {
      throw new Error('a cleared timer fired');
    }, 0);
    browserConfigChangeFeedEnvironment.clearTimeout(cancelled);
    await new Promise(resolve => setTimeout(resolve, 5));

    expect(handle).toBeDefined();
    expect(fired).toBe(true);
    expect(browserConfigChangeFeedEnvironment.random()).toBeLessThan(1);
  });
});
