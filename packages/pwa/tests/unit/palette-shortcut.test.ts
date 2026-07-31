import { afterEach, describe, expect, it } from 'bun:test';
import { PALETTE_KEYSHORTCUTS, isApplePlatform, paletteShortcutLabel } from '../../src/shell/palette-shortcut.ts';

const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

const withNavigator = <T>(value: unknown, body: () => T): T => {
  if (value === undefined) Reflect.deleteProperty(globalThis, 'navigator');
  else Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value });
  return body();
};

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'navigator', original);
  else Reflect.deleteProperty(globalThis, 'navigator');
});

describe('isApplePlatform', () => {
  it('prefers the modern platform hint over the deprecated strings', () => {
    expect(
      withNavigator({ userAgentData: { platform: 'macOS' }, platform: 'Win32', userAgent: 'Windows' }, isApplePlatform),
    ).toBe(true);
  });

  it('falls back to `platform`, then to the user agent', () => {
    expect(withNavigator({ platform: 'iPhone', userAgent: 'Windows' }, isApplePlatform)).toBe(true);
    expect(withNavigator({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0)' }, isApplePlatform)).toBe(true);
  });

  it('is false for a non-Apple platform and for a navigator that says nothing', () => {
    expect(withNavigator({ platform: 'Win32', userAgent: 'Windows NT 10.0' }, isApplePlatform)).toBe(false);
    expect(withNavigator({}, isApplePlatform)).toBe(false);
  });

  it('is false where there is no navigator at all', () => {
    expect(withNavigator(undefined, isApplePlatform)).toBe(false);
  });
});

describe('paletteShortcutLabel', () => {
  it('prints the key the reader actually has on their keyboard', () => {
    expect(withNavigator({ platform: 'MacIntel' }, paletteShortcutLabel)).toBe('⌘K');
    expect(withNavigator({ platform: 'Linux x86_64' }, paletteShortcutLabel)).toBe('Ctrl K');
  });
});

describe('PALETTE_KEYSHORTCUTS', () => {
  it('declares both live bindings, because both work on every platform', () => {
    expect(PALETTE_KEYSHORTCUTS).toBe('Meta+K Control+K');
  });
});
