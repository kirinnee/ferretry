import { describe, it } from 'bun:test';
import {
  LANE_TEMPLATES,
  type LaneLayoutValue,
  type LaneSet,
  LaneSetSchema,
  type LaneStage,
  LaneTemplateNameSchema,
  type LaneTrigger,
  LaneTriggerSchema,
  laneForTrigger,
  laneStage,
  needsOwner,
  QUICK_TO_TEST_LANE,
  TaskWorkflowSchema,
  UNFILED_PROJECT_ID,
  VERIFY_GATE,
} from '@ferretry/protocol';
import should from 'should';
import {
  acceptPendingLaneSet,
  actorName,
  addQuickToTestLane,
  confirmLaneSet,
  decideLaneChange,
  describeLaneSetFailure,
  describeRelocationProblem,
  editLaneSet,
  type LaneActor,
  mergeReleaseLanes,
  nextLaneSetVersion,
  noLaneSetMessage,
  proposeLaneSet,
  RELEASED_TO_TEST_NAME,
  relocationProblems,
  stageLanes,
  unfiledLaneSet,
} from '../../../src/lib/board-projects/index.ts';
import { lanes, oldQuickLanes, templateLanes } from '../board/support.ts';
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
    should(unfiledLaneSet().lanes.map(lane => lane.id)).deepEqual(['todo', 'doing', 'to-test', 'closed']);
  });
});

describe('proposeLaneSet', () => {
  it('should store an unconfirmed first version from a template with renames applied', () => {
    const actual = proposeLaneSet(FERRETRY_ID, null, 'quick', { doing: 'Busy' }, 'koen');

    should(actual.ok).be.true();
    if (!actual.ok) return;
    should(actual.value).containDeep({ projectId: FERRETRY_ID, version: 1, confirmedBy: null, proposedBy: 'koen' });
    should(actual.value.lanes.map(lane => lane.name)).deepEqual(['Todo', 'Busy', 'To test', 'Closed']);
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

  it('should record an owner edit on the admin token as confirmed by the token', () => {
    const actual = editLaneSet(proposed(), edit({ layout: withoutDoing(), relocate: { doing: 'todo' } }), {
      kind: 'owner',
      via: 'admin-token',
    });

    should(actual.ok && actual.value).containDeep({ confirmedBy: 'owner', confirmedVia: 'admin-token' });
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

  it('should record a confirmation on the admin token as the token, and a person’s plainly after it', () => {
    const onToken = confirmLaneSet(proposed({ version: 4 }), 4, 'admin-token');
    const byPerson = onToken.ok ? confirmLaneSet(onToken.value, 4) : onToken;

    should(onToken.ok && onToken.value).containDeep({ confirmedBy: 'owner', confirmedVia: 'admin-token' });
    should(byPerson.ok && byPerson.value).containDeep({ confirmedBy: 'owner' });
    should(byPerson.ok && byPerson.value).not.have.property('confirmedVia');
  });

  it('should refuse a missing set and a moved-on version', () => {
    should(confirmLaneSet(null, 1)).deepEqual({ ok: false, error: { code: 'no-lane-set' } });
    should(confirmLaneSet(proposed({ version: 2 }), 1)).deepEqual({
      ok: false,
      error: { code: 'version-conflict', current: 2 },
    });
  });
});

/**
 * The live pr-release-verify set, confirmed, and a ferret's edits of it: each one a move the owner's gate holds
 * (`docs/board.md` § A ferret's lane change waits for the owner).
 */
describe('decideLaneChange', () => {
  const VERIFY = LANE_TEMPLATES['pr-release-verify'];
  const live = (overrides: Partial<LaneSet> = {}): LaneSet => ({
    projectId: FERRETRY_ID,
    version: 3,
    confirmedBy: 'owner',
    proposedBy: 'koen',
    ...VERIFY,
    ...overrides,
  });
  /** Exploit (a): Plan/Design made an automatic step, so no card waits there for the owner. */
  const planUngated = (): LaneLayoutValue => ({
    ...VERIFY,
    lanes: VERIFY.lanes.map(lane =>
      lane.id === 'plan' ? { ...lane, ownerGate: false, stage: { kind: 'auto', triggers: ['work.started'] } } : lane,
    ),
  });
  /** Exploit (b): Released · to test removed, its cards sent to Closed. */
  const withoutReleased = (): LaneLayoutValue => ({
    lanes: VERIFY.lanes.filter(lane => lane.id !== 'released'),
    variants: Object.fromEntries(
      Object.entries(VERIFY.variants).map(([workflow, ids]) => [workflow, (ids ?? []).filter(id => id !== 'released')]),
    ),
  });
  const edit = (layout: LaneLayoutValue, relocate: Record<string, string> = {}, version = 3) =>
    ({ action: 'edit', version, layout, relocate }) as const;

  it('should keep a ferret’s edit waiting beside the live set, which stays as it is, and move nothing', () => {
    // Act
    const actual = decideLaneChange(FERRETRY_ID, live(), edit(withoutReleased(), { released: 'closed' }), FERRET);

    // Assert
    should(actual.ok).be.true();
    if (!actual.ok) return;
    should(actual.value.change).equal('pending');
    should(actual.value.relocate).deepEqual({});
    const { pending, ...rest } = actual.value.next;
    should(rest).deepEqual(live());
    should(pending).containDeep({ version: 4, baseVersion: 3, proposedBy: 'koen', relocate: { released: 'closed' } });
    should(pending?.lanes.map(lane => lane.id)).deepEqual(['todo', 'plan', 'implement', 'merged', 'closed']);
  });

  it('should keep a gate a ferret would make automatic a gate on the live set', () => {
    const actual = decideLaneChange(FERRETRY_ID, live(), edit(planUngated()), FERRET);

    should(actual.ok && actual.value.change).equal('pending');
    const plan = actual.ok ? actual.value.next.lanes.find(lane => lane.id === 'plan') : undefined;
    should(plan === undefined ? undefined : laneStage(plan).kind).equal('gate');
    should(actual.ok && actual.value.next.pending?.lanes.find(lane => lane.id === 'plan')?.stage?.kind).equal('auto');
  });

  it('should keep a ferret’s propose on unconfirmed lanes waiting too, and refuse one that strands cards', () => {
    // Arrange: quick's lanes, unconfirmed and live; the pr template has no Doing, To test or Closed (Merged closes).
    const quick = live({ ...LANE_TEMPLATES.quick, confirmedBy: null });
    const sameLanes = live({ confirmedBy: null });

    // Act
    const stranding = decideLaneChange(FERRETRY_ID, quick, { action: 'propose', template: 'pr', renames: {} }, FERRET);
    const waiting = decideLaneChange(
      FERRETRY_ID,
      sameLanes,
      { action: 'propose', template: 'pr-release-verify', renames: { plan: 'Design' } },
      FERRET,
    );

    // Assert
    should(stranding).deepEqual({
      ok: false,
      error: { code: 'relocation-missing', laneIds: ['doing', 'to-test', 'closed'] },
    });
    should(waiting.ok && waiting.value.change).equal('pending');
    should(waiting.ok && waiting.value.next.lanes).deepEqual(sameLanes.lanes);
    should(waiting.ok && waiting.value.next.pending?.lanes.find(lane => lane.id === 'plan')?.name).equal('Design');
  });

  it('should take a first proposal live: a project with no lanes has nothing to protect', () => {
    const actual = decideLaneChange(FERRETRY_ID, null, { action: 'propose', template: 'quick', renames: {} }, FERRET);

    should(actual.ok && actual.value).containDeep({ change: 'live', relocate: {} });
    should(actual.ok && actual.value.next).containDeep({ version: 1, confirmedBy: null, proposedBy: 'koen' });
    should(actual.ok && actual.value.next.pending).be.undefined();
  });

  it('should take the owner’s own edit live at once, with its relocation, and drop a waiting proposal', () => {
    // Arrange
    const waiting = decideLaneChange(FERRETRY_ID, live(), edit(planUngated()), FERRET);
    const stored = waiting.ok ? waiting.value.next : live();

    // Act
    const actual = decideLaneChange(FERRETRY_ID, stored, edit(withoutReleased(), { released: 'closed' }), OWNER);

    // Assert: numbered above the dropped proposal, so its card's Accept can never name this set.
    should(actual.ok && actual.value).containDeep({ change: 'live', relocate: { released: 'closed' } });
    should(actual.ok && actual.value.next).containDeep({ version: 5, confirmedBy: 'owner' });
    should(actual.ok && actual.value.next.pending).be.undefined();
  });

  it('should make the waiting proposal live when the owner confirms its version, and move its cards then', () => {
    // Arrange
    const waiting = decideLaneChange(FERRETRY_ID, live(), edit(withoutReleased(), { released: 'closed' }), FERRET);
    const stored = waiting.ok ? waiting.value.next : live();

    // Act
    const accepted = decideLaneChange(FERRETRY_ID, stored, { action: 'confirm', version: 4 }, OWNER);
    const onToken = decideLaneChange(
      FERRETRY_ID,
      stored,
      { action: 'confirm', version: 4 },
      {
        kind: 'owner',
        via: 'admin-token',
      },
    );

    // Assert
    should(accepted.ok && accepted.value).containDeep({ change: 'live', relocate: { released: 'closed' } });
    should(accepted.ok && accepted.value.next).containDeep({ version: 4, confirmedBy: 'owner', proposedBy: 'koen' });
    should(accepted.ok && accepted.value.next.pending).be.undefined();
    should(accepted.ok && accepted.value.next.lanes.map(lane => lane.id)).deepEqual([
      'todo',
      'plan',
      'implement',
      'merged',
      'closed',
    ]);
    should(onToken.ok && onToken.value.next.confirmedVia).equal('admin-token');
  });

  it('should confirm the live set on its own version and leave the waiting proposal for the owner', () => {
    const waiting = decideLaneChange(FERRETRY_ID, live({ confirmedBy: null }), edit(planUngated()), FERRET);
    const stored = waiting.ok ? waiting.value.next : live();

    const actual = decideLaneChange(FERRETRY_ID, stored, { action: 'confirm', version: 3 }, OWNER);

    should(actual.ok && actual.value).containDeep({ change: 'live', relocate: {} });
    should(actual.ok && actual.value.next).containDeep({ version: 3, confirmedBy: 'owner', pending: { version: 4 } });
  });

  it('should refuse a ferret’s confirm of anything', () => {
    const waiting = decideLaneChange(FERRETRY_ID, live(), edit(planUngated()), FERRET);
    const stored = waiting.ok ? waiting.value.next : live();

    should(decideLaneChange(FERRETRY_ID, stored, { action: 'confirm', version: 4 }, FERRET)).deepEqual({
      ok: false,
      error: { code: 'owner-only' },
    });
  });

  it('should number a second ferret proposal above the first, so the first card’s Accept never takes it', () => {
    // Arrange
    const first = decideLaneChange(FERRETRY_ID, live(), edit(planUngated()), FERRET);
    const stored = first.ok ? first.value.next : live();

    // Act
    const second = decideLaneChange(FERRETRY_ID, stored, edit(withoutReleased(), { released: 'merged' }), FERRET);
    const replaced = second.ok ? second.value.next : stored;
    const staleAccept = decideLaneChange(FERRETRY_ID, replaced, { action: 'confirm', version: 4 }, OWNER);

    // Assert
    should(second.ok && second.value.next.pending).containDeep({ version: 5, baseVersion: 3 });
    should(staleAccept).deepEqual({ ok: false, error: { code: 'version-conflict', current: 3 } });
  });

  it('should refuse a ferret’s edit against a version the live set has moved past', () => {
    should(decideLaneChange(FERRETRY_ID, live(), edit(planUngated(), {}, 2), FERRET)).deepEqual({
      ok: false,
      error: { code: 'version-conflict', current: 3 },
    });
  });

  it('should refuse to accept a proposal whose live set moved on since', () => {
    // Arrange: stored as a boot migration that kept it would leave it.
    const stale = live({
      version: 5,
      pending: {
        version: 6,
        baseVersion: 3,
        proposedBy: 'koen',
        ...VERIFY,
        doneLane: 'closed',
        notGoodLane: 'implement',
        relocate: {},
      },
    });

    // Act + Assert
    should(acceptPendingLaneSet(stale)).deepEqual({ ok: false, error: { code: 'version-conflict', current: 5 } });
    should(acceptPendingLaneSet(live())).deepEqual({ ok: false, error: { code: 'no-lane-set' } });
  });

  it('should number every new version above the live set and any proposal', () => {
    should(nextLaneSetVersion(null)).equal(1);
    should(nextLaneSetVersion(live())).equal(4);
    const waiting = decideLaneChange(FERRETRY_ID, live(), edit(planUngated()), FERRET);
    should(waiting.ok && nextLaneSetVersion(waiting.value.next)).equal(5);
  });
});

/** What a relocation the owner did not make may do, over the pr-release-verify lanes. */
describe('relocationProblems', () => {
  const before = LANE_TEMPLATES['pr-release-verify'];
  const without = (...ids: string[]) => ({ lanes: before.lanes.filter(lane => !ids.includes(lane.id)) });

  it('should never close a card', () => {
    should(relocationProblems(before, without('released'), { released: 'closed' })).deepEqual([
      { from: 'released', to: 'closed', why: 'closes' },
    ]);
  });

  it('should never let a card forward out of a gate, even into another gate, but may move it back', () => {
    const afterPlan = without('plan');

    should(relocationProblems(before, afterPlan, { plan: 'implement' })).deepEqual([
      { from: 'plan', to: 'implement', why: 'leaves-gate', gate: 'plan' },
    ]);
    should(relocationProblems(before, afterPlan, { plan: 'released' })).deepEqual([
      { from: 'plan', to: 'released', why: 'leaves-gate', gate: 'plan' },
    ]);
    should(relocationProblems(before, afterPlan, { plan: 'todo' })).deepEqual([]);
  });

  it('should pass the boot merge of Released and To test: their cards move back, into the merged gate', () => {
    // Arrange
    const classic = lanes(FERRETRY_ID);
    const plan = mergeReleaseLanes(classic);
    if (plan === null) throw new Error('the classic set merges');

    // Act + Assert
    should(relocationProblems(classic, plan.next, { [plan.from]: plan.into })).deepEqual([]);
  });

  it('should place a removed lane no later lane survives after every lane, so any target is a move back', () => {
    const tail = { lanes: [...before.lanes, { id: 'extra', name: 'Extra', category: 'active' as const }] };

    should(relocationProblems(tail, before, { extra: 'implement' })).deepEqual([]);
  });

  it('should never carry a card forward past a gate', () => {
    should(relocationProblems(before, without('todo'), { todo: 'implement' })).deepEqual([
      { from: 'todo', to: 'implement', why: 'passes-gate', gate: 'plan' },
    ]);
    should(relocationProblems(before, without('implement'), { implement: 'merged' })).deepEqual([]);
  });

  it('should leave alone a move into a lane the set lacks or onto itself, and say every problem in words', () => {
    should(relocationProblems(before, without('released'), { released: 'nowhere', merged: 'merged' })).deepEqual([]);
    should(describeRelocationProblem({ from: 'released', to: 'closed', why: 'closes' })).containEql('only the owner');
    should(describeRelocationProblem({ from: 'plan', to: 'implement', why: 'leaves-gate', gate: 'plan' })).containEql(
      'out of a gate',
    );
    should(describeRelocationProblem({ from: 'todo', to: 'implement', why: 'passes-gate', gate: 'plan' })).containEql(
      'past plan',
    );
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
    should(
      describeLaneSetFailure({ code: 'owner-gate', problems: [{ laneId: 'plan', why: 'would pass Plan' }] }),
    ).equal('only the owner may change these gates: this change would pass Plan');
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

describe('addQuickToTestLane', () => {
  const old = { ...oldQuickLanes(UNFILED_PROJECT_ID), version: 4 };

  it('should put To test between Doing and Closed, keep every lane and its name, and gate Closed', () => {
    // Arrange
    const renamed = { ...old, lanes: old.lanes.map(lane => (lane.id === 'doing' ? { ...lane, name: 'Busy' } : lane)) };

    // Act
    const next = addQuickToTestLane(renamed);

    // Assert
    should(next?.lanes.map(lane => `${lane.id}:${lane.name}`)).deepEqual([
      'todo:Todo',
      'doing:Busy',
      'to-test:To test',
      'closed:Closed',
    ]);
    should(next?.lanes[2]).deepEqual(QUICK_TO_TEST_LANE);
    should(next?.lanes[3]).deepEqual({
      id: 'closed',
      name: 'Closed',
      category: 'closed',
      ownerGate: true,
      emphasis: 'info',
    });
    should(LaneSetSchema.safeParse(next).success).be.true();
  });

  it('should raise the version, keep the confirmation, the proposer and the targets, and ask the owner nothing', () => {
    // Act
    const next = addQuickToTestLane({ ...old, confirmedBy: null, proposedBy: 'koen' });

    // Assert
    should(next).match({
      projectId: UNFILED_PROJECT_ID,
      version: 5,
      confirmedBy: null,
      proposedBy: 'koen',
      doneLane: 'closed',
      notGoodLane: 'doing',
    });
    should(addQuickToTestLane(old)?.confirmedBy).equal('owner');
  });

  it('should walk To test in every variant that walked Doing or Closed, in lane order', () => {
    // Arrange
    const variants = { quick: ['todo', 'doing', 'closed'], investigate: ['todo', 'closed'], 'design-first': ['todo'] };

    // Act
    const next = addQuickToTestLane({ ...old, variants });

    // Assert
    should(next?.variants).deepEqual({
      quick: ['todo', 'doing', 'to-test', 'closed'],
      investigate: ['todo', 'to-test', 'closed'],
      'design-first': ['todo'],
    });
  });

  it('should keep any other trigger Closed was entered on, and only drop signal.done', () => {
    // Arrange
    const [todo, doing, closed] = old.lanes;
    const triggered = {
      ...old,
      lanes: [todo!, doing!, { ...closed!, enterOn: ['signal.done' as const, 'pr.merged' as const] }],
    };

    // Act / Assert
    should(addQuickToTestLane(triggered)?.lanes[3]?.enterOn).deepEqual(['pr.merged']);
  });

  it('should be idempotent and leave every other set alone', () => {
    // Arrange
    const once = addQuickToTestLane(old);

    // Act / Assert
    should(once).not.be.null();
    should(addQuickToTestLane(once as LaneSet)).be.null();
    should(addQuickToTestLane({ ...unfiledLaneSet() })).be.null();
    should(addQuickToTestLane(lanes())).be.null();
    should(addQuickToTestLane(templateLanes())).be.null();
    should(addQuickToTestLane(lanes(UNFILED_PROJECT_ID, 'ops'))).be.null();
    const [todo, doing, closed] = old.lanes;
    should(addQuickToTestLane({ ...old, lanes: [todo!, { ...doing!, id: 'busy' }, closed!], variants: {} })).be.null();
  });
});

describe('stageLanes', () => {
  const unstaged = (set: LaneSet): LaneSet => ({
    ...set,
    lanes: set.lanes.map(({ stage: _stage, ...lane }) => lane),
  });
  const confirmed = (set: LaneSet): LaneSet => ({ ...set, version: 6, confirmedBy: 'owner', proposedBy: 'koen' });
  /** Every stored shape a boot can find: the pre-v3 PR sets, quick from before To test, and every template. */
  const storedShapes = (): readonly (readonly [string, LaneSet])[] => [
    ...(['pr-release-verify', 'pr-release', 'pr'] as const).map(
      name => [`classic ${name}`, lanes(FERRETRY_ID, name)] as const,
    ),
    ['quick before To test', oldQuickLanes(UNFILED_PROJECT_ID)],
    ...LaneTemplateNameSchema.options.map(
      name => [`template ${name}`, unstaged(templateLanes(FERRETRY_ID, name))] as const,
    ),
  ];

  it('should write out on every lane the stage it already reads, and change nothing else, its version included', () => {
    for (const [, stored] of storedShapes()) {
      // Act
      const next = stageLanes(confirmed(stored));

      // Assert
      should(next?.lanes.map(lane => lane.stage)).deepEqual(stored.lanes.map(lane => laneStage(lane)));
      should(next === null ? null : unstaged(next)).deepEqual(confirmed(stored));
      should(next?.confirmedBy).equal('owner');
      should(LaneSetSchema.safeParse(next).success).be.true();
    }
  });

  it('should state the templates’ own stages for a set proposed before them', () => {
    for (const name of LaneTemplateNameSchema.options) {
      should(stageLanes(unstaged(templateLanes(FERRETRY_ID, name)))?.lanes).deepEqual(LANE_TEMPLATES[name].lanes);
    }
  });

  it('should gate Plan/Design and the lanes the owner tests, and nothing the ferret moves', () => {
    // Act
    const next = stageLanes(lanes(FERRETRY_ID));

    // Assert
    should(next?.lanes.map(lane => `${lane.id}:${lane.stage?.kind ?? '-'}`)).deepEqual([
      'todo:auto',
      'plan:gate',
      'implement:auto',
      'review:auto',
      'merged:auto',
      'released:auto',
      'tested:gate',
      'closed:auto',
    ]);
    should(next?.lanes.find(lane => lane.id === 'review')?.stage).deepEqual({
      kind: 'auto',
      triggers: ['pr.opened', 'pr.ready', 'signal.done'],
    });
  });

  it('should make a verify lane that is not owner-gated a gate, and leave it ungated', () => {
    // Arrange
    const stored = oldQuickLanes(UNFILED_PROJECT_ID);
    const handMade: LaneSet = {
      ...stored,
      lanes: [
        ...stored.lanes.slice(0, 2),
        { id: 'check', name: 'Check', category: 'verify' },
        { id: 'closed', name: 'Closed', category: 'closed', ownerGate: true },
      ],
      variants: {},
    };

    // Act
    const next = stageLanes(handMade);

    // Assert
    should(next?.lanes[2]).deepEqual({ id: 'check', name: 'Check', category: 'verify', stage: VERIFY_GATE });
    should(LaneSetSchema.safeParse(next).success).be.true();
  });

  it('should answer every move and every trigger the way the set did before', () => {
    for (const [, stored] of storedShapes()) {
      // Act
      const next = stageLanes(stored) as LaneSet;

      // Assert
      for (const from of stored.lanes) {
        for (const to of stored.lanes)
          should(needsOwner(next, from.id, to.id)).deepEqual(needsOwner(stored, from.id, to.id));
      }
      const entered = (set: LaneSet, workflow: (typeof TaskWorkflowSchema.options)[number], trigger: LaneTrigger) => {
        const lane = laneForTrigger(set, workflow, trigger);
        return lane.ok ? (lane.value?.id ?? null) : lane.error;
      };
      for (const workflow of TaskWorkflowSchema.options) {
        for (const trigger of LaneTriggerSchema.options) {
          should(entered(next, workflow, trigger)).deepEqual(entered(stored, workflow, trigger));
        }
      }
    }
  });

  it('should keep a stage a lane already has', () => {
    // Arrange
    const ask: LaneStage = { kind: 'gate', options: [{ id: 'go', label: 'Go', outcome: { kind: 'next' } }] };
    const stored = lanes(FERRETRY_ID);
    const partly: LaneSet = {
      ...stored,
      lanes: stored.lanes.map(lane => (lane.id === 'plan' ? { ...lane, stage: ask } : lane)),
    };

    // Act
    const next = stageLanes(partly);

    // Assert
    should(next?.lanes.find(lane => lane.id === 'plan')?.stage).deepEqual(ask);
    should(next?.lanes.every(lane => lane.stage !== undefined)).be.true();
  });

  it('should stage what the earlier boot migrations leave', () => {
    // Act
    const merged = mergeReleaseLanes(lanes(FERRETRY_ID))?.next;
    const quick = addQuickToTestLane(oldQuickLanes(UNFILED_PROJECT_ID));

    // Assert
    for (const set of [merged, quick]) {
      const next = set === undefined || set === null ? null : stageLanes(set);
      should(LaneSetSchema.safeParse(next).success).be.true();
      should(next?.lanes.every(lane => lane.stage !== undefined)).be.true();
    }
  });

  it('should do nothing to a set whose every lane has a stage', () => {
    for (const [, stored] of storedShapes()) {
      const once = stageLanes(stored);
      should(once === null ? 'unstaged' : stageLanes(once)).be.null();
    }
    should(stageLanes(templateLanes(FERRETRY_ID))).be.null();
    should(stageLanes(unfiledLaneSet())).be.null();
  });
});

describe('addQuickToTestLane over staged lanes', () => {
  it('should let Closed read the stage its new fields describe', () => {
    // Arrange: a quick set from before To test whose lanes were staged by hand.
    const old = oldQuickLanes(UNFILED_PROJECT_ID);
    const staged = { ...old, lanes: old.lanes.map(lane => ({ ...lane, stage: laneStage(lane) })) };

    // Act
    const next = addQuickToTestLane(staged);

    // Assert
    should(next?.lanes[3]?.stage).be.undefined();
    should(LaneSetSchema.safeParse(next).success).be.true();
  });
});
