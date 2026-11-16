import { describe, expect, test } from 'bun:test';
import { err } from '@ferretry/std';
import type { RunnerHandle, RunnerLook } from '../../../../contract/index.ts';
import { started, world, type World } from '../../../support/daemon/deliver-turns-world.ts';

/** ruling #45 (a), the SPEED half: a send to a working ferret is answered in under 1 s. The answer is unit's. */
describe('ruling #45 (a): one look before deliver, so a send to a working ferret is answered busy at once', () => {
  const WORKING: RunnerLook = { frame: 'working', working: true, atPrompt: false, permission: false };
  /** The delivery's own readiness wait, standing in for its ~27 s: it never answers within the test's window. */
  const waitsOutItsReadiness = (w: World): void => {
    w.runner.deliver = async () => await new Promise<never>(() => undefined);
  };
  const within = async <T>(ms: number, work: Promise<T>): Promise<T | 'timed out'> =>
    await Promise.race([work, new Promise<'timed out'>(resolve => setTimeout(() => resolve('timed out'), ms))]);

  test('ruling #45 send to a working ferret answers in under 1 s: busy, nothing typed, the readiness wait never entered', async () => {
    const w = await world();
    const id = await started(w);
    const handle = w.registry.get(id as never)?.handle as RunnerHandle;
    w.runner.screens.set(handle, WORKING);
    waitsOutItsReadiness(w);
    const seam = await w.service.harness(id as never);

    const began = Date.now();
    expect(await within(1_000, seam!.deliver({ text: 'FIXTURE report to a busy lead' }))).toEqual(
      err({ refused: 'not_ready', why: 'busy' }),
    );
    expect(Date.now() - began).toBeLessThan(1_000);
  });

  test('m2 a pane parked on a permission prompt answers not_ready dialog in under 1 s: nothing typed, the readiness wait never entered', async () => {
    const w = await world();
    const id = await started(w);
    const handle = w.registry.get(id as never)?.handle as RunnerHandle;
    w.runner.screens.set(handle, { ...WORKING, permission: true });
    waitsOutItsReadiness(w);
    const seam = await w.service.harness(id as never);

    const began = Date.now();
    expect(await within(1_000, seam!.deliver({ text: 'FIXTURE words to a parked ferret' }))).toEqual(
      err({ refused: 'not_ready', why: 'dialog' }),
    );
    expect(Date.now() - began).toBeLessThan(1_000);
  });
});
