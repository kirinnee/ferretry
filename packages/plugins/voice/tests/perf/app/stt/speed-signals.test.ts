import { describe, it } from 'bun:test';
import should from 'should';
import { GPU_PROBE_MS, probeWebGpuAdapter } from '../../../../app/lib/stt/speed-signals.ts';

// The speed half of `tests/unit/app/stt/speed-signals.test.ts`: a GPU probe that hangs gives up within its own bound
// (the unit file proves it answers false).
describe('probeWebGpuAdapter', () => {
  it('gives up on a driver that never answers within the probe bound', async () => {
    const started = performance.now();
    await probeWebGpuAdapter({ navigator: { gpu: { requestAdapter: () => new Promise(() => undefined) } } });
    should(performance.now() - started).be.within(GPU_PROBE_MS - 100, GPU_PROBE_MS + 1_000);
  });
});
