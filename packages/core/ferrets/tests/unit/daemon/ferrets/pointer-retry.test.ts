import { describe, expect, test } from 'bun:test';
import { PERSON_ORIGIN, type RunnerDeliveryFailure, type RunnerHandle } from '../../../../contract/index.ts';
import { FakeRunnerFailure } from '../../../../contract/testing/index.ts';
import { POINTER_ATTEMPTS } from '../../../../daemon/lib/ferrets/pointer-retry.ts';
import { started, world, type World } from '../../../support/daemon/deliver-turns-world.ts';

/**
 * GAP(deliver) pointer-miss recovery (lead ruling L12): a relaunch whose pointer does not reach the pane re-probes the
 * pane and types it again, a bounded number of times, as today's revive did. Fixture values only.
 */

const revive = async (w: World, id: string) => await w.service.resume(id as never, 'Again.', { origin: PERSON_ORIGIN });

/** Makes the pane refuse `refusals` deliveries with `failure`, then take the rest; answers every attempt it saw. */
function refuse(w: World, failure: RunnerDeliveryFailure | Error, refusals: number): { attempts: number } {
  const seen = { attempts: 0 };
  const deliver = w.runner.deliver.bind(w.runner);
  w.runner.deliver = async (handle: RunnerHandle, delivery) => {
    seen.attempts += 1;
    if (seen.attempts <= refusals) throw failure instanceof Error ? failure : new FakeRunnerFailure(failure);
    return await deliver(handle, delivery);
  };
  return seen;
}

const notReady: RunnerDeliveryFailure = { kind: 'not_ready', why: 'busy' };

describe('GAP(deliver) a relaunch whose pointer does not reach the pane types it again', () => {
  for (const [name, failure] of [
    ['a pane still at work', notReady],
    ['a pane behind a dialog', { kind: 'not_ready', why: 'dialog' }],
    ['a composer holding a draft', { kind: 'composer_occupied', draft: 'FIXTURE_DRAFT' }],
    ['a composer that cannot be read', { kind: 'composer_unreadable' }],
  ] as const) {
    test(`${name} is probed again and the pointer lands on the next attempt; the turn is counted once`, async () => {
      const w = await world();
      const id = await started(w, 'Build the thing.');
      await w.service.stop(id as never, 'now');
      const seen = refuse(w, failure, 1);

      const resumed = await revive(w, id);

      expect(resumed.ok).toBe(true);
      expect(seen.attempts).toBe(2);
      expect(w.registry.get(id as never)?.state).toBe('working');
      // The pointer is typed into the pane once it takes it: the refused attempt typed nothing.
      const typed = w.runner.deliveries.map(entry => entry.delivery.text);
      expect(typed.filter(text => text.includes('turn-002'))).toHaveLength(1);
    });
  }

  test('a pane that never takes it is tried a bounded number of times, then left as before: running, turn counted, said', async () => {
    const w = await world();
    const id = await started(w, 'Build the thing.');
    await w.service.stop(id as never, 'now');
    const seen = refuse(w, notReady, 99);

    const resumed = await revive(w, id);

    expect(resumed.ok).toBe(false);
    expect(seen.attempts).toBe(POINTER_ATTEMPTS);
    if (!resumed.ok) expect(resumed.error.reason).toContain('stop and resume it');
    expect(w.registry.get(id as never)?.state).toBe('working');
  });

  for (const [name, failure] of [
    ['an exited pane', { kind: 'not_ready', why: 'exited' }],
    ['a hold', { kind: 'held', code: 'forbidden' }],
    ['a delivery that may have landed', { kind: 'unconfirmed', stranded: false }],
    ['a stranded delivery', { kind: 'unconfirmed', stranded: true }],
  ] as const) {
    test(`${name} is never typed again`, async () => {
      const w = await world();
      const id = await started(w, 'Build the thing.');
      await w.service.stop(id as never, 'now');
      const seen = refuse(w, failure as RunnerDeliveryFailure, 99);

      expect((await revive(w, id)).ok).toBe(false);
      expect(seen.attempts).toBe(1);
    });
  }

  test('a rejection that says nothing about the keys is never typed again, and its text is never quoted', async () => {
    const w = await world();
    const id = await started(w, 'Build the thing.');
    await w.service.stop(id as never, 'now');
    const seen = refuse(w, new Error('FIXTURE_SECRET pane refused'), 99);

    const resumed = await revive(w, id);

    expect(resumed.ok).toBe(false);
    expect(seen.attempts).toBe(1);
    if (!resumed.ok) expect(resumed.error.reason).not.toContain('FIXTURE_SECRET');
  });

  test('a pane that is gone at the re-probe ends the attempts', async () => {
    const w = await world();
    const id = await started(w, 'Build the thing.');
    await w.service.stop(id as never, 'now');
    const seen = refuse(w, notReady, 99);
    w.runner.alive = async () => false;

    expect((await revive(w, id)).ok).toBe(false);
    expect(seen.attempts).toBe(1);
  });
});
