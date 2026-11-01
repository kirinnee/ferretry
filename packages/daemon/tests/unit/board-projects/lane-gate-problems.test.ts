import { describe, it } from 'bun:test';
import type { Lane, LaneSet } from '@ferretry/protocol';
import should from 'should';
import {
  describeLaneSetFailure,
  editLaneSet,
  type LaneActor,
  laneGateProblems,
  proposeLaneSet as propose,
} from '../../../src/lib/board-projects/index.ts';
import { lanes, PROJECT } from '../board/support.ts';

/**
 * A GATE IS THE OWNER'S, ON THE LANES TOO (docs/board.md § Gates ask the owner): until a ferret's lane edit is only a
 * proposal, it may not remove, disarm, move or skip a gate, nor send cards into a closed lane or past a gate. The
 * classic lanes: Todo, Plan/Design*, Implement, Review/CI, Merged, Released, To test*, Closed (* a gate).
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

  it('is refused for a ferret, naming the gate', () => {
    const refused = editLaneSet(current(), removePlan(), FERRET);
    should(refused).match({ ok: false, error: { code: 'owner-gate' } });
    const problems = !refused.ok && refused.error.code === 'owner-gate' ? refused.error.problems : [];
    should(problems.map(problem => problem.laneId)).containEql('plan');
  });

  it('is the owner’s to make', () => {
    should(editLaneSet(current(), removePlan(), OWNER)).match({ ok: true });
  });

  it('is refused in a ferret’s proposal over a set it would disarm, and a first proposal is free', () => {
    const live: LaneSet = { ...current(), confirmedBy: null };
    should(propose(PROJECT, live, 'quick', {}, 'Ada', true)).match({ ok: false, error: { code: 'owner-gate' } });
    should(propose(PROJECT, null, 'quick', {}, 'Ada', true)).match({ ok: true });
    should(propose(PROJECT, live, 'quick', {}, 'owner', false)).match({ ok: true });
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
