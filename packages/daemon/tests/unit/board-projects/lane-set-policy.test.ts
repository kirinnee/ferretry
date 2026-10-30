import { describe, it } from 'bun:test';
import {
  LANE_TEMPLATES,
  type LaneLayoutValue,
  type LaneSet,
  LaneSetSchema,
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';
import should from 'should';
import {
  actorName,
  confirmLaneSet,
  describeLaneSetFailure,
  editLaneSet,
  type LaneActor,
  mergeReleaseLanes,
  noLaneSetMessage,
  proposeLaneSet,
  RELEASED_TO_TEST_NAME,
  unfiledLaneSet,
} from '../../../src/lib/board-projects/index.ts';
import { lanes, templateLanes } from '../board/support.ts';
import { FERRETRY_ID } from './support.ts';

const OWNER: LaneActor = { kind: 'owner' };
const FERRET: LaneActor = { kind: 'ferret', name: 'koen', sessionId: 'ms8-abcd1234' };

const proposed = (overrides: Partial<LaneSet> = {}): LaneSet => ({
  projectId: FERRETRY_ID,
  version: 1,
  confirmedBy: null,
  proposedBy: 'koen',
  ...LANE_TEMPLATES.quick,
  ...overrides,
});

const withoutDoing = (): LaneLayoutValue => ({
  lanes: LANE_TEMPLATES.quick.lanes.filter(lane => lane.id !== 'doing'),
  variants: Object.fromEntries(
    Object.entries(LANE_TEMPLATES.quick.variants).map(([workflow, ids]) => [
      workflow,
      (ids ?? []).filter(id => id !== 'doing'),
    ]),
  ),
});

describe('actorName and unfiledLaneSet', () => {
  it('should name the owner and a ferret', () => {
    should(actorName(OWNER)).equal('owner');
    should(actorName(FERRET)).equal('koen');
  });

  it('should give the Unfiled board the confirmed quick lanes', () => {
    should(unfiledLaneSet()).deepEqual({
      projectId: UNFILED_PROJECT_ID,
      version: 1,
      confirmedBy: 'owner',
      proposedBy: 'ferretry',
      ...LANE_TEMPLATES.quick,
    });
  });
});

describe('proposeLaneSet', () => {
  it('should store an unconfirmed first version from a template with renames applied', () => {
    const actual = proposeLaneSet(FERRETRY_ID, null, 'quick', { doing: 'Busy' }, 'koen');

    should(actual.ok).be.true();
    if (!actual.ok) return;
    should(actual.value).containDeep({ projectId: FERRETRY_ID, version: 1, confirmedBy: null, proposedBy: 'koen' });
    should(actual.value.lanes.map(lane => lane.name)).deepEqual(['Todo', 'Busy', 'Closed']);
  });

  it('should raise the version when it replaces an unconfirmed proposal', () => {
    const actual = proposeLaneSet(FERRETRY_ID, proposed({ version: 3 }), 'pr', {}, 'koen');

    should(actual.ok && actual.value.version).equal(4);
  });

  it('should refuse once the owner has confirmed a set', () => {
    should(proposeLaneSet(FERRETRY_ID, proposed({ confirmedBy: 'owner', version: 2 }), 'pr', {}, 'koen')).deepEqual({
      ok: false,
      error: { code: 'already-confirmed', version: 2 },
    });
  });

  it('should refuse a rename of a lane the template does not have', () => {
    should(proposeLaneSet(FERRETRY_ID, null, 'quick', { nope: 'X' }, 'koen')).deepEqual({
      ok: false,
      error: { code: 'unknown-lane', laneId: 'nope' },
    });
  });
});

describe('editLaneSet', () => {
  const edit = (overrides: Partial<Parameters<typeof editLaneSet>[1]> = {}) => ({
    version: 1,
    layout: LANE_TEMPLATES.quick,
    relocate: {},
    ...overrides,
  });

  it('should refuse an edit of a project with no lanes', () => {
    should(editLaneSet(null, edit(), OWNER)).deepEqual({ ok: false, error: { code: 'no-lane-set' } });
  });

  it('should refuse an edit against another version', () => {
    should(editLaneSet(proposed({ version: 2 }), edit(), OWNER)).deepEqual({
      ok: false,
      error: { code: 'version-conflict', current: 2 },
    });
  });

  it('should refuse a removed lane that names no destination', () => {
    should(editLaneSet(proposed(), edit({ layout: withoutDoing() }), OWNER)).deepEqual({
      ok: false,
      error: { code: 'relocation-missing', laneIds: ['doing'] },
    });
  });

  it('should confirm the set when the owner edits it and keep the original proposer', () => {
    const actual = editLaneSet(proposed(), edit({ layout: withoutDoing(), relocate: { doing: 'todo' } }), OWNER);

    should(actual.ok && actual.value).containDeep({ version: 2, confirmedBy: 'owner', proposedBy: 'koen' });
  });

  it('should leave a ferret edit unconfirmed and credit the ferret', () => {
    const actual = editLaneSet(proposed({ proposedBy: 'someone' }), edit(), FERRET);

    should(actual.ok && actual.value).containDeep({ version: 2, confirmedBy: null, proposedBy: 'koen' });
  });

  it('should keep the set’s Done and Not good lanes while they fit, unless the edit names its own', () => {
    // Arrange
    const { doneLane: _done, notGoodLane: _notGood, ...bare } = LANE_TEMPLATES.ops;
    const ops = proposed({ ...LANE_TEMPLATES.ops, notGoodLane: 'investigate' });

    // Act
    const kept = editLaneSet(ops, edit({ layout: bare }), OWNER);
    const named = editLaneSet(ops, edit({ layout: { ...bare, notGoodLane: 'fix' } }), OWNER);
    const gone = editLaneSet(
      ops,
      edit({
        layout: { ...bare, lanes: bare.lanes.filter(lane => lane.id !== 'investigate'), variants: {} },
        relocate: { investigate: 'fix' },
      }),
      OWNER,
    );

    // Assert
    should(kept.ok && kept.value).containDeep({ doneLane: 'closed', notGoodLane: 'investigate' });
    should(named.ok && named.value).containDeep({ doneLane: 'closed', notGoodLane: 'fix' });
    should(gone.ok && gone.value).containDeep({ doneLane: 'closed', notGoodLane: 'fix' });
  });
});

describe('confirmLaneSet', () => {
  it('should confirm the stored version and keep the lanes and version', () => {
    const actual = confirmLaneSet(proposed({ version: 4 }), 4);

    should(actual.ok && actual.value).containDeep({ version: 4, confirmedBy: 'owner' });
  });

  it('should refuse a missing set and a moved-on version', () => {
    should(confirmLaneSet(null, 1)).deepEqual({ ok: false, error: { code: 'no-lane-set' } });
    should(confirmLaneSet(proposed({ version: 2 }), 1)).deepEqual({
      ok: false,
      error: { code: 'version-conflict', current: 2 },
    });
  });
});

describe('the words of a refusal', () => {
  it('should tell a card creator the exact command to run', () => {
    should(noLaneSetMessage('ferretry', 'fy')).equal(
      'ferretry has no lanes yet. Propose them first: fy board lanes propose --template ' +
        'pr-release-verify|pr-release|pr|ops|writing|quick --project ferretry',
    );
  });

  it('should describe every failure', () => {
    should(describeLaneSetFailure({ code: 'not-found', projectId: 'x' })).equal('no board for project x');
    should(describeLaneSetFailure({ code: 'unknown-lane', laneId: 'l' })).containEql('no lane l');
    should(describeLaneSetFailure({ code: 'relocation-missing', laneIds: ['a', 'b'] })).containEql('lanes a, b');
    should(describeLaneSetFailure({ code: 'version-conflict', current: 5 })).containEql('version 5');
    should(describeLaneSetFailure({ code: 'already-confirmed', version: 2 })).containEql('version 2');
    should(describeLaneSetFailure({ code: 'no-lane-set' })).containEql('no lanes yet');
    should(describeLaneSetFailure({ code: 'owner-only' })).containEql('only the owner');
  });
});

describe('mergeReleaseLanes', () => {
  const classic = (overrides: Partial<LaneSet> = {}): LaneSet => ({
    ...lanes(FERRETRY_ID),
    version: 4,
    confirmedBy: 'owner',
    proposedBy: 'koen',
    ...overrides,
  });

  it('should fold Released and To test into one owner-gated verify lane, entered on release', () => {
    // Act
    const merged = mergeReleaseLanes(classic());

    // Assert
    should(merged?.from).equal('tested');
    should(merged?.into).equal('released');
    should(merged?.next.lanes.map(lane => lane.id)).deepEqual([
      'todo',
      'plan',
      'implement',
      'review',
      'merged',
      'released',
      'closed',
    ]);
    should(merged?.next.lanes.find(lane => lane.id === 'released')).deepEqual({
      id: 'released',
      name: RELEASED_TO_TEST_NAME,
      category: 'verify',
      enterOn: ['release.published'],
      ownerGate: true,
      emphasis: 'action',
    });
  });

  it('should raise the version, keep the confirmation and the targets, and ask the owner nothing', () => {
    const next = mergeReleaseLanes(classic())?.next;
    should(next).containDeep({ version: 5, confirmedBy: 'owner', proposedBy: 'koen' });
    should(next).containDeep({ doneLane: 'closed', notGoodLane: 'implement' });
    should(next === undefined ? false : LaneSetSchema.safeParse(next).success).be.true();
  });

  it('should walk the merged lane in every variant that walked either', () => {
    // Arrange
    const set = classic({
      variants: {
        quick: ['todo', 'implement', 'review', 'merged', 'tested', 'closed'],
        investigate: ['todo', 'implement', 'review', 'merged', 'released', 'tested', 'closed'],
      },
    });

    // Act
    const next = mergeReleaseLanes(set)?.next;

    // Assert
    should(next?.variants.quick).deepEqual(['todo', 'implement', 'review', 'merged', 'released', 'closed']);
    should(next?.variants.investigate).deepEqual(['todo', 'implement', 'review', 'merged', 'released', 'closed']);
  });

  it('should find the lanes by what enters them, whatever they are called, and keep any other trigger', () => {
    // Arrange
    const set = classic({
      lanes: lanes(FERRETRY_ID).lanes.map(lane => {
        if (lane.id === 'released') return { ...lane, id: 'shipped-out', name: 'Out' };
        if (lane.id === 'tested') return { ...lane, id: 'qa', name: 'QA', enterOn: ['release.running', 'signal.done'] };
        return lane;
      }),
      variants: {},
    });

    // Act
    const merged = mergeReleaseLanes(set);

    // Assert
    should(merged).match({ from: 'qa', into: 'shipped-out' });
    should(merged?.next.lanes.find(lane => lane.id === 'shipped-out')).match({
      name: RELEASED_TO_TEST_NAME,
      enterOn: ['release.published', 'signal.done'],
    });
  });

  it('should carry To test’s gate as it was, and say nothing of a gate it did not have', () => {
    const ungated = classic({
      lanes: lanes(FERRETRY_ID).lanes.map(lane => {
        if (lane.id === 'tested')
          return { id: lane.id, name: lane.name, category: lane.category, enterOn: lane.enterOn };
        return lane;
      }),
    });
    should(mergeReleaseLanes(ungated)?.next.lanes.find(lane => lane.id === 'released')?.ownerGate).be.undefined();
  });

  it('should be idempotent, leave alone every set with nothing to merge, and need only the two lanes', () => {
    // Arrange
    const once = mergeReleaseLanes(classic())?.next;
    const noMerged = classic({ lanes: lanes(FERRETRY_ID).lanes.filter(lane => lane.id !== 'merged'), variants: {} });
    const reordered = (() => {
      const all = [...lanes(FERRETRY_ID).lanes];
      const tested = all.splice(6, 1);
      all.splice(5, 0, ...tested);
      return classic({ lanes: all, variants: {} });
    })();

    // Act + Assert
    should(once === undefined ? undefined : mergeReleaseLanes(once)).be.null();
    should(mergeReleaseLanes(templateLanes(FERRETRY_ID))).be.null();
    should(mergeReleaseLanes(lanes(FERRETRY_ID, 'pr-release'))).be.null();
    should(mergeReleaseLanes(lanes(FERRETRY_ID, 'quick'))).be.null();
    should(mergeReleaseLanes(reordered)).be.null();
    should(mergeReleaseLanes(noMerged)).not.be.null();
  });
});
