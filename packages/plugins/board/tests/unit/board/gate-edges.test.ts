import { describe, it } from 'bun:test';
import should from 'should';
import type { Card } from '../../../contract/index.ts';
import {
  BoardIndex,
  cardAskDraft,
  gateEntry,
  gateOf,
  lineageThrough,
  MAX_LINEAGE_DEPTH,
  stageGateLanes,
  stillBuilding,
} from '../../../daemon/lib/board/index.ts';
import { card, lanes, liveSession, NOW, PROJECT, rosterOf } from './support.ts';

const set = lanes(PROJECT);
const laneSets = new Map([[PROJECT, set]]);
const ferret = { kind: 'ferret', name: 'child', ferret: 'child' } as const;

describe('where a gate sends a card that cannot be sent', () => {
  const outcome = (laneId: string, optionId: string, laneSet = set) =>
    stageGateLanes.outcomeLane(laneSet, 'quick', laneId, optionId);

  it('should say a lane that is not a gate waits on nobody', () => {
    should(outcome('implement', 'ok')).match({ ok: false, message: /does not wait on the owner any more/u });
  });

  it('should say a gate has no such option any more', () => {
    should(outcome('tested', 'nope')).match({ ok: false, message: /has no option nope any more/u });
  });

  it('should say a gate with nothing after it has no lane to go to', () => {
    const cut = {
      ...set,
      variants: {},
      lanes: set.lanes.slice(0, set.lanes.findIndex(lane => lane.id === 'plan') + 1),
    };
    should(stageGateLanes.outcomeLane(cut, 'design-first', 'plan', 'ok')).match({
      ok: false,
      message: /has no lane after it/u,
    });
  });

  it('should say a lane that is not on the board any more is gone', () => {
    should(outcome('missing-lane', 'ok')).match({ ok: false, message: 'that lane is not on this board any more' });
  });
});

describe('the history entry that put a card in its lane', () => {
  const event = { seq: 3, at: NOW, actor: ferret } as const;

  it('should read a refile into the lane as the entry', () => {
    const refiled = {
      ...event,
      type: 'refiled',
      fromProject: PROJECT,
      toProject: PROJECT,
      toLane: 'tested',
      reason: null,
    };
    should(gateEntry({ laneId: 'tested', history: [refiled as never] })).equal(3);
  });

  it('should know nothing when no event landed the card anywhere', () => {
    const noted = { ...event, type: 'ordered', from: null, to: 1 };
    should(gateEntry({ laneId: 'tested', history: [noted as never] })).be.undefined();
    should(gateEntry({ laneId: 'tested', history: [] })).be.undefined();
  });
});

describe('an ask whose steps are too long to show', () => {
  const long = `1. step one\n${'x'.repeat(70_000)}`;
  const gateFor = (laneId: string) => {
    const task = card({
      laneId,
      ask: { text: 'ask', source: 'owner' },
      createdBy: ferret,
      owner: 'child',
      assignee: 'grandchild',
      howToTest: long,
      history: [{ seq: 1, at: NOW, actor: ferret, type: 'created', laneId }],
    });
    const gate = gateOf({ task, laneSet: set, audience: 'external' }, stageGateLanes);
    if (gate === undefined) throw new Error(`expected a gate at ${laneId}`);
    return { task, gate };
  };

  it('should point an approval at the card instead of cutting its plan', () => {
    const { task, gate } = gateFor('plan');
    should(String(cardAskDraft(gate, task, 'grandchild').context)).match(/characters, too long to show here/u);
  });

  it('should point a try-it at the card instead of cutting its steps', () => {
    const { task, gate } = gateFor('tested');
    should(String(cardAskDraft(gate, task, 'grandchild').context)).match(/characters, too long to show here/u);
  });
});

describe('sub-cards still being built', () => {
  it('should count the live sub-cards in a backlog, active or review lane, and skip dropped and shipped ones', () => {
    const parent = card({ id: 'F1', laneId: 'implement' });
    const child = (id: string, laneId: string, extra: Partial<Card> = {}) =>
      card({ id, laneId, parent: { id: 'F1' } as never, ...extra });
    const cards = [
      parent,
      child('F2', 'todo'),
      child('F3', 'implement'),
      child('F4', 'review'),
      child('F5', 'closed'),
      child('F6', 'implement', { dropped: { at: NOW, by: ferret, reason: 'no' } as never }),
    ];
    should(stillBuilding(parent, new BoardIndex(cards, ''), laneSets)).equal(3);
  });
});

describe('the lineage a return rests on', () => {
  it('should give up on a lineage deeper than it will walk', () => {
    const chain = Array.from({ length: MAX_LINEAGE_DEPTH + 10 }, (_, index) =>
      liveSession(`s${String(index)}`, { lead: `s${String(index + 1)}` }),
    );
    should(lineageThrough(rosterOf(chain), 's0', 'nobody')).be.null();
  });
});
