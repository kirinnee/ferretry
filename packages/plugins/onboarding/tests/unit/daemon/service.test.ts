import { describe, expect, test } from 'bun:test';
import type { Clock, OnboardingEntry, PluginId } from '@ferretry/kernel/contract';
import { OnboardingChanged } from '../../../contract/index.ts';
import { OnboardingService, ProgressDamaged } from '../../../daemon/lib/service.ts';
import { damagedFile, FakeProgressState, RecordingEvents, TickingClock } from './fakes.ts';

const entries: readonly OnboardingEntry[] = [
  { plugin: 'logins' as PluginId, id: 'login', title: 'Sign in', order: 30 },
  { plugin: 'claude-code' as PluginId, id: 'harness', title: 'Claude Code', order: 20 },
];

function make(list: readonly OnboardingEntry[] = entries, setUp: () => Promise<boolean> = async () => false) {
  const state = new FakeProgressState();
  const clock = new TickingClock();
  const events = new RecordingEvents();
  const service = new OnboardingService({
    entries: () => list,
    setUp,
    state: state.port,
    clock: clock as unknown as Clock,
    events,
  });
  return { service, state, clock, events };
}

describe('OnboardingService', () => {
  test('a fresh run is every step pending, in order, and not complete', async () => {
    const { service } = make();
    const view = await service.view();
    expect(view.steps.map(step => `${step.plugin}:${step.id}:${step.state}`)).toEqual([
      'claude-code:harness:pending',
      'logins:login:pending',
    ]);
    expect(view.complete).toBe(false);
  });

  test('the view says whether the machine is set up, as the injected read answers', async () => {
    expect((await make(entries, async () => true).service.view()).setUp).toBe(true);
    expect((await make(entries, async () => false).service.view()).setUp).toBe(false);
  });

  test('an answer is stored with the clock time and returned as the step', async () => {
    const { service, state, clock } = make();
    clock.advance(5_000);
    const step = await service.answer('logins', 'login', { state: 'found' });
    expect(step).toMatchObject({
      plugin: 'logins',
      id: 'login',
      title: 'Sign in',
      order: 30,
      state: 'found',
      at: '2026-11-06T09:00:05.000Z',
    });
    expect(state.stored).toEqual({
      format: 1,
      steps: { 'logins:login': { state: 'found', at: '2026-11-06T09:00:05.000Z' } },
    });
  });

  test('answering every step completes the run', async () => {
    const { service } = make();
    await service.answer('claude-code', 'harness', { state: 'found' });
    expect((await service.view()).complete).toBe(false);
    await service.answer('logins', 'login', { state: 'later' });
    expect((await service.view()).complete).toBe(true);
  });

  test('an unknown step is undefined and nothing is written or announced', async () => {
    const { service, state, events } = make();
    expect(await service.answer('logins', 'nope', { state: 'done' })).toBeUndefined();
    expect(await service.answer('nobody', 'login', { state: 'done' })).toBeUndefined();
    expect(state.writes).toBe(0);
    expect(events.published).toEqual([]);
  });

  test('an answer announces the step after its write', async () => {
    const { service, events } = make();
    await service.answer('logins', 'login', { state: 'skipped' });
    expect(events.published).toEqual([{ event: OnboardingChanged.name, payload: { plugin: 'logins', step: 'login' } }]);
  });

  test('the steps are read from the snapshot on every call, so a plugin turned on later appears', async () => {
    let list: readonly OnboardingEntry[] = [entries[0] as OnboardingEntry];
    const state = new FakeProgressState();
    const service = new OnboardingService({
      entries: () => list,
      setUp: async () => false,
      state: state.port,
      clock: new TickingClock() as unknown as Clock,
      events: new RecordingEvents(),
    });
    expect((await service.view()).steps).toHaveLength(1);
    list = entries;
    expect((await service.view()).steps).toHaveLength(2);
  });

  test('reset clears every answer and announces each step that had one', async () => {
    const { service, state, events } = make();
    await service.answer('claude-code', 'harness', { state: 'found' });
    await service.answer('logins', 'login', { state: 'done' });
    events.published.length = 0;
    await service.reset();
    expect(state.stored).toEqual({ format: 1, steps: {} });
    expect((await service.view()).steps.every(step => step.state === 'pending')).toBe(true);
    expect(events.published.map(each => each.payload)).toEqual([
      { plugin: 'claude-code', step: 'harness' },
      { plugin: 'logins', step: 'login' },
    ]);
  });

  test('reset on a run nobody answered announces nothing', async () => {
    const { service, events } = make();
    await service.reset();
    expect(events.published).toEqual([]);
  });

  test('a damaged progress file is refused with the store sentence, never read as an empty run', async () => {
    const { service, state } = make();
    state.damage = damagedFile();
    await expect(service.view()).rejects.toBeInstanceOf(ProgressDamaged);
    await expect(service.answer('logins', 'login', { state: 'done' })).rejects.toThrow('cannot be read');
    await expect(service.reset()).rejects.toBeInstanceOf(ProgressDamaged);
    expect(state.writes).toBe(0);
  });
});
