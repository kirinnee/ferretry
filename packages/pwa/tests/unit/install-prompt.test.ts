import { describe, expect, test } from 'bun:test';
import {
  attachInstallPrompt,
  browserInstallEnvironment,
  browserInstallStorage,
  createBrowserInstallPrompt,
  type DeferredInstallPrompt,
  INSTALL_DISMISSED_KEY,
  type InstallEnvironment,
  type InstallPromptSnapshot,
  InstallPromptStore,
  type InstallStorage,
  type InstallWindow,
  installBanner,
  installPlatform,
  installSetting,
} from '../../src/lib/install-prompt.ts';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD_AS_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const environment = (overrides: Partial<InstallEnvironment> = {}): InstallEnvironment => ({
  userAgent: ANDROID,
  maxTouchPoints: 5,
  standaloneDisplay: false,
  ...overrides,
});

class MemoryStorage implements InstallStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const refusingStorage: InstallStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

const prompt = (outcome: 'accepted' | 'dismissed'): DeferredInstallPrompt & { prompted: number } => {
  const deferred = {
    prompted: 0,
    prompt: async () => {
      deferred.prompted += 1;
    },
    userChoice: Promise.resolve({ outcome }),
  };
  return deferred;
};

const snapshot = (overrides: Partial<InstallPromptSnapshot> = {}): InstallPromptSnapshot => ({
  platform: 'browser',
  promptAvailable: false,
  dismissed: false,
  installed: false,
  ...overrides,
});

describe('installPlatform', () => {
  test('knows an installed app, an iPhone or iPad, and every other browser', () => {
    expect(installPlatform(environment({ standaloneDisplay: true }))).toBe('installed');
    expect(installPlatform(environment({ userAgent: IPHONE, navigatorStandalone: true }))).toBe('installed');
    expect(installPlatform(environment({ userAgent: IPHONE, navigatorStandalone: false }))).toBe('ios');
    // iPadOS announces a Mac; its touch screen is what gives it away.
    expect(installPlatform(environment({ userAgent: IPAD_AS_MAC, maxTouchPoints: 5 }))).toBe('ios');
    expect(installPlatform(environment({ userAgent: IPAD_AS_MAC, maxTouchPoints: 0 }))).toBe('browser');
    expect(installPlatform(environment())).toBe('browser');
  });
});

describe('what is offered', () => {
  test('the banner: the browser’s offer first, the iOS hint where there is none, nothing once settled', () => {
    expect(installBanner(snapshot({ promptAvailable: true }))).toBe('prompt');
    expect(installBanner(snapshot({ platform: 'ios' }))).toBe('ios-hint');
    expect(installBanner(snapshot())).toBeNull();
    expect(installBanner(snapshot({ promptAvailable: true, dismissed: true }))).toBeNull();
    expect(installBanner(snapshot({ platform: 'ios', dismissed: true }))).toBeNull();
    expect(installBanner(snapshot({ promptAvailable: true, installed: true }))).toBeNull();
    expect(installBanner(snapshot({ platform: 'installed', promptAvailable: true }))).toBeNull();
  });

  test('the Settings row ignores a dismissal, so "not now" is never "never"', () => {
    expect(installSetting(snapshot({ platform: 'installed' }))).toBe('installed');
    expect(installSetting(snapshot({ installed: true }))).toBe('installed');
    expect(installSetting(snapshot({ promptAvailable: true, dismissed: true }))).toBe('prompt');
    expect(installSetting(snapshot({ platform: 'ios', dismissed: true }))).toBe('ios');
    expect(installSetting(snapshot({ dismissed: true }))).toBe('manual');
  });
});

describe('InstallPromptStore', () => {
  test('holds the browser’s offer, opens it once, and records an accepted install', async () => {
    const store = new InstallPromptStore('browser', new MemoryStorage());
    const seen: InstallPromptSnapshot[] = [];
    const stop = store.subscribe(() => seen.push(store.getSnapshot()));
    const deferred = prompt('accepted');

    expect(await store.install()).toBe('unavailable');
    store.capture(deferred);
    expect(store.getSnapshot().promptAvailable).toBe(true);
    expect(await store.install()).toBe('accepted');
    expect(deferred.prompted).toBe(1);
    expect(store.getSnapshot()).toMatchObject({ promptAvailable: false, installed: true });
    // Single use, by the browser's rule.
    expect(await store.install()).toBe('unavailable');

    stop();
    const count = seen.length;
    store.dismiss();
    expect(seen).toHaveLength(count);
  });

  test('releases a declined offer without calling it an install', async () => {
    const store = new InstallPromptStore('browser', new MemoryStorage());
    store.capture(prompt('dismissed'));
    expect(await store.install()).toBe('dismissed');
    expect(store.getSnapshot()).toMatchObject({ promptAvailable: false, installed: false });
  });

  test('remembers a dismissal on this device, and reads it back on the next start', () => {
    const storage = new MemoryStorage();
    const first = new InstallPromptStore('ios', storage);
    expect(first.getSnapshot().dismissed).toBe(false);
    first.dismiss();
    expect(first.getSnapshot().dismissed).toBe(true);
    expect(storage.values.get(INSTALL_DISMISSED_KEY)).toBe('1');
    expect(new InstallPromptStore('ios', storage).getSnapshot().dismissed).toBe(true);
  });

  test('survives storage that refuses both reads and writes, keeping the dismissal for this visit', () => {
    const store = new InstallPromptStore('ios', refusingStorage);
    expect(store.getSnapshot().dismissed).toBe(false);
    store.dismiss();
    expect(store.getSnapshot().dismissed).toBe(true);
  });

  test('drops a held offer when the app is installed some other way', () => {
    const store = new InstallPromptStore('browser', new MemoryStorage());
    store.capture(prompt('accepted'));
    store.markInstalled();
    expect(store.getSnapshot()).toMatchObject({ promptAvailable: false, installed: true });
  });
});

describe('the browser wiring', () => {
  const fakeWindow = (overrides: { standalone?: boolean; standaloneDisplay?: boolean } = {}) => {
    const listeners = new Map<string, (event: Event) => void>();
    const storage = new MemoryStorage();
    const win: InstallWindow & {
      addEventListener(type: string, listener: (event: Event) => void): void;
    } = {
      navigator: {
        userAgent: IPHONE,
        maxTouchPoints: 5,
        ...(overrides.standalone === undefined ? {} : { standalone: overrides.standalone }),
      },
      matchMedia: query => ({
        matches: query === '(display-mode: standalone)' && overrides.standaloneDisplay === true,
      }),
      localStorage: storage,
      addEventListener: (type, listener) => listeners.set(type, listener),
    };
    return { win, listeners, storage };
  };

  test('captures the offer, suppresses the browser’s own infobar, and hears a finished install', () => {
    const store = new InstallPromptStore('browser', new MemoryStorage());
    const listeners = new Map<string, (event: Event) => void>();
    attachInstallPrompt(store, { addEventListener: (type, listener) => listeners.set(type, listener) });
    let prevented = 0;
    const offer = Object.assign(prompt('accepted'), { preventDefault: () => (prevented += 1) });

    listeners.get('beforeinstallprompt')?.(offer as unknown as Event);
    expect(prevented).toBe(1);
    expect(store.getSnapshot().promptAvailable).toBe(true);

    listeners.get('appinstalled')?.(new Event('appinstalled'));
    expect(store.getSnapshot().installed).toBe(true);
  });

  test('reads the device once, through its own window', () => {
    const { win, storage } = fakeWindow({ standalone: false });
    expect(browserInstallEnvironment(win)).toEqual({
      userAgent: IPHONE,
      maxTouchPoints: 5,
      standaloneDisplay: false,
      navigatorStandalone: false,
    });
    expect(browserInstallEnvironment(fakeWindow({ standaloneDisplay: true }).win).standaloneDisplay).toBe(true);
    const wrapped = browserInstallStorage(win);
    wrapped.setItem('k', 'v');
    expect(storage.values.get('k')).toBe('v');
    expect(wrapped.getItem('k')).toBe('v');
  });

  test('builds the production store from the window and listens on it', () => {
    const { win, listeners } = fakeWindow();
    const store = createBrowserInstallPrompt(win);
    expect(store.getSnapshot().platform).toBe('ios');
    expect([...listeners.keys()].sort()).toEqual(['appinstalled', 'beforeinstallprompt']);
  });
});
