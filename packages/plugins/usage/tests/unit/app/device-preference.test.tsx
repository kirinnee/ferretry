import { afterEach, describe, expect, it } from 'bun:test';
import { ensureDom, interact, mount } from '@ferretry/app/testing';
import { devicePreference } from '../../../app/lib/device-preference.ts';

ensureDom();

const KEY = 'ferretry:test:device-preference';
const VALUES = ['a', 'b'] as const;
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

const withStorage = (storage: unknown) =>
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
const withThrowingAccessor = () =>
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('denied');
    },
  });

afterEach(() => {
  if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
  else Object.defineProperty(globalThis, 'localStorage', original);
  globalThis.localStorage?.removeItem(KEY);
});

describe('devicePreference', () => {
  it('should parse one of its values and take the fallback for anything else', () => {
    const preference = devicePreference(KEY, VALUES, 'a');
    expect(preference.parse('b')).toBe('b');
    expect(preference.parse('c')).toBe('a');
    expect(preference.parse(null)).toBe('a');
  });

  it('should read what is stored, and write it back to storage', () => {
    const preference = devicePreference(KEY, VALUES, 'a');
    globalThis.localStorage.setItem(KEY, 'b');
    expect(preference.read()).toBe('b');
    const other = devicePreference(KEY, VALUES, 'a');
    other.write('a');
    expect(globalThis.localStorage.getItem(KEY)).toBe('a');
  });

  it('should fall back when the browser has no storage at all', () => {
    withStorage(undefined);
    const preference = devicePreference(KEY, VALUES, 'a');
    expect(preference.read()).toBe('a');
    preference.write('b');
    expect(preference.read()).toBe('b');
  });

  it('should fall back when merely touching the storage throws', () => {
    withThrowingAccessor();
    const preference = devicePreference(KEY, VALUES, 'a');
    expect(preference.read()).toBe('a');
    expect(() => preference.write('b')).not.toThrow();
    expect(preference.read()).toBe('b');
  });

  it('should fall back when reading the stored value throws', () => {
    withStorage({
      getItem() {
        throw new Error('denied');
      },
      setItem() {},
    });
    expect(devicePreference(KEY, VALUES, 'b').read()).toBe('b');
  });

  it('should hold the value for this page when the browser refuses the write', () => {
    withStorage({
      getItem: () => null,
      setItem() {
        throw new Error('quota');
      },
    });
    const preference = devicePreference(KEY, VALUES, 'a');
    expect(() => preference.write('b')).not.toThrow();
    expect(preference.read()).toBe('b');
  });

  it('should not let a failing event shim make the write fail', () => {
    const preference = devicePreference(KEY, VALUES, 'a');
    const dispatch = window.dispatchEvent.bind(window);
    window.dispatchEvent = () => {
      throw new Error('shim');
    };
    try {
      expect(() => preference.write('b')).not.toThrow();
      expect(preference.read()).toBe('b');
    } finally {
      window.dispatchEvent = dispatch;
    }
  });
});

describe('devicePreference.use', () => {
  function Probe({ preference, seen }: { preference: ReturnType<typeof devicePreference<'a' | 'b'>>; seen: string[] }) {
    seen.push(preference.use());
    return null;
  }

  it('should follow a write in this tab and a change another tab makes to its key', async () => {
    const preference = devicePreference<'a' | 'b'>(KEY, VALUES, 'a');
    const seen: string[] = [];
    const view = await mount(<Probe preference={preference} seen={seen} />);
    expect(seen.at(-1)).toBe('a');

    await interact(() => preference.write('b'));
    expect(preference.read()).toBe('b');
    expect(seen.at(-1)).toBe('b');

    // Another tab changed ITS storage: this tab drops its page-held value and re-reads.
    globalThis.localStorage.setItem(KEY, 'a');
    await interact(() => window.dispatchEvent(new StorageEvent('storage', { key: KEY })));
    expect(preference.read()).toBe('a');
    expect(seen.at(-1)).toBe('a');

    // A change to some other key is none of this preference's business.
    await interact(() => preference.write('b'));
    await interact(() => window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' })));
    expect(preference.read()).toBe('b');

    // A storage clear (no key) re-reads too.
    globalThis.localStorage.setItem(KEY, 'a');
    await interact(() => window.dispatchEvent(new StorageEvent('storage', { key: null })));
    expect(preference.read()).toBe('a');
    await view.unmount();
  });
});
