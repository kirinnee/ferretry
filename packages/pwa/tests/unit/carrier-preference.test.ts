/**
 * The per-device, per-machine connection preference (`docs/relay-protocol.md` §15 "The choice"): what
 * each preference walks, and how it is kept — Auto for anything unknown, never an error.
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
} from '../../src/lib/carrier-preference.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';

const STUDIO = 'fy_daemon_studio' as DaemonId;
const LAPTOP = 'fy_daemon_laptop' as DaemonId;

const memory = (
  seed: Record<string, string> = {},
): CarrierPreferenceStorage & { readonly values: Map<string, string> } => {
  const values = new Map(Object.entries(seed));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
};

describe('carrierOrder', () => {
  test('walks direct, WebRTC, tunnel then relay on Auto, and only the one kind otherwise', () => {
    should(carrierOrder('auto')).eql(['direct', 'webrtc', 'tunnel', 'relay']);
    should(carrierOrder('webrtc')).eql(['webrtc']);
    should(carrierOrder('tunnel')).eql(['tunnel']);
    should(carrierOrder('relay')).eql(['relay']);
    should(DEFAULT_CARRIER_PREFERENCE).equal('auto');
    should(CARRIER_PREFERENCES.map(preference => CARRIER_PREFERENCE_LABEL[preference])).eql([
      'Auto',
      'WebRTC only',
      'Tunnel only',
      'Relay only',
    ]);
  });
});

describe('reading a stored preference', () => {
  test('reads the four words and anything else as Auto', () => {
    for (const preference of CARRIER_PREFERENCES) should(parseCarrierPreference(preference)).equal(preference);
    should(parseCarrierPreference('Relay')).equal('auto');
    should(parseCarrierPreference('carrier-pigeon')).equal('auto');
    should(parseCarrierPreference(3)).equal('auto');
    should(parseCarrierPreference(null)).equal('auto');
  });

  test('keeps every known entry, drops an unknown one, and refuses nothing over a damaged document', () => {
    should(parseCarrierPreferences(JSON.stringify({ [STUDIO]: 'tunnel', [LAPTOP]: 'telepathy' }))).eql({
      [STUDIO]: 'tunnel',
    });
    should(parseCarrierPreferences(JSON.stringify({ [STUDIO]: 'auto' }))).eql({});
    should(parseCarrierPreferences('{not json')).eql({});
    should(parseCarrierPreferences('[]')).eql({});
    should(parseCarrierPreferences('null')).eql({});
    should(parseCarrierPreferences('"relay"')).eql({});
    should(parseCarrierPreferences(null)).eql({});
    should(parseCarrierPreferences(undefined)).eql({});
  });
});

describe('CarrierPreferenceStore', () => {
  test('keeps one preference per machine, on this device, and tells listeners which machine changed', () => {
    const storage = memory({ [CARRIER_PREFERENCE_KEY]: JSON.stringify({ [STUDIO]: 'relay' }) });
    const store = new CarrierPreferenceStore(storage);
    should(store.preference(STUDIO)).equal('relay');
    should(store.preference(LAPTOP)).equal('auto');
    const first = store.snapshot();
    // Identity-stable until something changes, as `useSyncExternalStore` needs.
    should(store.snapshot()).equal(first);

    const heard: DaemonId[] = [];
    const unsubscribe = store.subscribe(daemonId => heard.push(daemonId));
    store.set(LAPTOP, 'tunnel');
    should(store.preference(LAPTOP)).equal('tunnel');
    should(JSON.parse(storage.values.get(CARRIER_PREFERENCE_KEY) ?? '')).eql({ [STUDIO]: 'relay', [LAPTOP]: 'tunnel' });
    should(heard).eql([LAPTOP]);
    should(store.snapshot()).not.equal(first);

    // Choosing what is already in force is not a change; Auto is stored as nothing at all.
    store.set(LAPTOP, 'tunnel');
    should(heard).eql([LAPTOP]);
    store.set(STUDIO, 'auto');
    should(JSON.parse(storage.values.get(CARRIER_PREFERENCE_KEY) ?? '')).eql({ [LAPTOP]: 'tunnel' });
    should(heard).eql([LAPTOP, STUDIO]);

    unsubscribe();
    store.set(STUDIO, 'webrtc');
    should(heard).eql([LAPTOP, STUDIO]);
  });

  test('reads an unknown stored value as Auto', () => {
    const store = new CarrierPreferenceStore(
      memory({ [CARRIER_PREFERENCE_KEY]: JSON.stringify({ [STUDIO]: 'quic' }) }),
    );
    should(store.preference(STUDIO)).equal('auto');
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
    should(store.preference(STUDIO)).equal('auto');
    store.set(STUDIO, 'relay');
    should(store.preference(STUDIO)).equal('relay');
    const none = new CarrierPreferenceStore(undefined);
    none.set(STUDIO, 'tunnel');
    should(none.preference(STUDIO)).equal('tunnel');
  });

  test('the browser default reads the real storage when there is one, and none when it throws', () => {
    globalThis.localStorage?.removeItem?.(CARRIER_PREFERENCE_KEY);
    should(new CarrierPreferenceStore().preference(STUDIO)).equal('auto');
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError');
      },
    });
    try {
      should(new CarrierPreferenceStore().preference(STUDIO)).equal('auto');
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', descriptor);
    }
  });
});
