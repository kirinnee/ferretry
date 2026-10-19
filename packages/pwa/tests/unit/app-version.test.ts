import { afterEach, describe, expect, it } from 'bun:test';
import {
  type AppVersionStorage,
  appUpdatedWords,
  appVersion,
  browserAppVersionStorage,
  takeAppUpdatedNotice,
} from '../../src/lib/app-version.ts';

const host = globalThis as { __FY_APP_VERSION__?: unknown };

afterEach(() => {
  delete host.__FY_APP_VERSION__;
});

const memory = (initial?: string): AppVersionStorage & { readonly values: Map<string, string> } => {
  const values = new Map<string, string>(initial === undefined ? [] : [['fy-app-version-seen-v1', initial]]);
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
};

describe('appVersion', () => {
  it('reads the stamped version, and nothing for an unstamped build', () => {
    expect(appVersion()).toBeUndefined();
    host.__FY_APP_VERSION__ = ' 4.29.0 ';
    expect(appVersion()).toBe('4.29.0');
    host.__FY_APP_VERSION__ = '';
    expect(appVersion()).toBeUndefined();
  });
});

describe('takeAppUpdatedNotice', () => {
  it('announces a newer version once, and records what it saw', () => {
    const storage = memory('4.28.0');
    expect(takeAppUpdatedNotice(storage, '4.29.0')).toBe('4.29.0');
    expect(storage.values.get('fy-app-version-seen-v1')).toBe('4.29.0');
    expect(takeAppUpdatedNotice(storage, '4.29.0')).toBeNull();
  });

  it('stays quiet on a first load, a rollback, an unknown version or no storage', () => {
    const fresh = memory();
    expect(takeAppUpdatedNotice(fresh, '4.29.0')).toBeNull();
    expect(fresh.values.get('fy-app-version-seen-v1')).toBe('4.29.0');
    expect(takeAppUpdatedNotice(memory('4.30.0'), '4.29.0')).toBeNull();
    expect(takeAppUpdatedNotice(memory('4.28.0'), undefined)).toBeNull();
    expect(takeAppUpdatedNotice(undefined, '4.29.0')).toBeNull();
    const refusing: AppVersionStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => undefined,
    };
    expect(takeAppUpdatedNotice(refusing, '4.29.0')).toBeNull();
  });

  it('finds the browser storage, or nothing when reading it throws', () => {
    expect(browserAppVersionStorage()).toBe(globalThis.localStorage);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError');
      },
    });
    try {
      expect(browserAppVersionStorage()).toBeUndefined();
    } finally {
      if (descriptor !== undefined) Object.defineProperty(globalThis, 'localStorage', descriptor);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('words the toast', () => {
    expect(appUpdatedWords('4.29.0')).toBe('Ferretry updated to 4.29.0.');
  });
});
