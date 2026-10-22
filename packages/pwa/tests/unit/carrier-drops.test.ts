/**
 * The drop log: what a lost session is remembered as, how its reconnect is measured, what survives a
 * reload, and the lines a person copies.
 */

import { describe, expect, it } from 'bun:test';
import {
  browserCarrierDropEnvironment,
  CARRIER_DROP_LIMIT,
  CARRIER_DROPS_KEY,
  CARRIER_RECONNECT_WINDOW_MS,
  type CarrierDropEnvironment,
  CarrierDropLog,
  type CarrierDropStorage,
  carrierDropsReport,
  describeCarrierDrop,
} from '../../src/lib/carrier-drops.ts';
import { type DaemonId, daemonId } from '../../src/lib/daemon-connection.ts';

const MACHINE: DaemonId = daemonId('fy_daemon_machineOne');
const OTHER: DaemonId = daemonId('fy_daemon_machineTwo');
const END = { code: 1006, reason: 'cut', livedMs: 125_000, lastHeardMs: 3_200 };

const memoryStorage = (): CarrierDropStorage & { readonly items: Map<string, string> } => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
};

const page = (overrides: Partial<CarrierDropEnvironment> = {}) => {
  const state = { now: Date.UTC(2026, 9, 22, 7, 0, 0), hiddenFor: undefined as number | undefined };
  const environment: CarrierDropEnvironment = {
    now: () => state.now,
    hiddenFor: () => state.hiddenFor,
    online: () => true,
    network: () => 'cellular/4g',
    ...overrides,
  };
  return { state, environment };
};

describe('the carrier drop log', () => {
  it('should keep a drop with what the page could see at that moment', () => {
    // Arrange
    const { state, environment } = page();
    const log = new CarrierDropLog(environment, memoryStorage());
    state.hiddenFor = 95_000;

    // Act
    log.dropped(MACHINE, 'tunnel', 'stream', END);

    // Assert
    expect(log.snapshot()).toEqual([
      {
        at: state.now,
        daemonId: MACHINE,
        carrier: 'tunnel',
        purpose: 'stream',
        code: 1006,
        reason: 'cut',
        livedMs: 125_000,
        lastHeardMs: 3_200,
        hidden: true,
        hiddenMs: 95_000,
        online: true,
        network: 'cellular/4g',
      },
    ]);
  });

  it('should fill the reconnect time of every drop the outage left waiting, for that machine only', () => {
    // Arrange
    const { state, environment } = page();
    const log = new CarrierDropLog(environment, memoryStorage());
    log.dropped(MACHINE, 'tunnel', 'requests', END);
    log.dropped(MACHINE, 'tunnel', 'stream', END);
    log.dropped(OTHER, 'relay', 'requests', END);
    state.now += 240;

    // Act
    log.reconnected(OTHER);
    state.now += 60;
    log.reconnected(MACHINE);
    state.now += 5_000;
    log.reconnected(MACHINE);

    // Assert
    expect(log.snapshot().map(drop => [drop.daemonId, drop.reconnectMs])).toEqual([
      [MACHINE, 300],
      [MACHINE, 300],
      [OTHER, 240],
    ]);
  });

  it('should not call a session that opened long after a drop its reconnect', () => {
    // Arrange
    const { state, environment } = page();
    const log = new CarrierDropLog(environment, memoryStorage());
    log.dropped(MACHINE, 'relay', 'requests', END);

    // Act
    state.now += CARRIER_RECONNECT_WINDOW_MS + 1;
    log.reconnected(MACHINE);

    // Assert
    expect(log.snapshot()[0]?.reconnectMs).toBeUndefined();
  });

  it('should keep only the newest entries, across a reload', () => {
    // Arrange
    const storage = memoryStorage();
    const { state, environment } = page();
    const log = new CarrierDropLog(environment, storage);
    for (let index = 0; index < CARRIER_DROP_LIMIT + 5; index += 1) {
      state.now += 1;
      log.dropped(MACHINE, 'tunnel', 'requests', { ...END, code: 4000 + index });
    }

    // Act
    const reloaded = new CarrierDropLog(environment, storage).snapshot();

    // Assert
    expect(reloaded).toHaveLength(CARRIER_DROP_LIMIT);
    expect(reloaded[0]?.code).toBe(4005);
    expect(reloaded.at(-1)?.code).toBe(4000 + CARRIER_DROP_LIMIT + 4);
  });

  it('should read past entries that do not parse, and survive a document that is not one', () => {
    // Arrange
    const storage = memoryStorage();
    const { environment } = page();
    const good = new CarrierDropLog(environment, storage);
    good.dropped(MACHINE, 'relay', 'requests', END);
    const document = JSON.parse(storage.items.get(CARRIER_DROPS_KEY) ?? '{}') as { drops: unknown[] };
    storage.items.set(CARRIER_DROPS_KEY, JSON.stringify({ ...document, drops: [...document.drops, { code: 'x' }] }));

    // Act
    const kept = new CarrierDropLog(environment, storage).snapshot();
    storage.items.set(CARRIER_DROPS_KEY, 'not json');
    const garbage = new CarrierDropLog(environment, storage).snapshot();

    // Assert
    expect(kept).toHaveLength(1);
    expect(garbage).toEqual([]);
  });

  it('should keep the log for this tab when storage refuses a write, and still tell its subscribers', () => {
    // Arrange
    const { environment } = page();
    const refusing: CarrierDropStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const log = new CarrierDropLog(environment, refusing);
    let told = 0;
    log.subscribe(() => {
      told += 1;
    });

    // Act
    log.dropped(MACHINE, 'relay', 'requests', END);

    // Assert
    expect(log.snapshot()).toHaveLength(1);
    expect(told).toBe(1);
  });

  it('should stop telling a listener that unsubscribed', () => {
    // Arrange
    const { environment } = page();
    const log = new CarrierDropLog(environment, memoryStorage());
    let told = 0;
    const stop = log.subscribe(() => {
      told += 1;
    });

    // Act
    stop();
    log.dropped(MACHINE, 'relay', 'requests', END);

    // Assert
    expect(told).toBe(0);
  });

  it('should fall back to keeping the log in this tab when the browser storage is missing, unusable or refuses access', () => {
    // Arrange
    const { environment } = page();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const logsWith = (value: PropertyDescriptor): number => {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, ...value });
      const log = new CarrierDropLog(environment);
      log.dropped(MACHINE, 'relay', 'requests', END);
      return log.snapshot().length;
    };

    try {
      // Act + Assert
      expect(logsWith({ value: undefined })).toBe(1);
      expect(logsWith({ value: { getItem: 'not a function' } })).toBe(1);
      expect(
        logsWith({
          get: () => {
            throw new Error('SecurityError: storage is disabled');
          },
        }),
      ).toBe(1);
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', descriptor);
    }
  });

  it('should forget one machine’s drops and keep the others', () => {
    // Arrange
    const { environment } = page();
    const log = new CarrierDropLog(environment, memoryStorage());
    log.dropped(MACHINE, 'relay', 'requests', END);
    log.dropped(OTHER, 'relay', 'requests', END);

    // Act
    log.clearDaemon(MACHINE);

    // Assert
    expect(log.snapshot().map(drop => drop.daemonId)).toEqual([OTHER]);
  });
});

describe('the page’s own view of itself', () => {
  it('should track how long the page has been hidden, and read the network where the browser tells', () => {
    // Arrange
    const listeners: (() => void)[] = [];
    const document = {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (_: string, listener: () => void) => listeners.push(listener),
    };
    const environment = browserCarrierDropEnvironment({
      document: document as unknown as Pick<Document, 'addEventListener' | 'visibilityState'>,
      navigator: { onLine: false, connection: { type: 'wifi', effectiveType: '4g' } },
    });

    // Act + Assert
    expect(environment.hiddenFor()).toBeUndefined();
    document.visibilityState = 'hidden';
    for (const listener of listeners) listener();
    expect(environment.hiddenFor()).toBeGreaterThanOrEqual(0);
    document.visibilityState = 'visible';
    for (const listener of listeners) listener();
    expect(environment.hiddenFor()).toBeUndefined();
    expect(environment.online()).toBe(false);
    expect(environment.network()).toBe('wifi/4g');
    expect(browserCarrierDropEnvironment({}).network()).toBeUndefined();
  });
});

describe('what a person reads and copies', () => {
  it('should say each drop in one line', () => {
    // Act
    const line = describeCarrierDrop({
      at: Date.UTC(2026, 9, 22, 7, 0, 0),
      daemonId: MACHINE,
      carrier: 'tunnel',
      purpose: 'stream',
      code: 4408,
      reason: '',
      livedMs: 125_000,
      lastHeardMs: 14_000,
      hidden: true,
      hiddenMs: 300_000,
      online: true,
      network: 'cellular',
      reconnectMs: 480,
    });

    // Assert
    expect(line).toBe(
      '2026-10-22T07:00:00.000Z tunnel stream · 4408 no heartbeat answer · lived 2 min · last heard 14.0 s before · page hidden 5 min · online · cellular · back in 480 ms',
    );
  });

  it('should tally the drops per carrier above the lines, newest line first', () => {
    // Arrange
    const { state, environment } = page({ hiddenFor: () => undefined, network: () => undefined });
    const log = new CarrierDropLog(environment, memoryStorage());
    log.dropped(MACHINE, 'tunnel', 'requests', END);
    state.now += 60_000;
    log.dropped(MACHINE, 'tunnel', 'stream', { ...END, code: 1001, reason: '' });
    state.now += 60_000;
    log.dropped(MACHINE, 'relay', 'requests', END);

    // Act
    const report = carrierDropsReport(log.snapshot());

    // Assert
    const lines = report.split('\n');
    expect(lines[0]).toBe('Connection drops: 3 between 2026-10-22T07:00:00.000Z and 2026-10-22T07:02:00.000Z');
    expect(lines[1]).toBe('  tunnel: 2 (1006×1, 1001×1)');
    expect(lines[2]).toBe('  relay: 1 (1006×1)');
    expect(lines[4]).toStartWith('2026-10-22T07:02:00.000Z relay requests');
    expect(lines[4]).toContain('page visible · online · not reconnected yet');
    expect(carrierDropsReport([])).toBe('No connection drops recorded on this device.');
  });
});
