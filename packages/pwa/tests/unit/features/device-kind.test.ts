/**
 * A phone has no terminal, and the page can see that.
 *
 * The two mistakes this can make are NOT symmetric, and the tests are shaped
 * around that. Calling a phone a desktop shows install commands to somebody who
 * cannot run them — visibly wrong, one tap from the route they wanted. Calling a
 * desktop a phone hides the daemon route from the only kind of machine that can
 * host one, which is the product's main path. So `desktop` is the answer on
 * absent evidence, and every `mobile` claim has to be positively evidenced.
 */

import { describe, expect, it } from 'bun:test';

import { detectDeviceKind } from '../../../src/features/onboarding/device-kind.ts';

describe('detectDeviceKind', () => {
  it('recognises the devices that announce themselves', () => {
    for (const userAgent of [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      'Mozilla/5.0 (iPod touch; CPU iPhone OS 16_0 like Mac OS X)',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36',
      // An Android TABLET, which is mobile here for the only reason that
      // matters: there is nowhere to paste an install command.
      'Mozilla/5.0 (Linux; Android 13; SM-X700) Safari/537.36',
      'Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1)',
      'Mozilla/5.0 (BlackBerry; U; BlackBerry 9900)',
      'Opera/9.80 (J2ME/MIDP; Opera Mini/9.80)',
      'Mozilla/5.0 (Linux; U; Android 4.4.3; KFTHWI Build/KTU84M) Silk/47.1',
      'Mozilla/5.0 (compatible; MSIE 10.0; Windows Phone 8.0; IEMobile/10.0)',
    ]) {
      expect(detectDeviceKind({ userAgent })).toBe('mobile');
    }
  });

  it('catches an iPad pretending to be a Mac', () => {
    // Since iPadOS 13 the user agent is a desktop Safari's, and `platform` is
    // `MacIntel` on both. Touch is the only difference that ships.
    const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
    expect(detectDeviceKind({ userAgent: ipad, platform: 'MacIntel', maxTouchPoints: 5 })).toBe('mobile');
    expect(detectDeviceKind({ userAgent: ipad, platform: 'MacIntel', maxTouchPoints: 0 })).toBe('desktop');
    // The `platform` route alone, for a browser that reports it without the
    // Macintosh token.
    expect(detectDeviceKind({ userAgent: 'Something/1.0', platform: 'MacIntel', maxTouchPoints: 5 })).toBe('mobile');
  });

  it('does not call a touchscreen laptop a phone', () => {
    // A Surface reports touch points and is a perfectly good daemon host. The
    // iPad test is confined to Apple desktop strings for exactly this reason.
    expect(
      detectDeviceKind({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
        platform: 'Win32',
        maxTouchPoints: 10,
      }),
    ).toBe('desktop');
  });

  it('answers desktop when the browser will not say', () => {
    expect(detectDeviceKind()).toBe('desktop');
    expect(detectDeviceKind({})).toBe('desktop');
    expect(detectDeviceKind({ userAgent: undefined, platform: undefined, maxTouchPoints: undefined })).toBe('desktop');
    expect(detectDeviceKind({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe('desktop');
  });
});
