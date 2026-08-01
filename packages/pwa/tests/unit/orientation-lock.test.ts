import { describe, expect, it } from 'bun:test';
import {
  attemptPortraitLock,
  installPortraitLock,
  isPhoneLandscape,
  syncPortraitGate,
} from '../../src/lib/orientation-lock.ts';

const phone = (width: number, height: number, coarse = true): Window =>
  ({
    innerWidth: width,
    innerHeight: height,
    matchMedia: (query: string) => ({ matches: coarse && query.includes('coarse') }),
  }) as unknown as Window;

describe('portrait orientation policy', () => {
  it('accepts a supported lock and safely refuses absent or rejected APIs', async () => {
    const calls: string[] = [];
    const orientation = { lock: async (value: string) => calls.push(value) } as unknown as ScreenOrientation;
    expect(await attemptPortraitLock({ orientation })).toBe(true);
    expect(calls).toEqual(['portrait']);
    expect(await attemptPortraitLock({ orientation: {} as ScreenOrientation })).toBe(false);
    expect(
      await attemptPortraitLock({
        orientation: { lock: async () => Promise.reject(new Error('refused')) } as unknown as ScreenOrientation,
      }),
    ).toBe(false);
  });

  it('only identifies coarse, short landscape as a phone', () => {
    expect(isPhoneLandscape(phone(844, 390))).toBe(true);
    expect(isPhoneLandscape(phone(390, 844))).toBe(false);
    expect(isPhoneLandscape(phone(1440, 900))).toBe(false);
    expect(isPhoneLandscape(phone(844, 390, false))).toBe(false);
  });
});

describe('syncPortraitGate', () => {
  it('mounts one semantic gate for a sideways phone and removes it on rotation', () => {
    const nodes = new Map<string, HTMLElement>();
    const doc = {
      body: { appendChild: (node: HTMLElement) => nodes.set(node.id, node) },
      getElementById: (id: string) => nodes.get(id) ?? null,
      createElement: () => {
        const node = { id: '', innerHTML: '', setAttribute: () => {}, remove: () => nodes.delete(node.id) };
        return node as unknown as HTMLElement;
      },
    } as unknown as Document;

    syncPortraitGate(doc, phone(844, 390));
    syncPortraitGate(doc, phone(844, 390));
    expect(nodes.size).toBe(1);
    syncPortraitGate(doc, phone(390, 844));
    expect(nodes.size).toBe(0);
  });
});

describe('installPortraitLock', () => {
  it('syncs immediately, tracks viewport changes, and retries after the first gesture when needed', async () => {
    const originalScreen = Object.getOwnPropertyDescriptor(globalThis, 'screen');
    Object.defineProperty(globalThis, 'screen', { configurable: true, value: { orientation: {} } });
    const listeners = new Map<string, () => void>();
    const view = {
      ...phone(390, 844),
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    } as unknown as Window;
    const doc = {
      body: { appendChild: () => {} },
      getElementById: () => null,
      createElement: () => ({ id: '', innerHTML: '', setAttribute: () => {}, remove: () => {} }),
    } as unknown as Document;

    try {
      installPortraitLock(view, doc);
      await Promise.resolve();
      listeners.get('pointerdown')?.();
      await Promise.resolve();

      expect([...listeners.keys()].sort()).toEqual(['orientationchange', 'pointerdown', 'resize']);
    } finally {
      if (originalScreen) Object.defineProperty(globalThis, 'screen', originalScreen);
      else Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'screen');
    }
  });
});
