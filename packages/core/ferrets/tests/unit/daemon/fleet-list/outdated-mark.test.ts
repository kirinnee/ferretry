import { describe, expect, test } from 'bun:test';
import { type FerretId, type FerretSummary, FerretSummarySchema } from '../../../../contract/index.ts';
import { outdatedMark } from '../../../../daemon/lib/fleet-list/outdated-mark.ts';
import {
  type LaunchInstructionSectionId,
  SessionOutdatedSchema,
  type SessionView,
} from '../../../../daemon/lib/protocol/session.ts';
import { withOutdated } from '../../../../daemon/lib/session/restart/outdated-view.ts';
import { sessionView } from '../../../support/daemon/session-view.ts';

/**
 * R-0128 the outdated mark on the ferret SUMMARY (u6-fix1, ruling #46 (2)): today's `withOutdated` over the 5.0 list,
 * with today's shape, its 5 s window, its "a failure is not outdated" and its identity-preserving memo.
 */

const T0 = '2026-11-08T12:00:00.000Z' as FerretSummary['createdAt'];
const summary = (id: string, state: FerretSummary['state'] = 'working'): FerretSummary =>
  FerretSummarySchema.parse({
    id,
    name: id,
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    folder: `/work/${id}`,
    state,
    createdAt: T0,
    stateAt: T0,
  });

function setup(stale: Record<string, LaunchInstructionSectionId[]>, broken = new Set<string>()) {
  const asked: string[] = [];
  const clock = { now: 0 };
  const mark = outdatedMark({
    outdated: async (ferret: FerretId) => {
      asked.push(ferret);
      if (broken.has(ferret)) throw new Error('unreadable');
      return stale[ferret] ?? [];
    },
    nowMs: () => clock.now,
    ttlMs: 5_000,
  });
  return { mark, asked, clock };
}

describe('R-0128 the outdated mark on the ferret summary', () => {
  test('R-0128 a running outdated ferret carries { sections }, a current one and a stopped one carry none', async () => {
    const { mark, asked } = setup({ aa: ['board', 'notify'], cc: ['board'] });
    const list = [summary('aa'), summary('bb', 'idle'), summary('cc', 'stopped')];
    const marked = await mark.list(list);
    expect(marked.map(each => each.outdated)).toEqual([{ sections: ['board', 'notify'] }, undefined, undefined]);
    // A stopped ferret is not even asked about.
    expect(asked).toEqual(['aa', 'bb']);
    // An unmarked summary is the very same object; the marked one parses as the contract's summary.
    expect(marked[1]).toBe(list[1]);
    expect(marked[2]).toBe(list[2]);
    expect(FerretSummarySchema.parse(marked[0]).outdated).toEqual({ sections: ['board', 'notify'] });
  });

  test("R-0128 parity: the mark is today's SessionView.outdated, field for field", async () => {
    const sections: LaunchInstructionSectionId[] = ['tools', 'board', 'asks'];
    const today = withOutdated(
      { list: async () => [sessionView('aa', {}, { status: 'running' })], get: async () => undefined },
      { outdated: async () => sections, now: () => 0, ttlMs: 5_000 },
    );
    const [todayView] = (await today.list()) as SessionView[];
    const [ours] = await setup({ aa: sections }).mark.list([summary('aa')]);
    expect(ours?.outdated).toEqual(todayView?.outdated);
    // Today's schema is strict: the mark carries nothing but `sections`.
    expect(SessionOutdatedSchema.parse(ours?.outdated)).toEqual({ sections });
    expect(Object.keys(ours?.outdated ?? {})).toEqual(['sections']);
  });

  test('R-0128 an answer that fails is "not outdated": the list still loads and nothing is marked on a guess', async () => {
    const { mark } = setup({ aa: ['board'] }, new Set(['aa']));
    const list = [summary('aa')];
    const marked = await mark.list(list);
    expect(marked[0]).toBe(list[0]);
    expect(marked[0]?.outdated).toBeUndefined();
  });

  test('R-0128 each answer is kept for 5 s and asked again after it', async () => {
    const stale: Record<string, LaunchInstructionSectionId[]> = { aa: ['board'] };
    const { mark, asked, clock } = setup(stale);
    const list = [summary('aa')];
    await mark.list(list);
    stale.aa = [];
    clock.now = 4_999;
    expect((await mark.list(list))[0]?.outdated).toEqual({ sections: ['board'] });
    clock.now = 5_000;
    expect((await mark.list(list))[0]?.outdated).toBeUndefined();
    expect(asked).toEqual(['aa', 'aa']);
  });

  test('R-0128 the same summary with the same sections answers the same marked object (the list route keys on it)', async () => {
    const stale: Record<string, LaunchInstructionSectionId[]> = { aa: ['board'] };
    const { mark, clock } = setup(stale);
    const list = [summary('aa')];
    const first = (await mark.list(list))[0];
    clock.now = 10_000;
    expect((await mark.list(list))[0]).toBe(first);
    stale.aa = ['board', 'notify'];
    clock.now = 20_000;
    const changed = (await mark.list(list))[0];
    expect(changed).not.toBe(first);
    expect(changed?.outdated).toEqual({ sections: ['board', 'notify'] });
  });

  test('R-0128 one() marks a single view by the same rule', async () => {
    const { mark } = setup({ aa: ['board'] });
    expect((await mark.one(summary('aa'))).outdated).toEqual({ sections: ['board'] });
    expect((await mark.one(summary('aa', 'stopped'))).outdated).toBeUndefined();
  });
});
