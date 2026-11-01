import { describe, it } from 'bun:test';
import type { Lane, LaneSet } from '@ferretry/protocol';
import should from 'should';
import {
  decideLaneChange,
  describeLaneSetFailure,
  editLaneSet,
  type LaneActor,
  laneGateProblems,
} from '../../../src/lib/board-projects/index.ts';
import { lanes, PROJECT } from '../board/support.ts';

/**
 * A GATE IS THE OWNER'S, ON THE LANES TOO (docs/board.md § Gates ask the owner): what a lane change would do to a gate
 * — remove, disarm, move or skip it, or send cards into a closed lane or past it. A ferret's change of lanes that exist
 * waits for the owner, who is told exactly this. The classic lanes: Todo, Plan/Design*, Implement, Review/CI, Merged,
 * Released, To test*, Closed (* a gate).
 */

const FERRET: LaneActor = { kind: 'ferret', name: 'Ada', sessionId: 'lead' };
const OWNER: LaneActor = { kind: 'owner' };

const current = (): LaneSet => lanes(PROJECT);
const layout = (set: LaneSet) => ({ lanes: [...set.lanes], variants: { ...set.variants } });
const withLanes = (set: LaneSet, map: (lane: Lane) => Lane | undefined): ReturnType<typeof layout> => {
  const kept = set.lanes.flatMap(lane => {
    const next = map(lane);
    return next === undefined ? [] : [next];
  });
  const ids = new Set(kept.map(lane => lane.id));
  return {
    lanes: kept,
    variants: Object.fromEntries(
      Object.entries(set.variants).map(([workflow, walked]) => [workflow, (walked ?? []).filter(id => ids.has(id))]),
    ),
  };
};

const whys = (problems: readonly { readonly why: string }[]): string[] => problems.map(problem => problem.why);

describe('laneGateProblems', () => {
  it('finds nothing in an edit that leaves every gate as it is', () => {
    const renamed = withLanes(current(), lane => (lane.id === 'implement' ? { ...lane, name: 'Build' } : lane));
    should(laneGateProblems(current(), renamed)).be.empty();
  });

  it('finds a gate lane removed', () => {
    const without = withLanes(current(), lane => (lane.id === 'plan' ? undefined : lane));
    should(whys(laneGateProblems(current(), without))).eql(['removes Plan/Design, which waits for the owner']);
  });

  it('finds a gate made automatic', () => {
    const automatic = withLanes(current(), lane =>
      lane.id === 'plan' ? { ...lane, ownerGate: false, stage: { kind: 'auto', triggers: ['work.started'] } } : lane,
    );
    should(whys(laneGateProblems(current(), automatic))).containEql(
      'makes Plan/Design automatic: it would stop waiting for the owner',
    );
  });

  it('finds a verify gate’s owner gate dropped', () => {
    const unguarded = withLanes(current(), lane => {
      if (lane.id !== 'tested') return lane;
      const { ownerGate: _ownerGate, ...rest } = lane;
      return rest;
    });
    should(whys(laneGateProblems(current(), unguarded))).eql(['drops the owner gate of To test']);
  });

  it('finds a gate moved among the lanes a variant walks', () => {
    const set = current();
    const plan = set.lanes.find(lane => lane.id === 'plan') as Lane;
    const moved = {
      ...layout(set),
      lanes: [...set.lanes.filter(lane => lane.id !== 'plan')].flatMap(lane =>
        lane.id === 'review' ? [lane, plan] : [lane],
      ),
    };
    should(whys(laneGateProblems(set, moved))).containEql('moves Plan/Design among the lanes design-first work walks');
  });

  it('finds a variant that stops walking a gate', () => {
    const set = current();
    const skipping = {
      ...layout(set),
      variants: { ...set.variants, 'design-first': (set.variants['design-first'] ?? []).filter(id => id !== 'plan') },
    };
    should(whys(laneGateProblems(set, skipping))).eql(['lets design-first work skip Plan/Design']);
  });

  it('finds cards sent into a closed lane, or past a gate', () => {
    const without = withLanes(current(), lane => (lane.id === 'implement' || lane.id === 'review' ? undefined : lane));
    should(whys(laneGateProblems(current(), without, { implement: 'closed', review: 'merged' }))).eql([
      'sends the cards of implement into Closed, which only the owner closes',
    ]);
    const pastPlan = withLanes(current(), lane => (lane.id === 'todo' ? undefined : lane));
    should(whys(laneGateProblems(current(), pastPlan, { todo: 'implement' }))).eql([
      'sends the cards of todo past Plan/Design, which waits for the owner',
    ]);
  });
});

describe('a lane change that takes a gate from the owner', () => {
  const removePlan = () => ({
    version: 1,
    layout: withLanes(current(), lane => (lane.id === 'plan' ? undefined : lane)),
    relocate: { plan: 'implement' },
  });

  it('waits for the owner when a ferret makes it, and the live set keeps its gate', () => {
    const waiting = decideLaneChange(PROJECT, current(), { action: 'edit', ...removePlan() }, FERRET);
    should(waiting).match({ ok: true, value: { change: 'pending', relocate: {} } });
    should(waiting.ok && waiting.value.next.lanes.some(lane => lane.id === 'plan')).be.true();
  });

  it('is the owner’s to make', () => {
    should(editLaneSet(current(), removePlan(), OWNER)).match({ ok: true });
  });

  it('waits in a ferret’s proposal over a set it would disarm, and a first proposal is free', () => {
    const live: LaneSet = { ...current(), confirmedBy: null };
    const propose = { action: 'propose', template: 'pr-release-verify', renames: {} } as const;
    should(decideLaneChange(PROJECT, live, propose, FERRET)).match({ ok: false, error: { code: 'relocation-missing' } });
    should(decideLaneChange(PROJECT, null, propose, FERRET)).match({ ok: true, value: { change: 'live' } });
  });
});

describe('the refusal in words', () => {
  it('says which gates the change would take from the owner', () => {
    should(
      describeLaneSetFailure({
        code: 'owner-gate',
        problems: [{ laneId: 'plan', why: 'removes Plan/Design, which waits for the owner' }],
      }),
    ).equal('only the owner may change these gates: this change removes Plan/Design, which waits for the owner');
  });
});

describe('a relocation judged where the cards end up (kyan R3)', () => {
  it('refuses moving Review/CI’s cards into a new lane past To test', () => {
    // Arrange — the review's proof: remove Review/CI, add a lane after To test, relocate review → after
    const set = current();
    const after: Lane = { id: 'after', name: 'After', category: 'verify' };
    const next = {
      lanes: set.lanes
        .filter(lane => lane.id !== 'review')
        .flatMap(lane => (lane.id === 'tested' ? [lane, after] : [lane])),
      variants: Object.fromEntries(
        Object.entries(set.variants).map(([workflow, walked]) => [
          workflow,
          (walked ?? []).filter(id => id !== 'review').flatMap(id => (id === 'tested' ? [id, 'after'] : [id])),
        ]),
      ),
    };

    // Act
    const problems = laneGateProblems(set, next, { review: 'after' });

    // Assert
    should(problems.map(problem => problem.laneId)).containEql('after');
    should(decideLaneChange(PROJECT, set, { action: 'edit', version: 1, layout: next, relocate: { review: 'after' } }, FERRET)).match({
      ok: true,
      value: { change: 'pending', relocate: {} },
    });
  });

  it('refuses moving cards before Plan into a new lane after it on a pr board', () => {
    // Arrange — Todo removed, its cards sent into a new lane placed after Plan/Design
    const set = lanes(PROJECT, 'pr');
    const later: Lane = { id: 'later', name: 'Later', category: 'active' };
    const next = {
      lanes: set.lanes
        .filter(lane => lane.id !== 'todo')
        .flatMap(lane => (lane.id === 'plan' ? [lane, later] : [lane])),
      variants: Object.fromEntries(
        Object.entries(set.variants).map(([workflow, walked]) => [
          workflow,
          (walked ?? []).filter(id => id !== 'todo').flatMap(id => (id === 'plan' ? [id, 'later'] : [id])),
        ]),
      ),
    };

    // Act
    const problems = laneGateProblems(set, next, { todo: 'later' });

    // Assert
    should(problems.length).be.above(0);
  });

  it('refuses a relocation that puts cards past a gate the new layout moved ahead of them', () => {
    // Arrange — Implement removed and its cards sent to Merged, which To test does not stand before; but Review/CI,
    // made a gate, does
    const set = {
      ...current(),
      lanes: current().lanes.map(lane => (lane.id === 'review' ? { ...lane, ownerGate: true } : lane)),
    };
    const next = withLanes(set, lane => (lane.id === 'implement' ? undefined : lane));

    // Act
    const problems = laneGateProblems(set, next, { implement: 'merged' });

    // Assert
    should(whys(problems)).eql(['sends the cards of implement past Review/CI, which waits for the owner']);
  });
});
