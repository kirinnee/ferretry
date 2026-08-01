/**
 * Feature detection, as data.
 *
 * Every honest sentence this feature says about a device is derived from here,
 * so it is a pure function of an injected `navigator`/`window` rather than a
 * scattering of `typeof window !== 'undefined'` checks. That is what lets the
 * copy be tested: "iOS may evict the model" is a UI string somewhere, but
 * "this is iOS" is a value with a test.
 */

export interface SttNavigatorLike {
  userAgent?: string;
  maxTouchPoints?: number;
  hardwareConcurrency?: number;
  mediaDevices?: { getUserMedia?: unknown };
  gpu?: unknown;
  storage?: { estimate?: () => Promise<{ quota?: number; usage?: number }> };
}

export interface SttEnvironment {
  navigator?: SttNavigatorLike | undefined;
  isSecureContext?: boolean;
  hasAudioWorklet?: boolean;
  hasCacheStorage?: boolean;
}

export interface SttCapabilities {
  /**
   * `navigator.mediaDevices.getUserMedia` exists. FALSE in an insecure
   * context, where the API is absent rather than denied.
   */
  readonly microphone: boolean;
  /** `window.isSecureContext`. The reason `microphone` is false when it is. */
  readonly secureContext: boolean;
  /**
   * `navigator.gpu` exists. NOT the same as "WebGPU is usable here" — see
   * `local-engine.ts`, which refuses WebGPU for the int8 model we host.
   */
  readonly webgpu: boolean;
  /** AudioWorklet available; false means the ScriptProcessor fallback. */
  readonly audioWorklet: boolean;
  /** CacheStorage available — required to pre-download the browser model. */
  readonly cacheStorage: boolean;
  /** Apple's WebKit. Carries the model-eviction and WebGPU caveats. */
  readonly likelyIos: boolean;
  /** Phone or tablet by pointer/UA. Drives the "slower on phones" copy. */
  readonly likelyMobile: boolean;
  /** Logical cores, when the browser says. */
  readonly cores: number | null;
}

const userAgentOf = (nav: SttNavigatorLike | undefined): string =>
  typeof nav?.userAgent === 'string' ? nav.userAgent : '';

/**
 * iPadOS reports a desktop Safari UA, so the "Macintosh with a touchscreen"
 * probe is the only reliable tell — and it is the standard one.
 */
export const isLikelyIos = (nav: SttNavigatorLike | undefined): boolean => {
  const agent = userAgentOf(nav);
  if (/iPhone|iPad|iPod/u.test(agent)) return true;
  const maxTouch = typeof nav?.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0;
  return /Macintosh/u.test(agent) && maxTouch > 1;
};

export const isLikelyMobile = (nav: SttNavigatorLike | undefined): boolean => {
  if (isLikelyIos(nav)) return true;
  return /Android|Mobile|Tablet|Silk|Kindle/u.test(userAgentOf(nav));
};

/**
 * Reads the ambient browser globals into a plain value.
 *
 * This is the ONLY place the subsystem touches `navigator`, `isSecureContext`,
 * `AudioWorkletNode` or `caches`. Everything downstream takes an
 * `SttEnvironment`, so a test never has to install globals to describe a
 * device.
 */
export interface SttGlobalsLike {
  navigator?: unknown;
  isSecureContext?: unknown;
  AudioWorkletNode?: unknown;
  caches?: unknown;
}

export const browserSttEnvironment = (global: SttGlobalsLike = globalThis): SttEnvironment => ({
  navigator: (global.navigator as SttNavigatorLike | undefined) ?? undefined,
  isSecureContext: Boolean(global.isSecureContext),
  hasAudioWorklet: typeof global.AudioWorkletNode === 'function',
  hasCacheStorage: typeof global.caches === 'object' && global.caches !== null,
});

export const readSttCapabilities = (env: SttEnvironment): SttCapabilities => {
  const nav = env.navigator;
  return {
    microphone: typeof nav?.mediaDevices?.getUserMedia === 'function',
    secureContext: env.isSecureContext ?? false,
    webgpu: Boolean(nav && 'gpu' in nav && nav.gpu),
    audioWorklet: env.hasAudioWorklet ?? false,
    cacheStorage: env.hasCacheStorage ?? false,
    likelyIos: isLikelyIos(nav),
    likelyMobile: isLikelyMobile(nav),
    cores: typeof nav?.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
  };
};

/**
 * Free bytes the browser is willing to admit to, or `null` when it will not
 * say. Used only to warn BEFORE a ~640 MB download, never to block one: the
 * estimate is deliberately fuzzy in every engine and treating it as a hard
 * gate would refuse devices that would have coped fine.
 */
export const estimateFreeBytes = async (nav: SttNavigatorLike | undefined): Promise<number | null> => {
  const storage = nav?.storage;
  const estimate = storage?.estimate;
  if (!storage || typeof estimate !== 'function') return null;
  try {
    const result = await estimate.call(storage);
    const quota = typeof result?.quota === 'number' ? result.quota : null;
    const usage = typeof result?.usage === 'number' ? result.usage : 0;
    return quota === null ? null : Math.max(0, quota - usage);
  } catch {
    return null;
  }
};
