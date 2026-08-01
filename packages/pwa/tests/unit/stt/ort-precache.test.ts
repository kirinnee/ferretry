import { describe, it } from 'bun:test';
import should from 'should';
import { isOrtRuntimeAsset, ORT_RUNTIME_BYTES } from '../../../src/lib/stt/ort-precache.ts';

describe('isOrtRuntimeAsset', () => {
  it('matches the runtime binary through a bundler content hash', () => {
    should(isOrtRuntimeAsset('assets/ort-wasm-simd-threaded.jsep-a1b2c3d4.wasm')).be.true();
    should(isOrtRuntimeAsset('assets/ort-wasm-simd-threaded-9f8e7d.wasm')).be.true();
    should(isOrtRuntimeAsset('assets/ort-wasm-simd-threaded.jsep.mjs')).be.true();
  });

  it('matches the manifest path, the root-absolute URL and the full URL alike', () => {
    should(isOrtRuntimeAsset('ort-wasm-simd-threaded.wasm')).be.true();
    should(isOrtRuntimeAsset('/assets/ort-wasm-simd-threaded.wasm')).be.true();
    should(isOrtRuntimeAsset('https://pwa.example.test/assets/ort-wasm-simd-threaded.wasm')).be.true();
  });

  it('ignores a query or fragment the runtime may append', () => {
    should(isOrtRuntimeAsset('/assets/ort-wasm-simd-threaded.wasm?v=2')).be.true();
    should(isOrtRuntimeAsset('/assets/ort-wasm-simd-threaded.wasm#frag')).be.true();
  });

  it('leaves every app-shell asset in the install closure', () => {
    should(isOrtRuntimeAsset('assets/index-a1b2c3.js')).be.false();
    should(isOrtRuntimeAsset('assets/ort-wasm-simd-threaded.wasm.map')).be.false();
    should(isOrtRuntimeAsset('assets/my-ort-wasm-simd-threaded.wasm')).be.false();
    should(isOrtRuntimeAsset('')).be.false();
  });
});

describe('ORT_RUNTIME_BYTES', () => {
  it('records why the runtime is worth deferring from the install', () => {
    should(ORT_RUNTIME_BYTES.jsepWasm).be.above(20_000_000);
    should(ORT_RUNTIME_BYTES.plainWasm).be.below(ORT_RUNTIME_BYTES.jsepWasm);
  });
});
