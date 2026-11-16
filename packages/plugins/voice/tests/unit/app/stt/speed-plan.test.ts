/**
 * Proves the speed chooser (`speed-plan.ts`): it is total, it never picks a path the build, the model or the
 * device cannot run, it picks the fastest one that qualifies, and it says WHY it did not pick a faster one.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { ON_DEVICE_MODEL_IDS } from '../../../../app/lib/stt/model-catalog.ts';
import {
  BUILD_PATHS,
  chooseSpeedPlan,
  FAILURE_FORGET_MS,
  MAX_THREADS,
  MODEL_PATHS,
  NO_MEMORY,
  NO_SIGNALS,
  SPEED_CONSEQUENCE_TEXT,
  SPEED_PATH_LABEL,
  SPEED_PATH_ORDER,
  SPEED_REASON_TEXT,
  type SpeedPath,
  type SpeedSignals,
  speedLine,
  threadsFor,
} from '../../../../app/lib/stt/speed-plan.ts';

const NOW = 1_000_000_000_000;
const ISOLATED: SpeedSignals = { ...NO_SIGNALS, crossOriginIsolated: true, hardwareConcurrency: 8, deviceMemoryGb: 8 };
const WITH_GPU: SpeedSignals = { ...ISOLATED, webgpuAdapter: true };

describe('the build and the models', () => {
  it('ships WebAssembly only: the WebGPU runtime is over the host size limit', () => {
    should([...BUILD_PATHS]).deepEqual(['wasm-threads', 'wasm-single']);
  });

  it('knows every catalog model, and every one can at least run on one thread', () => {
    for (const id of ON_DEVICE_MODEL_IDS) should(MODEL_PATHS[id]).containEql('wasm-single');
  });

  it('only offers threads to the ONNX Runtime models; sherpa and Vosk are single-thread binaries', () => {
    const threaded = ON_DEVICE_MODEL_IDS.filter(id => MODEL_PATHS[id].includes('wasm-threads'));
    should([...threaded].sort()).deepEqual(['parakeet', 'whisper-base-en', 'whisper-tiny-en']);
  });

  it('never offers WebGPU to the int8 Parakeet encoder', () => {
    should(MODEL_PATHS.parakeet).not.containEql('webgpu');
  });
});

describe('chooseSpeedPlan', () => {
  it('is single-thread on a page that is not cross-origin isolated, and says that is why', () => {
    const plan = chooseSpeedPlan('parakeet', { ...ISOLATED, crossOriginIsolated: false }, NO_MEMORY, NOW);
    should(plan).deepEqual({ path: 'wasm-single', threads: 1, reason: 'not-isolated' });
  });

  it('uses threads on an isolated page: half the cores, between 2 and 4', () => {
    should(chooseSpeedPlan('parakeet', ISOLATED, NO_MEMORY, NOW)).deepEqual({
      path: 'wasm-threads',
      threads: MAX_THREADS,
      reason: 'fastest',
    });
    should(chooseSpeedPlan('whisper-base-en', { ...ISOLATED, hardwareConcurrency: 4 }, NO_MEMORY, NOW).threads).equal(
      2,
    );
  });

  it('stays on one thread with little memory, or with too few cores', () => {
    should(chooseSpeedPlan('parakeet', { ...ISOLATED, deviceMemoryGb: 4 }, NO_MEMORY, NOW)).deepEqual({
      path: 'wasm-single',
      threads: 1,
      reason: 'low-memory',
    });
    should(chooseSpeedPlan('parakeet', { ...ISOLATED, hardwareConcurrency: 2 }, NO_MEMORY, NOW).reason).equal(
      'few-cores',
    );
    should(chooseSpeedPlan('parakeet', { ...ISOLATED, hardwareConcurrency: null }, NO_MEMORY, NOW).reason).equal(
      'few-cores',
    );
  });

  it('treats a browser that does not report memory as not low', () => {
    should(chooseSpeedPlan('parakeet', { ...ISOLATED, deviceMemoryGb: null }, NO_MEMORY, NOW).path).equal(
      'wasm-threads',
    );
  });

  it('is single-thread for an engine that has no faster path, whatever the device offers', () => {
    for (const id of ['parakeet-tdt-110m', 'vosk-small-en', 'moonshine-tiny-en'] as const)
      should(chooseSpeedPlan(id, WITH_GPU, NO_MEMORY, NOW)).deepEqual({
        path: 'wasm-single',
        threads: 1,
        reason: 'only-path',
      });
  });

  it('skips a path that failed recently, and tries it again after a week', () => {
    const failed = { failures: [{ model: 'parakeet' as const, path: 'wasm-threads' as const, at: NOW - 1000 }] };
    should(chooseSpeedPlan('parakeet', ISOLATED, failed, NOW)).deepEqual({
      path: 'wasm-single',
      threads: 1,
      reason: 'failed-before',
    });
    should(chooseSpeedPlan('parakeet', ISOLATED, failed, NOW + FAILURE_FORGET_MS).path).equal('wasm-threads');
  });

  it('keeps one model’s failure from touching another', () => {
    const failed = { failures: [{ model: 'parakeet' as const, path: 'wasm-threads' as const, at: NOW }] };
    should(chooseSpeedPlan('whisper-base-en', ISOLATED, failed, NOW).path).equal('wasm-threads');
  });

  it('ignores a failure dated in the future rather than trusting it forever', () => {
    const failed = { failures: [{ model: 'parakeet' as const, path: 'wasm-threads' as const, at: NOW + 5_000 }] };
    should(chooseSpeedPlan('parakeet', ISOLATED, failed, NOW).path).equal('wasm-threads');
  });

  describe('once a build ships WebGPU', () => {
    const SHIPS_GPU: readonly SpeedPath[] = ['webgpu', 'wasm-threads', 'wasm-single'];

    it('prefers the GPU where the model can use it and the device has an adapter', () => {
      should(chooseSpeedPlan('whisper-base-en', WITH_GPU, NO_MEMORY, NOW, SHIPS_GPU)).deepEqual({
        path: 'webgpu',
        threads: 1,
        reason: 'fastest',
      });
    });

    it('never gives the int8 Parakeet encoder the GPU', () => {
      should(chooseSpeedPlan('parakeet', WITH_GPU, NO_MEMORY, NOW, SHIPS_GPU).path).equal('wasm-threads');
    });

    it('falls to threads, then one thread, as paths fail', () => {
      const gpuFailed = { failures: [{ model: 'whisper-base-en' as const, path: 'webgpu' as const, at: NOW }] };
      should(chooseSpeedPlan('whisper-base-en', WITH_GPU, gpuFailed, NOW, SHIPS_GPU).path).equal('wasm-threads');
      should(chooseSpeedPlan('whisper-base-en', NO_SIGNALS, NO_MEMORY, NOW, SHIPS_GPU)).deepEqual({
        path: 'wasm-single',
        threads: 1,
        reason: 'no-gpu',
      });
    });
  });

  it('is total: every model on every signal combination gets a runnable plan', () => {
    const bools = [false, true];
    for (const id of ON_DEVICE_MODEL_IDS)
      for (const gpu of bools)
        for (const isolated of bools)
          for (const cores of [null, 1, 2, 4, 8, 64, Number.NaN])
            for (const memory of [null, 0.5, 4, 8])
              for (const build of [BUILD_PATHS, SPEED_PATH_ORDER]) {
                const plan = chooseSpeedPlan(
                  id,
                  {
                    webgpuAdapter: gpu,
                    crossOriginIsolated: isolated,
                    hardwareConcurrency: cores,
                    deviceMemoryGb: memory,
                  },
                  NO_MEMORY,
                  NOW,
                  build,
                );
                should(MODEL_PATHS[id]).containEql(plan.path);
                should(build).containEql(plan.path);
                should(plan.threads).be.within(1, MAX_THREADS);
                if (plan.path !== 'wasm-threads') should(plan.threads).equal(1);
                else should(isolated).equal(true);
                should(SPEED_REASON_TEXT[plan.reason]).be.a.String();
              }
  });

  it('answers wasm-single for an id it has never heard of, rather than throwing', () => {
    const plan = chooseSpeedPlan('from-the-future' as never, WITH_GPU, NO_MEMORY, NOW);
    should(plan.path).equal('wasm-single');
  });
});

describe('threadsFor', () => {
  it('is half the cores, at least 2 and at most 4, else 1', () => {
    should([null, Number.NaN, 1, 3, 4, 6, 8, 16, 128].map(threadsFor)).deepEqual([1, 1, 1, 1, 2, 3, 4, 4, 4]);
  });
});

describe('the words', () => {
  it('names every path in the words Settings uses', () => {
    should(SPEED_PATH_LABEL).deepEqual({
      webgpu: 'fast (graphics chip)',
      'wasm-threads': 'fast (several cores)',
      'wasm-single': 'standard (one core)',
    });
  });

  it('keeps technical names off the screen', () => {
    const visible = [
      ...Object.values(SPEED_PATH_LABEL),
      ...Object.values(SPEED_CONSEQUENCE_TEXT),
      ...Object.values(SPEED_REASON_TEXT),
    ].join('\n');
    should(visible).not.match(/webassembly|webgpu|thread|worker|wasm|gpu\b/i);
  });

  it('says what each speed means, with a number only for the one that was measured', () => {
    should(SPEED_CONSEQUENCE_TEXT['wasm-single']).equal('Your words appear a moment after you stop talking.');
    should(SPEED_CONSEQUENCE_TEXT['wasm-threads']).containEql('2–3 times faster');
    should(SPEED_CONSEQUENCE_TEXT.webgpu).not.match(/\d/);
  });

  it('names the faster mode that was left out, and whether it is unavailable or turned off', () => {
    should(SPEED_REASON_TEXT['not-isolated']).containEql('not available on this site yet');
    should(SPEED_REASON_TEXT['failed-before']).containEql('available on this device but turned off');
    should(SPEED_REASON_TEXT['low-memory']).containEql('turned off');
  });

  it('prints the read-only line', () => {
    should(speedLine({ path: 'wasm-single', threads: 1, reason: 'only-path' })).equal(
      'Speech speed: standard (one core)',
    );
    should(speedLine({ path: 'wasm-threads', threads: 4, reason: 'fastest' })).equal(
      'Speech speed: fast (several cores)',
    );
  });
});
