import { describe, expect, it } from 'bun:test';
import { browserDeviceName, defaultDeviceName, deviceNameSuffix } from '../../../src/session/device-name.ts';

const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  operaChromeOs:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/110.0.0.0',
  safariIpad:
    'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};

describe('defaultDeviceName', () => {
  it('names the browser and the system it runs on, with the suffix that tells two apart', () => {
    expect(defaultDeviceName(UA.chromeMac, 'K7Q2')).toBe('Chrome on macOS · K7Q2');
    expect(defaultDeviceName(UA.safariIphone, 'K7Q2')).toBe('Safari on iOS · K7Q2');
    expect(defaultDeviceName(UA.safariIpad, 'K7Q2')).toBe('Safari on iPadOS · K7Q2');
    expect(defaultDeviceName(UA.firefoxLinux, 'K7Q2')).toBe('Firefox on Linux · K7Q2');
    // Edge and Opera also say "Chrome"; they are named as themselves.
    expect(defaultDeviceName(UA.edgeWindows, 'K7Q2')).toBe('Edge on Windows · K7Q2');
    expect(defaultDeviceName(UA.operaChromeOs, 'K7Q2')).toBe('Opera on ChromeOS · K7Q2');
    expect(defaultDeviceName(UA.chromeAndroid, 'K7Q2')).toBe('Chrome on Android · K7Q2');
    // Headless Chrome is Chrome, though its token has no word boundary before "Chrome".
    expect(
      defaultDeviceName(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36',
        'K7Q2',
      ),
    ).toBe('Chrome on Linux · K7Q2');
  });

  it('says as much as the user-agent does, and no more', () => {
    expect(defaultDeviceName('', 'K7Q2')).toBe('Browser · K7Q2');
    expect(defaultDeviceName('SomethingNew/1.0 (Windows NT 10.0)', 'K7Q2')).toBe('Browser on Windows · K7Q2');
  });
});

describe('deviceNameSuffix', () => {
  it('spells four characters nobody can misread', () => {
    const suffix = deviceNameSuffix(length => Uint8Array.from({ length }, (_, index) => index * 61));
    expect(suffix).toMatch(/^[2-9A-HJKMNP-Z]{4}$/u);
    expect(suffix).toHaveLength(4);
  });
});

describe('browserDeviceName', () => {
  const agent = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const restore = (): void => {
    if (agent === undefined) Reflect.deleteProperty(globalThis, 'navigator');
    else Object.defineProperty(globalThis, 'navigator', agent);
  };

  it('reads the user agent of this browser and adds a random suffix', () => {
    try {
      Object.defineProperty(globalThis, 'navigator', { value: { userAgent: UA.firefoxLinux }, configurable: true });
      expect(browserDeviceName()).toMatch(/^Firefox on Linux · [2-9A-HJKMNP-Z]{4}$/u);
    } finally {
      restore();
    }
  });

  it('is still a name where there is no navigator at all', () => {
    try {
      Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true });
      expect(browserDeviceName()).toMatch(/^Browser · [2-9A-HJKMNP-Z]{4}$/u);
    } finally {
      restore();
    }
  });
});
