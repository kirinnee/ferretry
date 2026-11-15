import { describe, expect, test } from 'bun:test';
import {
  browserInstallStorage,
  INSTALL_DISMISSED_KEY,
  InstallDismissal,
  type InstallFacts,
  type InstallStorage,
  installSetting,
  installToast,
  speaksForDevice,
} from '../../../app/lib/install-prompt.ts';

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

const facts = (overrides: Partial<InstallFacts> = {}): InstallFacts => ({
  platform: 'browser',
  canPrompt: false,
  ...overrides,
});

describe('what is offered', () => {
  test('the toast: the browser’s offer first, the iOS hint where there is none, nothing once settled', () => {
    expect(installToast(facts({ canPrompt: true }), false)).toBe('prompt');
    expect(installToast(facts({ platform: 'ios' }), false)).toBe('ios-hint');
    expect(installToast(facts(), false)).toBeNull();
    expect(installToast(facts({ canPrompt: true }), true)).toBeNull();
    expect(installToast(facts({ platform: 'ios' }), true)).toBeNull();
    expect(installToast(facts({ platform: 'installed', canPrompt: true }), false)).toBeNull();
  });

  test('the Settings row ignores a dismissal, because it takes none, so "not now" is never "never"', () => {
    expect(installSetting(facts({ platform: 'installed' }))).toBe('installed');
    expect(installSetting(facts({ platform: 'installed', canPrompt: true }))).toBe('installed');
    expect(installSetting(facts({ canPrompt: true }))).toBe('prompt');
    expect(installSetting(facts({ platform: 'ios' }))).toBe('ios');
    expect(installSetting(facts())).toBe('manual');
  });
});

describe('speaksForDevice', () => {
  test('only the first paired machine draws the device’s toast, so two machines never stack two', () => {
    expect(speaksForDevice(['fy_daemon_a', 'fy_daemon_b'], 'fy_daemon_a')).toBe(true);
    expect(speaksForDevice(['fy_daemon_a', 'fy_daemon_b'], 'fy_daemon_b')).toBe(false);
    expect(speaksForDevice([], 'fy_daemon_a')).toBe(false);
  });
});

describe('InstallDismissal', () => {
  test('remembers a dismissal on this device, and reads it back on the next start', () => {
    const storage = new MemoryStorage();
    const first = new InstallDismissal(storage);
    expect(first.getSnapshot()).toBe(false);
    first.dismiss();
    expect(first.getSnapshot()).toBe(true);
    expect(storage.values.get(INSTALL_DISMISSED_KEY)).toBe('1');
    expect(new InstallDismissal(storage).getSnapshot()).toBe(true);
  });

  test('tells its listeners, and stops telling one that unsubscribed', () => {
    const dismissal = new InstallDismissal(new MemoryStorage());
    let told = 0;
    const stop = dismissal.subscribe(() => {
      told += 1;
    });
    dismissal.dismiss();
    expect(told).toBe(1);
    stop();
    dismissal.dismiss();
    expect(told).toBe(1);
  });

  test('survives storage that refuses both reads and writes, keeping the dismissal for this visit', () => {
    const dismissal = new InstallDismissal(refusingStorage);
    expect(dismissal.getSnapshot()).toBe(false);
    dismissal.dismiss();
    expect(dismissal.getSnapshot()).toBe(true);
  });

  test('reads its storage through the window’s getter, so a page whose storage throws on access still starts', () => {
    const storage = new MemoryStorage();
    const wrapped = browserInstallStorage({ localStorage: storage });
    wrapped.setItem('k', 'v');
    expect(storage.values.get('k')).toBe('v');
    expect(wrapped.getItem('k')).toBe('v');

    const hostile = browserInstallStorage({
      get localStorage(): InstallStorage {
        throw new Error('SecurityError');
      },
    });
    expect(new InstallDismissal(hostile).getSnapshot()).toBe(false);
  });
});
