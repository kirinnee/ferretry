/**
 * Proves the default engine: a phone (touch-first, or at most 4 GB) defaults to Parakeet 110M and a
 * computer to Parakeet 0.6B, the device's own choice always wins, a machine default of browser voice is
 * honoured, and a machine default of "parakeet" means the Parakeet that suits this device.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { DEFAULT_ON_DEVICE_ENGINE, deviceClassOf, effectiveEngine } from '../../../src/lib/stt/engine-defaults.ts';
import { onDeviceModel } from '../../../src/lib/stt/model-catalog.ts';

const page = (coarse: boolean | null, deviceMemory?: unknown) => ({
  ...(coarse === null ? {} : { matchMedia: (query: string) => ({ matches: coarse && query === '(pointer: coarse)' }) }),
  ...(deviceMemory === undefined ? {} : { navigator: { deviceMemory } }),
});

describe('deviceClassOf', () => {
  it('calls a touch-first device or one with at most 4 GB a phone, anything else a computer', () => {
    should(deviceClassOf(page(true))).equal('phone');
    should(deviceClassOf(page(false, 4))).equal('phone');
    should(deviceClassOf(page(false, 0.5))).equal('phone');
    should(deviceClassOf(page(false, 8))).equal('computer');
    should(deviceClassOf(page(false, 'lots'))).equal('computer');
    should(deviceClassOf(page(null))).equal('computer');
  });
});

describe('effectiveEngine', () => {
  it('keeps the device’s own choice', () => {
    should(effectiveEngine('whisper-tiny-en', 'browser', 'phone')).equal('whisper-tiny-en');
    should(effectiveEngine('browser', null, 'computer')).equal('browser');
  });

  it('honours a machine default of browser voice', () => {
    should(effectiveEngine(null, 'browser', 'phone')).equal('browser');
  });

  it('picks the Parakeet that suits the device for a machine default of Parakeet, or no default', () => {
    should(effectiveEngine(null, 'parakeet', 'phone')).equal('parakeet-tdt-110m');
    should(effectiveEngine(null, 'parakeet', 'computer')).equal('parakeet');
    should(effectiveEngine(null, null, 'phone')).equal('parakeet-tdt-110m');
    should(effectiveEngine(null, null, 'computer')).equal('parakeet');
  });

  it('names catalog models only', () => {
    for (const id of Object.values(DEFAULT_ON_DEVICE_ENGINE)) should(onDeviceModel(id)).not.be.null();
  });
});
