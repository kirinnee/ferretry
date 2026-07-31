import { afterEach, describe, expect, it } from 'bun:test';
import {
  createPcm16WorkletUrl,
  PCM16_WORKLET_NAME,
  PCM16_WORKLET_SOURCE,
  WORKLET_BATCH_FRAMES,
} from '../../src/worklets/pcm16-worklet.ts';

const originalCreateObjectUrl = URL.createObjectURL;

afterEach(() => {
  URL.createObjectURL = originalCreateObjectUrl;
});

describe('PCM16 AudioWorklet', () => {
  it('should ship a syntactically valid classic JavaScript program', () => {
    // AudioWorkletGlobalScope evaluates this value as a classic script, outside
    // the TypeScript/bundler realm that owns this module.
    expect(() => new Function(PCM16_WORKLET_SOURCE)).not.toThrow();
    expect(PCM16_WORKLET_SOURCE).not.toMatch(/^\s*(import|export)\s/mu);
  });

  it('should register the capture processor with a batched Float32 buffer', () => {
    expect(PCM16_WORKLET_NAME).toBe('kteam-pcm16-capture');
    expect(WORKLET_BATCH_FRAMES).toBeGreaterThanOrEqual(1024);
    expect(PCM16_WORKLET_SOURCE).toContain(`new Float32Array(${WORKLET_BATCH_FRAMES})`);
    expect(PCM16_WORKLET_SOURCE).toContain(`registerProcessor(${JSON.stringify(PCM16_WORKLET_NAME)}`);
  });

  it('should transfer full or partial batches and flush before acknowledging control', () => {
    const flush = PCM16_WORKLET_SOURCE.indexOf('this._flush();\n      this.port.postMessage');
    const acknowledge = PCM16_WORKLET_SOURCE.indexOf("this.port.postMessage({ type: 'flushed' })");

    expect(PCM16_WORKLET_SOURCE).toContain('[chunk.buffer]');
    expect(flush).toBeGreaterThanOrEqual(0);
    expect(acknowledge).toBeGreaterThan(flush);
    expect(PCM16_WORKLET_SOURCE).toContain("data.type !== 'flush' && data.type !== 'stop'");
  });

  it('should stop only after flushing and acknowledging the final batch', () => {
    const acknowledge = PCM16_WORKLET_SOURCE.indexOf("type: 'flushed'");
    const stop = PCM16_WORKLET_SOURCE.indexOf('this._stopped = true;');

    expect(stop).toBeGreaterThan(acknowledge);
    expect(PCM16_WORKLET_SOURCE).toMatch(/if \(this\._stopped\) return false;/u);
  });

  it('should interpolate only the compile-time batch size and processor name', () => {
    expect(PCM16_WORKLET_SOURCE).not.toMatch(/\$\{/u);
  });

  it('should mint a JavaScript blob URL for the AudioWorklet module', async () => {
    let received: Blob | undefined;
    URL.createObjectURL = (blob: Blob) => {
      received = blob;
      return 'blob:pcm16-worklet' as `blob:${string}`;
    };

    expect(createPcm16WorkletUrl()).toBe('blob:pcm16-worklet');
    expect(received?.type).toContain('javascript');
    expect(await received?.text()).toBe(PCM16_WORKLET_SOURCE);
  });
});
