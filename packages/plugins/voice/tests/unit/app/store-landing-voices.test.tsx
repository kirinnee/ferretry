import { describe, expect, it } from 'bun:test';
import { browserParakeetVoice } from '../../../app/lib/stt/parakeet-voice.ts';
import { createVoiceStore } from '../../../app/lib/voice-store.tsx';

describe('the voice store’s on-device voices', () => {
  it('lists only the injected voice when a suite supplies a voice and no catalogue', () => {
    const voice = browserParakeetVoice(globalThis as never, null);

    const store = createVoiceStore({ voice });

    expect(store.voice).toBe(voice);
    expect(store.voices.list()).toEqual([voice]);
    expect(store.voices.get(voice.model.id)).toBe(voice);
  });
});

describe('the voice store in a browser whose storage accessor throws', () => {
  it('opens without a settings store behind it', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied');
      },
    });
    try {
      expect(() => createVoiceStore()).not.toThrow();
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});
