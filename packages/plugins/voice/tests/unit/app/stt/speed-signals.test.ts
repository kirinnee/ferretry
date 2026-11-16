/**
 * Proves what the page says about its speed options (`speed-signals.ts`): every read is defensive, a field
 * that is missing or odd reads as "offers nothing", and a GPU probe that hangs cannot hold anything.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  GPU_PROBE_MS,
  probeWebGpuAdapter,
  readSyncSpeedSignals,
  type SpeedGlobalLike,
} from '../../../../app/lib/stt/speed-signals.ts';

describe('readSyncSpeedSignals', () => {
  it('reads isolation, cores and memory', () => {
    should(
      readSyncSpeedSignals({
        crossOriginIsolated: true,
        navigator: { hardwareConcurrency: 8, deviceMemory: 8 },
      }),
    ).deepEqual({ webgpuAdapter: false, crossOriginIsolated: true, hardwareConcurrency: 8, deviceMemoryGb: 8 });
  });

  it('reads an empty page as a device that offers nothing', () => {
    should(readSyncSpeedSignals({})).deepEqual({
      webgpuAdapter: false,
      crossOriginIsolated: false,
      hardwareConcurrency: null,
      deviceMemoryGb: null,
    });
  });

  it('refuses odd values rather than passing them on', () => {
    const signals = readSyncSpeedSignals({
      crossOriginIsolated: 'yes',
      navigator: { hardwareConcurrency: 'many', deviceMemory: -2 },
    });
    should(signals.crossOriginIsolated).equal(false);
    should(signals.hardwareConcurrency).equal(null);
    should(signals.deviceMemoryGb).equal(null);
    should(readSyncSpeedSignals({ navigator: { hardwareConcurrency: 7.9 } }).hardwareConcurrency).equal(7);
    should(readSyncSpeedSignals({ navigator: { hardwareConcurrency: 0 } }).hardwareConcurrency).equal(null);
  });

  it('survives a getter that throws', () => {
    const hostile = {
      get crossOriginIsolated(): boolean {
        throw new Error('no');
      },
      get navigator(): never {
        throw new Error('no');
      },
    } as unknown as SpeedGlobalLike;
    should(readSyncSpeedSignals(hostile).hardwareConcurrency).equal(null);
  });
});

describe('probeWebGpuAdapter', () => {
  it('is true when an adapter comes back', async () => {
    should(await probeWebGpuAdapter({ navigator: { gpu: { requestAdapter: async () => ({}) } } })).equal(true);
  });

  it('is false with no WebGPU, a null adapter, a rejection, or a throw', async () => {
    should(await probeWebGpuAdapter({})).equal(false);
    should(await probeWebGpuAdapter({ navigator: { gpu: { requestAdapter: async () => null } } })).equal(false);
    should(
      await probeWebGpuAdapter({ navigator: { gpu: { requestAdapter: () => Promise.reject(new Error('lost')) } } }),
    ).equal(false);
    should(
      await probeWebGpuAdapter({
        navigator: {
          gpu: {
            requestAdapter: () => {
              throw new Error('sync');
            },
          },
        },
      }),
    ).equal(false);
  });

  it('gives up on a driver that never answers', async () => {
    const started = performance.now();
    const answer = await probeWebGpuAdapter({
      navigator: { gpu: { requestAdapter: () => new Promise(() => undefined) } },
    });
    should(answer).equal(false);
    should(performance.now() - started).be.within(GPU_PROBE_MS - 100, GPU_PROBE_MS + 1_000);
  });
});
