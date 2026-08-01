import { describe, it } from 'bun:test';
import should from 'should';
import {
  browserSttEnvironment,
  estimateFreeBytes,
  isLikelyIos,
  isLikelyMobile,
  readSttCapabilities,
  type SttNavigatorLike,
} from '../../../src/lib/stt/capabilities.ts';

const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';

describe('isLikelyIos', () => {
  it('recognises the phone and tablet user agents outright', () => {
    should(isLikelyIos({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' })).be.true();
    should(isLikelyIos({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0)' })).be.true();
    should(isLikelyIos({ userAgent: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 17_0)' })).be.true();
  });

  it('recognises iPadOS behind its desktop Safari disguise, by the touchscreen', () => {
    should(isLikelyIos({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 5 })).be.true();
  });

  it('does not mistake a real Mac for an iPad', () => {
    should(isLikelyIos({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 0 })).be.false();
    should(isLikelyIos({ userAgent: IPAD_DESKTOP_UA })).be.false();
  });

  it('treats a navigator that says nothing as not iOS', () => {
    should(isLikelyIos(undefined)).be.false();
    should(isLikelyIos({})).be.false();
  });
});

describe('isLikelyMobile', () => {
  it('counts every iOS device as mobile', () => {
    should(isLikelyMobile({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 5 })).be.true();
  });

  it('recognises the non-Apple handheld user agents', () => {
    should(isLikelyMobile({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile' })).be.true();
    should(isLikelyMobile({ userAgent: 'Mozilla/5.0 (Linux; U) Silk/3.0' })).be.true();
  });

  it('leaves a desktop alone', () => {
    should(isLikelyMobile({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0' })).be.false();
  });
});

describe('readSttCapabilities', () => {
  it('reports a fully capable secure desktop', () => {
    const capabilities = readSttCapabilities({
      navigator: {
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0',
        mediaDevices: { getUserMedia: () => undefined },
        gpu: {},
        hardwareConcurrency: 16,
      },
      isSecureContext: true,
      hasAudioWorklet: true,
      hasCacheStorage: true,
    });

    should(capabilities).deepEqual({
      microphone: true,
      secureContext: true,
      webgpu: true,
      audioWorklet: true,
      cacheStorage: true,
      likelyIos: false,
      likelyMobile: false,
      cores: 16,
    });
  });

  it('reports an insecure context, where the microphone API is absent rather than denied', () => {
    const capabilities = readSttCapabilities({ navigator: {}, isSecureContext: false });

    should(capabilities.microphone).be.false();
    should(capabilities.secureContext).be.false();
    should(capabilities.webgpu).be.false();
    should(capabilities.cores).be.null();
  });

  it('treats an unstated environment as an incapable one rather than guessing', () => {
    const capabilities = readSttCapabilities({});

    should(capabilities.secureContext).be.false();
    should(capabilities.audioWorklet).be.false();
    should(capabilities.cacheStorage).be.false();
    should(capabilities.microphone).be.false();
  });

  it('does not call a `gpu` key that is present but null WebGPU', () => {
    should(readSttCapabilities({ navigator: { gpu: undefined } }).webgpu).be.false();
  });
});

describe('browserSttEnvironment', () => {
  it('reads the ambient globals into a plain value', () => {
    const navigatorLike: SttNavigatorLike = { userAgent: 'test' };
    const environment = browserSttEnvironment({
      navigator: navigatorLike,
      isSecureContext: true,
      AudioWorkletNode: () => undefined,
      caches: {},
    });

    should(environment).deepEqual({
      navigator: navigatorLike,
      isSecureContext: true,
      hasAudioWorklet: true,
      hasCacheStorage: true,
    });
  });

  it('reports absent globals as absent capabilities', () => {
    should(browserSttEnvironment({ caches: null })).deepEqual({
      navigator: undefined,
      isSecureContext: false,
      hasAudioWorklet: false,
      hasCacheStorage: false,
    });
  });

  it('defaults to the real globalThis', () => {
    should(browserSttEnvironment()).have.property('hasCacheStorage');
  });
});

describe('estimateFreeBytes', () => {
  it('subtracts usage from quota', async () => {
    const free = await estimateFreeBytes({ storage: { estimate: async () => ({ quota: 1_000, usage: 250 }) } });
    should(free).equal(750);
  });

  it('treats a missing usage as zero', async () => {
    should(await estimateFreeBytes({ storage: { estimate: async () => ({ quota: 400 }) } })).equal(400);
  });

  it('never reports a negative headroom', async () => {
    const free = await estimateFreeBytes({ storage: { estimate: async () => ({ quota: 100, usage: 900 }) } });
    should(free).equal(0);
  });

  it('says nothing when the browser will not say', async () => {
    should(await estimateFreeBytes(undefined)).be.null();
    should(await estimateFreeBytes({})).be.null();
    should(await estimateFreeBytes({ storage: {} })).be.null();
    should(await estimateFreeBytes({ storage: { estimate: async () => ({ usage: 5 }) } })).be.null();
  });

  it('swallows a throwing estimate rather than failing the caller', async () => {
    const free = await estimateFreeBytes({
      storage: {
        estimate: async () => {
          throw new Error('denied');
        },
      },
    });
    should(free).be.null();
  });
});
