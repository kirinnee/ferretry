import { describe, expect, test } from 'bun:test';
import type { Clock, OnboardingEntry, PluginId } from '@ferretry/kernel/contract';
import { OnboardingViewSchema, StepViewSchema, sideOf } from '../../../contract/index.ts';
import { OnboardingService } from '../../../daemon/lib/service.ts';
import { isComplete, joinProgress, viewOf } from '../../../daemon/lib/steps.ts';
import { FakeProgressState, RecordingEvents, TickingClock } from './fakes.ts';

const entry = (id: string, order: number, extra: Partial<OnboardingEntry> = {}): OnboardingEntry => ({
  plugin: 'layouts' as PluginId,
  id,
  title: id,
  order,
  ...extra,
});

describe('step side on the wire', () => {
  test('a declared side and group pass through to the view; no side reads as daemon', () => {
    const steps = joinProgress([entry('layout', 2, { side: 'client', group: 'Layout' }), entry('old', 1)], undefined);
    expect(steps.map(step => [step.id, step.side, step.group])).toEqual([
      ['old', 'daemon', undefined],
      ['layout', 'client', 'Layout'],
    ]);
  });

  test('the schema round-trips side and group, and an old view without them still parses as daemon', () => {
    const view = viewOf([entry('layout', 2, { side: 'client', group: 'Layout' })], undefined, false);
    expect(OnboardingViewSchema.parse(JSON.parse(JSON.stringify(view)))).toEqual(view);
    const old = StepViewSchema.parse({ plugin: 'shells', id: 'nix', title: 'nix', order: 80, state: 'pending' });
    expect(old.side).toBeUndefined();
    expect(sideOf(old)).toBe('daemon');
    expect(StepViewSchema.safeParse({ ...old, side: 'cloud' }).success).toBe(false);
  });

  test('a pending client step never holds the run open', () => {
    const steps = joinProgress([entry('layout', 2, { side: 'client' }), entry('a', 1)], undefined);
    expect(isComplete(steps)).toBe(false);
    const answered = joinProgress([entry('layout', 2, { side: 'client' })], undefined);
    expect(isComplete(answered)).toBe(true);
  });
});

describe('the daemon records only daemon steps', () => {
  const make = () => {
    const state = new FakeProgressState();
    return new OnboardingService({
      entries: () => [entry('layout', 2, { side: 'client' }), entry('a', 1)],
      setUp: async () => false,
      state: state.port,
      clock: new TickingClock() as unknown as Clock,
      events: new RecordingEvents(),
    });
  };

  test('answering a client step is unknown to the daemon and writes nothing', async () => {
    const service = make();
    expect(await service.answer('layouts', 'layout', { state: 'done' })).toBeUndefined();
    const view = await service.view();
    expect(view.steps.find(step => step.id === 'layout')?.state).toBe('pending');
  });

  test('a daemon step is answered as before', async () => {
    const service = make();
    expect((await service.answer('layouts', 'a', { state: 'done' }))?.state).toBe('done');
    expect((await service.view()).complete).toBe(true);
  });
});
