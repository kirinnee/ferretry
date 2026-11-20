import { describe, expect, test } from 'bun:test';
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
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

/** The pre-O1 reader (onboarding/contract/wire.ts at base 287d0c4261), copied: a stale tab still runs this until it reloads. */
const OldStepViewSchema = z.strictObject({
  plugin: z.string(),
  id: z.string(),
  title: z.string().min(1),
  order: z.number().int(),
  state: z.enum(['pending', 'found', 'later', 'done', 'skipped']),
  at: InstantSchema.optional(),
  linked: z.literal(true).optional(),
});
const OldOnboardingViewSchema = z.strictObject({
  steps: z.array(OldStepViewSchema),
  complete: z.boolean(),
  setUp: z.boolean(),
});

describe('an old reader of legacy steps', () => {
  const legacy = [entry('login', 30), entry('harness', 20)];
  const service = () =>
    new OnboardingService({
      entries: () => legacy,
      setUp: async () => false,
      state: new FakeProgressState().port,
      clock: new TickingClock() as unknown as Clock,
      events: new RecordingEvents(),
    });

  test("parses the new writer's GET output", async () => {
    const view = JSON.parse(JSON.stringify(await service().view()));
    expect(OldOnboardingViewSchema.safeParse(view).success).toBe(true);
  });

  test("parses the new writer's POST output", async () => {
    const answered = await service().answer('layouts', 'harness', { state: 'done' });
    expect(OldStepViewSchema.safeParse(JSON.parse(JSON.stringify(answered))).success).toBe(true);
  });
});

describe('step side on the wire', () => {
  test('a declared client side and group pass through to the view; the daemon default stays off the wire', () => {
    const steps = joinProgress([entry('layout', 2, { side: 'client', group: 'Layout' }), entry('old', 1)], undefined);
    expect(steps.map(step => [step.id, step.side, step.group])).toEqual([
      ['old', undefined, undefined],
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

describe('a step that declares it is written against StepHost', () => {
  test('says so on the wire; a step that declares nothing carries nothing', () => {
    const steps = joinProgress([entry('a', 1, { stepHost: true }), entry('b', 2)], undefined);
    expect(steps.map(step => step.stepHost)).toEqual([true, undefined]);
    expect(StepViewSchema.safeParse(steps[0]).success).toBe(true);
    expect(Object.keys(steps[1] ?? {})).not.toContain('stepHost');
  });
});
