/**
 * The microphone's permission, as the Voice step reads it: every way it can go wrong is a state that carries its own remedy,
 * and neither call throws. The page is plain objects; nothing opens a real microphone.
 */

import { describe, expect, it } from 'bun:test';
import {
  browserMic,
  MIC_BUSY_MESSAGE,
  MIC_DENIED_MESSAGE,
  MIC_INSECURE_MESSAGE,
  MIC_MISSING_MESSAGE,
  type MicGlobalLike,
} from '../../../../../app/features/onboarding/mic-permission.ts';

const failing = (name: string): MicGlobalLike => ({
  navigator: {
    mediaDevices: { getUserMedia: () => Promise.reject(Object.assign(new Error(name), { name })) },
  },
});

const permission = (state: string): MicGlobalLike => ({
  navigator: {
    mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) },
    permissions: { query: () => Promise.resolve({ state }) },
  },
});

describe('browserMic().state', () => {
  it('reads what the browser holds without asking', async () => {
    expect(await browserMic(permission('granted')).state()).toEqual({ kind: 'granted' });
    expect(await browserMic(permission('denied')).state()).toEqual({ kind: 'denied', message: MIC_DENIED_MESSAGE });
    expect(await browserMic(permission('prompt')).state()).toEqual({ kind: 'prompt' });
  });

  it('reads as "will ask" when the browser cannot name the microphone', async () => {
    const refusing: MicGlobalLike = {
      navigator: {
        mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) },
        permissions: { query: () => Promise.reject(new TypeError('unsupported')) },
      },
    };
    expect(await browserMic(refusing).state()).toEqual({ kind: 'prompt' });
    const silent: MicGlobalLike = {
      navigator: { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) } },
    };
    expect(await browserMic(silent).state()).toEqual({ kind: 'prompt' });
  });

  it('says there is nothing to ask when the page has no microphone API (an insecure page)', async () => {
    expect(await browserMic({ navigator: {} }).state()).toEqual({
      kind: 'unavailable',
      message: MIC_INSECURE_MESSAGE,
      retry: false,
    });
    expect(await browserMic({}).state()).toEqual({ kind: 'unavailable', message: MIC_INSECURE_MESSAGE, retry: false });
  });
});

describe('browserMic().request', () => {
  it('opens the microphone once, shuts every track again, and reads granted', async () => {
    const stopped: string[] = [];
    const page: MicGlobalLike = {
      navigator: {
        mediaDevices: {
          getUserMedia: () =>
            Promise.resolve({
              getTracks: () => [{ stop: () => stopped.push('a') }, { stop: () => stopped.push('b') }],
            }),
        },
      },
    };
    expect(await browserMic(page).request()).toEqual({ kind: 'granted' });
    expect(stopped).toEqual(['a', 'b']);
  });

  it('turns every refusal into a state that says what to do', async () => {
    expect(await browserMic(failing('NotAllowedError')).request()).toEqual({
      kind: 'denied',
      message: MIC_DENIED_MESSAGE,
    });
    expect(await browserMic(failing('NotFoundError')).request()).toEqual({
      kind: 'unavailable',
      message: MIC_MISSING_MESSAGE,
      retry: true,
    });
    expect(await browserMic(failing('NotReadableError')).request()).toEqual({
      kind: 'unavailable',
      message: MIC_BUSY_MESSAGE,
      retry: true,
    });
    expect(await browserMic(failing('SomethingElse')).request()).toEqual({
      kind: 'unavailable',
      message: MIC_INSECURE_MESSAGE,
      retry: false,
    });
  });

  it('reads unavailable, not a throw, with no microphone API', async () => {
    expect((await browserMic({}).request()).kind).toBe('unavailable');
  });
});
