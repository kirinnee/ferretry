/**
 * The per-device, per-machine connection preference (`docs/relay-protocol.md` §15 "The choice"): what
 * each preference walks, and how it is kept — Relay for anything unknown, never an error.
 */

import { describe, test } from 'bun:test';
import should from 'should';
import {
  CARRIER_PREFERENCE_KEY,
  CARRIER_PREFERENCE_LABEL,
  CARRIER_PREFERENCES,
  type CarrierPreferenceStorage,
  CarrierPreferenceStore,
  carrierOrder,
  DEFAULT_CARRIER_PREFERENCE,
  parseCarrierPreference,
  parseCarrierPreferences,
} from '../../../app/lib/carrier-preference.ts';
type DaemonId = string;

const STUDIO = 'fy_daemon_studio' as DaemonId;
const LAPTOP = 'fy_daemon_laptop' as DaemonId;

const memory = (
  seed: Record<string, string> = {},
): CarrierPreferenceStorage & { readonly values: Map<string, string> } => {
  const values = new Map(Object.entries(seed));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
};

describe('carrierOrder', () => {
  test('R6 walks direct, WebRTC, tunnel then relay on Auto, and only the one kind otherwise', () => {
    should(carrierOrder('auto')).eql(['direct', 'webrtc', 'tunnel', 'relay']);
    should(carrierOrder('webrtc')).eql(['webrtc']);
    should(carrierOrder('tunnel')).eql(['tunnel']);
    should(carrierOrder('relay')).eql(['relay']);
    should(DEFAULT_CARRIER_PREFERENCE).equal('relay');
    should(CARRIER_PREFERENCES.map(preference => CARRIER_PREFERENCE_LABEL[preference])).eql([
      'Auto',
      'WebRTC only',
      'Tunnel only',
      'Relay only',
    ]);
  });
});

describe('reading a stored preference', () => {
  test('R5 reads the four words and anything else as Relay, the default', () => {
    for (const preference of CARRIER_PREFERENCES) should(parseCarrierPreference(preference)).equal(preference);
    should(parseCarrierPreference('Relay')).equal('relay');
    should(parseCarrierPreference('carrier-pigeon')).equal('relay');
    should(parseCarrierPreference(3)).equal('relay');
    should(parseCarrierPreference(null)).equal('relay');
  });

  test('keeps every known entry, drops an unknown one, and refuses nothing over a damaged document', () => {
    should(parseCarrierPreferences(JSON.stringify({ [STUDIO]: 'tunnel', [LAPTOP]: 'telepathy' }))).eql({
      [STUDIO]: 'tunnel',
    });
    // Auto is a choice now, so it is kept; Relay is what absent means, so it is not stored.
    should(parseCarrierPreferences(JSON.stringify({ [STUDIO]: 'auto', [LAPTOP]: 'relay' }))).eql({ [STUDIO]: 'auto' });
    should(parseCarrierPreferences('{not json')).eql({});
    should(parseCarrierPreferences('[]')).eql({});
    should(parseCarrierPreferences('null')).eql({});
    should(parseCarrierPreferences('"relay"')).eql({});
    should(parseCarrierPreferences(null)).eql({});
    should(parseCarrierPreferences(undefined)).eql({});
  });
});

describe('CarrierPreferenceStore', () => {
  test('R630 keeps one preference per machine, keyed by fingerprint on this device, and tells listeners which', () => {
    const storage = memory({ [CARRIER_PREFERENCE_KEY]: JSON.stringify({ [STUDIO]: 'webrtc' }) });
    const store = new CarrierPreferenceStore(storage);
    should(store.preference(STUDIO)).equal('webrtc');
    should(store.preference(LAPTOP)).equal('relay');
    const first = store.snapshot();
    // Identity-stable until something changes, as `useSyncExternalStore` needs.
    should(store.snapshot()).equal(first);

    const heard: DaemonId[] = [];
    const unsubscribe = store.subscribe(daemonId => heard.push(daemonId));
    store.set(LAPTOP, 'tunnel');
    should(store.preference(LAPTOP)).equal('tunnel');
    should(JSON.parse(storage.values.get(CARRIER_PREFERENCE_KEY) ?? '')).eql({
      [STUDIO]: 'webrtc',
      [LAPTOP]: 'tunnel',
    });
    should(heard).eql([LAPTOP]);
    should(store.snapshot()).not.equal(first);

    // Choosing what is already in force is not a change; Relay is stored as nothing at all.
    store.set(LAPTOP, 'tunnel');
    should(heard).eql([LAPTOP]);
    store.set(STUDIO, 'relay');
    should(JSON.parse(storage.values.get(CARRIER_PREFERENCE_KEY) ?? '')).eql({ [LAPTOP]: 'tunnel' });
    should(heard).eql([LAPTOP, STUDIO]);

    // An explicit Auto IS stored: it is no longer what absent means.
    store.set(STUDIO, 'auto');
    should(store.preference(STUDIO)).equal('auto');
    should(JSON.parse(storage.values.get(CARRIER_PREFERENCE_KEY) ?? '')).eql({ [LAPTOP]: 'tunnel', [STUDIO]: 'auto' });

    unsubscribe();
    store.set(STUDIO, 'webrtc');
    should(heard).eql([LAPTOP, STUDIO, STUDIO]);
  });

  test('R630 choosing a preference reaches only this browser’s storage: no request and no socket to the daemon', () => {
    const descriptors = ['fetch', 'WebSocket', 'XMLHttpRequest'].map(
      name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
    );
    const reached: string[] = [];
    for (const [name] of descriptors)
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value: () => {
          reached.push(name);
          throw new Error(`${name} must not be used`);
        },
      });
    try {
      const storage = memory();
      const store = new CarrierPreferenceStore(storage);
      for (const preference of CARRIER_PREFERENCES) store.set(STUDIO, preference);
      store.set(LAPTOP, 'tunnel');
      should(store.preference(LAPTOP)).equal('tunnel');
      should([...storage.values.keys()]).eql([CARRIER_PREFERENCE_KEY]);
      should(reached).eql([]);
    } finally {
      for (const [name, descriptor] of descriptors)
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
        else Object.defineProperty(globalThis, name, descriptor);
    }
  });

  test('R631 Relay is the default and Auto is only ever an explicit choice', () => {
    should(DEFAULT_CARRIER_PREFERENCE).equal('relay');
    // A device that never chose: nothing stored, an empty document, or an entry for another machine.
    const seeds: Record<string, string>[] = [
      {},
      { [CARRIER_PREFERENCE_KEY]: '{}' },
      { [CARRIER_PREFERENCE_KEY]: JSON.stringify({ [LAPTOP]: 'auto' }) },
    ];
    for (const seed of seeds) should(new CarrierPreferenceStore(memory(seed)).preference(STUDIO)).equal('relay');
    should(carrierOrder(new CarrierPreferenceStore(memory()).preference(STUDIO))).eql(['relay']);
    // Choosing Auto is what makes it Auto, and that choice is kept.
    const storage = memory();
    new CarrierPreferenceStore(storage).set(STUDIO, 'auto');
    should(new CarrierPreferenceStore(storage).preference(STUDIO)).equal('auto');
  });

  test('reads an unknown stored value as Relay', () => {
    const store = new CarrierPreferenceStore(
      memory({ [CARRIER_PREFERENCE_KEY]: JSON.stringify({ [STUDIO]: 'quic' }) }),
    );
    should(store.preference(STUDIO)).equal('relay');
  });

  test('a denied storage still changes the preference for the rest of the tab', () => {
    const denied: CarrierPreferenceStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const store = new CarrierPreferenceStore(denied);
    should(store.preference(STUDIO)).equal('relay');
    store.set(STUDIO, 'auto');
    should(store.preference(STUDIO)).equal('auto');
    const none = new CarrierPreferenceStore(undefined);
    none.set(STUDIO, 'tunnel');
    should(none.preference(STUDIO)).equal('tunnel');
  });

  test('the browser default reads the real storage when there is one, and none when it throws', () => {
    globalThis.localStorage?.removeItem?.(CARRIER_PREFERENCE_KEY);
    should(new CarrierPreferenceStore().preference(STUDIO)).equal('relay');
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError');
      },
    });
    try {
      should(new CarrierPreferenceStore().preference(STUDIO)).equal('relay');
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', descriptor);
    }
  });
});

describe('a browser whose storage is absent or not a store', () => {
  test('answers with the default and still changes the preference for the rest of the tab', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    try {
      for (const value of [undefined, {}, { getItem: () => null }, { getItem: () => null, setItem: 'no' }]) {
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value });
        const store = new CarrierPreferenceStore();
        should(store.preference(STUDIO)).equal('relay');
        store.set(STUDIO, 'tunnel');
        should(store.preference(STUDIO)).equal('tunnel');
      }
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', descriptor);
    }
  });
});
