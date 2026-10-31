import { describe, it } from 'bun:test';
import should from 'should';
import * as lanesModule from '../../src/lib/board-lanes.ts';
import {
  categoryOf,
  DependencyUntilSchema,
  defaultLaneTargets,
  firstLaneOfCategory,
  isBackwardMove,
  isBlockerDone,
  LANE_CATEGORIES,
  LANE_TEMPLATES,
  type Lane,
  LaneCategorySchema,
  LaneEmphasisSchema,
  LaneIdSchema,
  LaneLayoutSchema,
  LaneNameSchema,
  LaneRenamesSchema,
  LaneSchema,
  type LaneSet,
  LaneSetSchema,
  LaneTemplateNameSchema,
  LaneTriggerSchema,
  LaneVariantsSchema,
  laneEmphasis,
  laneForTrigger,
  laneLayoutFromTemplate,
  laneLayoutProblems,
  laneOf,
  laneUse,
  LANE_CATEGORY_USE,
  laneTargets,
  needsOwner,
  nextLane,
  QUICK_TO_TEST_LANE,
  StaleAfterSchema,
  staleAfterMinutes,
  variantLanes,
} from '../../src/lib/board-lanes.ts';
import { TaskWorkflowSchema } from '../../src/lib/tasks.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const PROJECT = '00000000-0000-4000-8000-000000000001';

const laneSetOf = (template: lanesModule.LaneTemplateName): LaneSet => ({
  projectId: PROJECT,
  version: 1,
  confirmedBy: null,
  proposedBy: 'session-1',
  ...LANE_TEMPLATES[template],
});

const FERRETRY = laneSetOf('pr-release-verify');

/**
 * Ferretry's lanes before board v3: Review/CI on its own, and Released apart from To test. Stored and
 * hand-made sets still look like this, so the helpers are exercised over it.
 */
const CLASSIC: LaneSet = {
  projectId: PROJECT,
  version: 1,
  confirmedBy: null,
  proposedBy: 'session-1',
  lanes: [
    { id: 'todo', name: 'Todo', category: 'backlog', staleAfter: '3d' },
    { id: 'plan', name: 'Plan/Design', category: 'active', enterOn: ['work.started'], ownerGate: true },
    { id: 'implement', name: 'Implement', category: 'active', enterOn: ['work.started'] },
    { id: 'review', name: 'Review/CI', category: 'review', enterOn: ['pr.opened', 'pr.ready', 'signal.done'] },
    { id: 'merged', name: 'Merged', category: 'shipped', enterOn: ['pr.merged'] },
    { id: 'released', name: 'Released', category: 'shipped', enterOn: ['release.published'] },
    { id: 'tested', name: 'To test', category: 'verify', enterOn: ['release.running'], ownerGate: true },
    { id: 'closed', name: 'Closed', category: 'closed', ownerGate: true },
  ],
  variants: { quick: ['todo', 'implement', 'review', 'merged', 'released', 'tested', 'closed'] },
  doneLane: 'closed',
  notGoodLane: 'implement',
};

const lane = (id: string, category: Lane['category'], extra: Partial<Lane> = {}): Lane => ({
  id,
  name: id,
  category,
  ...extra,
});

/** A minimal sound layout, for breaking one rule at a time. */
const layout = (lanes: readonly Lane[], variants: lanesModule.LaneVariants = {}) => ({ lanes, variants });
const SOUND = [lane('todo', 'backlog'), lane('doing', 'active'), lane('closed', 'closed')];

const VALID: readonly SchemaCase[] = [
  { name: 'category', schema: LaneCategorySchema, value: 'verify' },
  { name: 'trigger', schema: LaneTriggerSchema, value: 'release.running' },
  { name: 'lane id', schema: LaneIdSchema, value: 'review-ci' },
  { name: 'lane name', schema: LaneNameSchema, value: 'Review/CI' },
  { name: 'stale after', schema: StaleAfterSchema, value: '24h' },
  { name: 'emphasis', schema: LaneEmphasisSchema, value: 'action' },
  { name: 'lane', schema: LaneSchema, value: FERRETRY.lanes[1] },
  { name: 'variants', schema: LaneVariantsSchema, value: { quick: ['todo', 'closed'] } },
  { name: 'layout', schema: LaneLayoutSchema, value: layout(SOUND) },
  { name: 'lane set', schema: LaneSetSchema, value: FERRETRY },
  { name: 'confirmed lane set', schema: LaneSetSchema, value: { ...FERRETRY, confirmedBy: 'owner', version: 3 } },
  { name: 'template name', schema: LaneTemplateNameSchema, value: 'ops' },
  { name: 'renames', schema: LaneRenamesSchema, value: { plan: 'Investigate' } },
  { name: 'until', schema: DependencyUntilSchema, value: 'released' },
];

const INVALID: readonly SchemaCase[] = [
  { name: 'unknown category', schema: LaneCategorySchema, value: 'done' },
  { name: 'unknown trigger', schema: LaneTriggerSchema, value: 'pr.closed' },
  { name: 'upper-case id', schema: LaneIdSchema, value: 'Review' },
  { name: 'long id', schema: LaneIdSchema, value: `a${'b'.repeat(32)}` },
  { name: 'two-line name', schema: LaneNameSchema, value: 'Review\nCI' },
  { name: 'empty name', schema: LaneNameSchema, value: '  ' },
  { name: 'unknown emphasis', schema: LaneEmphasisSchema, value: 'loud' },
  { name: 'no unit', schema: StaleAfterSchema, value: '2' },
  { name: 'zero', schema: StaleAfterSchema, value: '0h' },
  { name: 'repeated trigger', schema: LaneSchema, value: lane('a', 'review', { enterOn: ['pr.opened', 'pr.opened'] }) },
  { name: 'empty trigger list', schema: LaneSchema, value: lane('a', 'review', { enterOn: [] }) },
  { name: 'unknown workflow', schema: LaneVariantsSchema, value: { someday: ['todo'] } },
  { name: 'empty variant', schema: LaneVariantsSchema, value: { quick: [] } },
  { name: 'proposed by nobody', schema: LaneSetSchema, value: { ...FERRETRY, proposedBy: '' } },
  { name: 'confirmed by a ferret', schema: LaneSetSchema, value: { ...FERRETRY, confirmedBy: 'session-1' } },
  { name: 'no lanes', schema: LaneLayoutSchema, value: layout([]) },
  { name: 'unknown template', schema: LaneTemplateNameSchema, value: 'kanban' },
  { name: 'rename to blank', schema: LaneRenamesSchema, value: { plan: '' } },
];

describe('board lane schemas', () => {
  it('should round-trip every valid shape and refuse the rest', () => {
    assertRoundTrips(VALID);
    assertRejects(INVALID);
    assertCoversEverySchema(lanesModule, VALID);
  });

  it('should list the categories in travel order', () => {
    should([...LANE_CATEGORIES]).deepEqual(['backlog', 'active', 'review', 'shipped', 'verify', 'closed']);
  });

  it('should read a stale-after duration in minutes', () => {
    should(staleAfterMinutes('30m')).equal(30);
    should(staleAfterMinutes('2h')).equal(120);
    should(staleAfterMinutes('3d')).equal(3 * 24 * 60);
  });
});

describe('lane set invariants', () => {
  const problemsOf = (lanes: readonly Lane[], variants: lanesModule.LaneVariants = {}) =>
    laneLayoutProblems(layout(lanes, variants)).map(([, message]) => message);

  it('should accept a sound layout', () => {
    should(problemsOf(SOUND)).deepEqual([]);
  });

  it('should refuse a repeated lane id', () => {
    should(problemsOf([...SOUND, lane('doing', 'review')])).deepEqual(['lane ids must be unique']);
  });

  it('should need a backlog lane', () => {
    should(problemsOf(SOUND.slice(1))).deepEqual(['a lane set needs at least one backlog lane']);
  });

  it('should need exactly one closed lane', () => {
    should(problemsOf(SOUND.slice(0, 2))).deepEqual(['a lane set needs exactly one closed lane']);
    should(problemsOf([...SOUND, lane('archive', 'closed')])).deepEqual(['a lane set needs exactly one closed lane']);
  });

  it('should owner-gate the closed lane only when the set has a verify lane', () => {
    // Arrange
    const withVerify = [SOUND[0] as Lane, lane('tested', 'verify', { ownerGate: true }), lane('closed', 'closed')];
    const gated = [SOUND[0] as Lane, withVerify[1] as Lane, lane('closed', 'closed', { ownerGate: true })];
    const notGated = [SOUND[0] as Lane, withVerify[1] as Lane, lane('closed', 'closed', { ownerGate: false })];

    // Act + Assert
    should(problemsOf(withVerify)).deepEqual(['the closed lane is owner-gated in a set that has a verify lane']);
    should(problemsOf(notGated)).deepEqual(['the closed lane is owner-gated in a set that has a verify lane']);
    should(problemsOf(gated)).deepEqual([]);
    should(problemsOf([...SOUND.slice(0, 2), lane('closed', 'closed', { ownerGate: false })])).deepEqual([]);
  });

  it('should keep variants to this set’s lanes, once each, in lane order', () => {
    should(problemsOf(SOUND, { quick: ['todo', 'closed'] })).deepEqual([]);
    should(problemsOf(SOUND, { quick: ['todo', 'review'] })).deepEqual(['a variant names only lanes of this set']);
    should(problemsOf(SOUND, { quick: ['closed', 'todo'] })).deepEqual([
      'a variant lists its lanes once each, in lane order',
    ]);
    should(problemsOf(SOUND, { quick: ['todo', 'todo'] })).deepEqual([
      'a variant lists its lanes once each, in lane order',
    ]);
  });

  it('should report a broken rule at its path when parsed', () => {
    // Act
    const parsed = LaneSetSchema.safeParse({ ...FERRETRY, variants: { quick: ['todo', 'nowhere'] } });

    // Assert
    should(parsed.success).be.false();
    should(parsed.error?.issues.map(issue => issue.path)).deepEqual([['variants', 'quick']]);
  });
});

describe('lane templates', () => {
  it('should make every template a sound lane set with a variant for every workflow', () => {
    for (const template of LaneTemplateNameSchema.options) {
      // Act
      const parsed = LaneSetSchema.safeParse(laneSetOf(template));

      // Assert
      should(parsed.success).be.true();
      should(Object.keys(LANE_TEMPLATES[template].variants).sort()).deepEqual([...TaskWorkflowSchema.options].sort());
    }
  });

  it('should give Ferretry its action-first lanes, triggers, gates and thresholds', () => {
    should(FERRETRY.lanes).deepEqual([
      { id: 'todo', name: 'Todo', category: 'backlog', staleAfter: '3d', emphasis: 'progress' },
      {
        id: 'plan',
        name: 'Plan/Design',
        category: 'active',
        enterOn: ['work.started'],
        ownerGate: true,
        staleAfter: '2h',
        emphasis: 'action',
      },
      {
        id: 'implement',
        name: 'In progress',
        category: 'active',
        enterOn: ['work.started', 'pr.opened', 'pr.ready'],
        staleAfter: '4h',
        emphasis: 'progress',
      },
      { id: 'merged', name: 'Merged', category: 'shipped', enterOn: ['pr.merged'], staleAfter: '3d', emphasis: 'info' },
      {
        id: 'released',
        name: 'Released · to test',
        category: 'verify',
        enterOn: ['release.published'],
        ownerGate: true,
        emphasis: 'action',
      },
      { id: 'closed', name: 'Closed', category: 'closed', ownerGate: true, emphasis: 'info' },
    ]);
    should(FERRETRY.doneLane).equal('closed');
    should(FERRETRY.notGoodLane).equal('implement');
  });

  it('should walk Plan/Design only for the workflows that plan first', () => {
    const unplanned = ['todo', 'implement', 'merged', 'released', 'closed'];
    should(FERRETRY.variants.quick).deepEqual(unplanned);
    should(FERRETRY.variants.investigate).deepEqual(unplanned);
    should(FERRETRY.variants['design-first']).deepEqual(FERRETRY.lanes.map(entry => entry.id));
    should(FERRETRY.variants['research-first']).deepEqual(FERRETRY.lanes.map(entry => entry.id));
  });

  it('should fold review into In progress and keep no lane that waits on a release running', () => {
    for (const template of ['pr-release-verify', 'pr-release', 'pr'] as const) {
      const lanes = LANE_TEMPLATES[template].lanes;
      should(lanes.some(entry => entry.category === 'review')).be.false();
      should(lanes.find(entry => entry.id === 'implement')?.enterOn).deepEqual([
        'work.started',
        'pr.opened',
        'pr.ready',
      ]);
    }
    for (const template of LaneTemplateNameSchema.options) {
      should(
        LANE_TEMPLATES[template].lanes.some(entry => entry.enterOn?.includes('release.running') === true),
      ).be.false();
    }
  });

  it('should send Done to the closed lane and Not good to the last active lane, in every template', () => {
    for (const template of LaneTemplateNameSchema.options) {
      const { lanes, doneLane, notGoodLane } = LANE_TEMPLATES[template];
      should(lanes.find(entry => entry.id === doneLane)?.category).equal('closed');
      should(notGoodLane).equal(lanes.findLast(entry => entry.category === 'active')?.id);
    }
  });

  it('should close on the last lane’s trigger in the sets with no verify lane, and only by the owner elsewhere', () => {
    const closing = (template: lanesModule.LaneTemplateName) =>
      LANE_TEMPLATES[template].lanes.find(entry => entry.category === 'closed');
    should(closing('pr-release')).deepEqual({
      id: 'released',
      name: 'Released',
      category: 'closed',
      enterOn: ['release.published'],
      emphasis: 'info',
    });
    should(closing('pr')).deepEqual({
      id: 'merged',
      name: 'Merged',
      category: 'closed',
      enterOn: ['pr.merged'],
      emphasis: 'info',
    });
    should(closing('quick')?.ownerGate).be.true();
    should(closing('ops')?.ownerGate).be.true();
    should(closing('writing')?.ownerGate).be.true();
  });

  it('should give quick work a To test lane that a merge, a release and a done all enter', () => {
    // Arrange
    const quick = laneSetOf('quick');

    // Act
    const entered = (trigger: lanesModule.LaneTrigger) => {
      const found = laneForTrigger(quick, 'quick', trigger);
      return found.ok ? found.value?.id : undefined;
    };

    // Assert
    should(QUICK_TO_TEST_LANE).deepEqual({
      id: 'to-test',
      name: 'To test',
      category: 'verify',
      enterOn: ['pr.merged', 'release.published', 'signal.done'],
      ownerGate: true,
      emphasis: 'action',
    });
    should(quick.lanes.map(entry => entry.id)).deepEqual(['todo', 'doing', 'to-test', 'closed']);
    should(entered('pr.merged')).equal('to-test');
    should(entered('release.published')).equal('to-test');
    should(entered('signal.done')).equal('to-test');
    should(quick).match({ doneLane: 'closed', notGoodLane: 'doing' });
    should(LaneSetSchema.safeParse(quick).success).be.true();
  });

  it('should name the lanes of the other templates', () => {
    const names = (template: lanesModule.LaneTemplateName) => LANE_TEMPLATES[template].lanes.map(entry => entry.name);
    should(names('pr-release')).deepEqual(['Todo', 'Plan/Design', 'In progress', 'Merged', 'Released']);
    should(names('pr')).deepEqual(['Todo', 'Plan/Design', 'In progress', 'Merged']);
    should(names('ops')).deepEqual(['Todo', 'Investigate', 'Fix', 'Verify', 'Closed']);
    should(names('writing')).deepEqual(['Todo', 'Research', 'Draft', 'Review', 'Published', 'Closed']);
    should(names('quick')).deepEqual(['Todo', 'Doing', 'To test', 'Closed']);
  });

  it('should apply a proposal’s renames and keep lane ids and targets', () => {
    // Act
    const renamed = laneLayoutFromTemplate('pr-release-verify', { plan: 'Investigate', released: 'Shipped · try it' });

    // Assert
    should(renamed.ok).be.true();
    if (!renamed.ok) return;
    should(renamed.value.lanes.map(entry => `${entry.id}:${entry.name}`)).containDeep([
      'plan:Investigate',
      'released:Shipped · try it',
    ]);
    should(renamed.value.lanes.map(entry => entry.id)).deepEqual(FERRETRY.lanes.map(entry => entry.id));
    should(renamed.value).match({ doneLane: 'closed', notGoodLane: 'implement' });
    should(laneLayoutFromTemplate('quick')).deepEqual({ ok: true, value: LANE_TEMPLATES.quick });
  });

  it('should refuse a rename of a lane the template does not have', () => {
    should(laneLayoutFromTemplate('quick', { plan: 'Plan' })).deepEqual({
      ok: false,
      error: { code: 'unknown-lane', laneId: 'plan' },
    });
  });
});

describe('lane emphasis', () => {
  it('should draw a lane with the emphasis it declares', () => {
    should(laneEmphasis(lane('merged', 'shipped', { emphasis: 'progress' }))).equal('progress');
  });

  it('should derive it from the category, and from an owner gate, when the lane does not say', () => {
    should(laneEmphasis(lane('tested', 'verify'))).equal('action');
    should(laneEmphasis(lane('plan', 'active', { ownerGate: true }))).equal('action');
    should(laneEmphasis(lane('implement', 'active'))).equal('progress');
    should(laneEmphasis(lane('todo', 'backlog'))).equal('progress');
    should(laneEmphasis(lane('review', 'review'))).equal('progress');
    should(laneEmphasis(lane('merged', 'shipped'))).equal('info');
    should(laneEmphasis(lane('closed', 'closed', { ownerGate: true }))).equal('info');
  });

  it('should refuse a verify lane that is not action, and a closed lane that is not info', () => {
    const problemsOf = (lanes: readonly Lane[]) => laneLayoutProblems(layout(lanes)).map(([, message]) => message);
    should(
      problemsOf([SOUND[0] as Lane, lane('doing', 'active'), lane('closed', 'closed', { emphasis: 'action' })]),
    ).deepEqual(['the closed lane is hidden information, so its emphasis is info']);
    should(
      problemsOf([
        SOUND[0] as Lane,
        lane('tested', 'verify', { ownerGate: true, emphasis: 'info' }),
        lane('closed', 'closed', { ownerGate: true }),
      ]),
    ).deepEqual(["a verify lane is the owner's action, so its emphasis is action"]);
  });
});

describe('when a card belongs in a lane', () => {
  const useOf = (name: keyof typeof LANE_TEMPLATES, id: string): string => {
    const found = LANE_TEMPLATES[name].lanes.find(candidate => candidate.id === id);
    return laneUse(found as Lane);
  };

  it('should say it in words for every category, so any lane name is covered', () => {
    should(Object.keys(LANE_CATEGORY_USE).sort()).deepEqual([...LANE_CATEGORIES].sort());
    for (const category of LANE_CATEGORIES) should(laneUse({ category })).startWith(LANE_CATEGORY_USE[category]);
  });

  it('should tell a plan lane the owner gates from the lane the building happens in', () => {
    should(useOf('pr-release-verify', 'plan')).equal(
      'you are planning or designing it; the owner approves before it moves on; moves in when a session starts on it',
    );
    should(useOf('pr-release-verify', 'implement')).equal(
      'you are building it now; moves in when a session starts on it or a PR opens or a PR is ready',
    );
  });

  it('should name what moves a card into a shipped, verify and closed lane, and who passes the gate', () => {
    should(useOf('pr-release-verify', 'merged')).equal('merged, waiting for a release; moves in when the PR merges');
    should(useOf('pr-release-verify', 'released')).equal(
      'the owner tests it; moves in when a release ships it; the owner moves it on',
    );
    should(useOf('pr-release-verify', 'closed')).equal('finished; only the owner closes it');
    should(useOf('quick', 'to-test')).equal(
      'the owner tests it; moves in when the PR merges or a release ships it or `fy signal done`; the owner moves it on',
    );
  });

  it('should say a ferret moves a card into an active lane nothing enters by itself, and a backlog lane needs nothing', () => {
    should(useOf('ops', 'fix')).equal('you are building it now; move it here yourself');
    should(useOf('writing', 'draft')).equal('you are building it now; move it here yourself');
    should(useOf('ops', 'todo')).equal('not started yet');
  });
});

describe('Done and Not good lanes', () => {
  const problemsOf = (value: Parameters<typeof laneLayoutProblems>[0]) =>
    laneLayoutProblems(value).map(([path, message]) => `${path}: ${message}`);

  it('should derive them: the closed lane, and the last active lane, else the first backlog lane', () => {
    should(defaultLaneTargets(CLASSIC.lanes)).deepEqual({ doneLane: 'closed', notGoodLane: 'implement' });
    should(defaultLaneTargets([lane('todo', 'backlog'), lane('later', 'backlog'), lane('closed', 'closed')])).deepEqual(
      {
        doneLane: 'closed',
        notGoodLane: 'todo',
      },
    );
    should(defaultLaneTargets([lane('todo', 'backlog')])).be.undefined();
    should(defaultLaneTargets([lane('closed', 'closed')])).be.undefined();
  });

  it('should take a layout’s own targets, else the previous set’s that still fit, else derive them', () => {
    const sound = layout(SOUND);
    should(laneTargets({ ...sound, doneLane: 'closed', notGoodLane: 'doing' })).deepEqual({
      doneLane: 'closed',
      notGoodLane: 'doing',
    });
    const twoActive = layout([...SOUND.slice(0, 2), lane('fix', 'active'), lane('closed', 'closed')]);
    should(laneTargets(twoActive, { doneLane: 'closed', notGoodLane: 'doing' })).deepEqual({
      doneLane: 'closed',
      notGoodLane: 'doing',
    });
    should(laneTargets(twoActive, { doneLane: 'gone', notGoodLane: 'gone' })).deepEqual({
      doneLane: 'closed',
      notGoodLane: 'fix',
    });
    should(laneTargets(twoActive, { doneLane: 'todo', notGoodLane: 'todo' })).deepEqual({
      doneLane: 'closed',
      notGoodLane: 'fix',
    });
    should(laneTargets(layout([lane('todo', 'backlog')]))).be.undefined();
  });

  it('should refuse a Done lane that is not the closed lane, and a Not good lane work cannot resume in', () => {
    should(problemsOf({ ...layout(SOUND), doneLane: 'doing' })).deepEqual([
      'doneLane: Done moves a card to the closed lane',
    ]);
    should(problemsOf({ ...layout(SOUND), notGoodLane: 'closed' })).deepEqual([
      'notGoodLane: Not good moves a card back to an active lane, where work resumes',
    ]);
    should(problemsOf({ ...layout(SOUND), notGoodLane: 'todo' })).deepEqual([
      'notGoodLane: Not good moves a card back to an active lane, where work resumes',
    ]);
    should(problemsOf({ ...layout(SOUND), notGoodLane: 'ghost' })).deepEqual([
      'notGoodLane: Not good moves a card back to an active lane, where work resumes',
    ]);
    should(problemsOf({ ...layout([SOUND[0] as Lane, lane('closed', 'closed')]), notGoodLane: 'todo' })).deepEqual([]);
  });

  it('should read a stored set from before them with the targets derived, and keep declared ones', () => {
    // Arrange
    const { doneLane: _done, notGoodLane: _notGood, ...old } = CLASSIC;

    // Act
    const parsed = LaneSetSchema.parse(old);

    // Assert
    should(parsed).match({ doneLane: 'closed', notGoodLane: 'implement' });
    should(LaneSetSchema.parse({ ...old, notGoodLane: 'plan' })).match({ doneLane: 'closed', notGoodLane: 'plan' });
  });

  it('should leave what is not a lane set for the schema to refuse', () => {
    should(LaneSetSchema.safeParse(null).success).be.false();
    should(LaneSetSchema.safeParse({ ...CLASSIC, lanes: 'none' }).success).be.false();
    should(LaneSetSchema.safeParse({ ...CLASSIC, lanes: [{ id: 'Bad' }], doneLane: undefined }).success).be.false();
    should(
      LaneSetSchema.safeParse({ ...CLASSIC, lanes: [lane('todo', 'backlog')], doneLane: undefined }).success,
    ).be.false();
  });
});

describe('lane helpers', () => {
  const unknown = (laneId: string) => ({ ok: false, error: { code: 'unknown-lane', laneId } });
  /** A set whose variant names a lane it does not have: only reachable without parsing. */
  const broken: LaneSet = { ...CLASSIC, variants: { quick: ['todo', 'ghost'] } };

  it('should find a lane and its category', () => {
    should(laneOf(CLASSIC, 'merged')).deepEqual({ ok: true, value: CLASSIC.lanes[4] });
    should(laneOf(CLASSIC, 'ghost')).deepEqual(unknown('ghost'));
    should(categoryOf(CLASSIC, 'tested')).deepEqual({ ok: true, value: 'verify' });
    should(categoryOf(CLASSIC, 'ghost')).deepEqual(unknown('ghost'));
  });

  it('should tell a move back by lane order', () => {
    should(isBackwardMove(CLASSIC, 'tested', 'implement')).deepEqual({ ok: true, value: true });
    should(isBackwardMove(CLASSIC, 'plan', 'implement')).deepEqual({ ok: true, value: false });
    should(isBackwardMove(CLASSIC, 'implement', 'plan')).deepEqual({ ok: true, value: true });
    should(isBackwardMove(CLASSIC, 'ghost', 'plan')).deepEqual(unknown('ghost'));
    should(isBackwardMove(CLASSIC, 'plan', 'ghost')).deepEqual(unknown('ghost'));
  });

  it('should walk a workflow’s variant, or every lane when it has none', () => {
    const ids = (result: ReturnType<typeof variantLanes>) => (result.ok ? result.value.map(entry => entry.id) : result);
    should(ids(variantLanes(CLASSIC, 'quick'))).deepEqual(CLASSIC.variants.quick);
    should(ids(variantLanes({ ...CLASSIC, variants: {} }, 'investigate'))).deepEqual(
      CLASSIC.lanes.map(entry => entry.id),
    );
    should(variantLanes(broken, 'quick')).deepEqual(unknown('ghost'));
  });

  it('should find the next lane, skipping what the variant skips', () => {
    const next = (workflow: 'quick' | 'design-first', from: string) => {
      const result = nextLane(CLASSIC, workflow, from);
      return result.ok ? (result.value?.id ?? null) : result;
    };
    should(next('quick', 'todo')).equal('implement');
    should(next('design-first', 'todo')).equal('plan');
    should(next('quick', 'plan')).equal('implement');
    should(next('quick', 'closed')).be.null();
    should(nextLane(CLASSIC, 'quick', 'ghost')).deepEqual(unknown('ghost'));
    should(nextLane(broken, 'quick', 'todo')).deepEqual(unknown('ghost'));
  });

  it('should find the first lane of a category in a variant', () => {
    should(firstLaneOfCategory(CLASSIC, 'design-first', 'active')).deepEqual({ ok: true, value: CLASSIC.lanes[1] });
    should(firstLaneOfCategory(CLASSIC, 'quick', 'active')).deepEqual({ ok: true, value: CLASSIC.lanes[2] });
    should(firstLaneOfCategory(laneSetOf('quick'), 'quick', 'review')).deepEqual({
      ok: false,
      error: { code: 'no-lane-of-category', category: 'review' },
    });
    should(firstLaneOfCategory(broken, 'quick', 'backlog')).deepEqual(unknown('ghost'));
  });

  it('should send a trigger to the first lane of the variant that enters on it', () => {
    const target = (workflow: 'quick' | 'design-first', trigger: lanesModule.LaneTrigger) => {
      const result = laneForTrigger(CLASSIC, workflow, trigger);
      return result.ok ? (result.value?.id ?? null) : result;
    };
    should(target('design-first', 'work.started')).equal('plan');
    should(target('quick', 'work.started')).equal('implement');
    should(target('quick', 'pr.ready')).equal('review');
    should(target('quick', 'release.running')).equal('tested');
    should(target('quick', 'ci.green')).be.null();
    should(laneForTrigger(broken, 'quick', 'pr.merged')).deepEqual(unknown('ghost'));
  });

  it('should need the owner to close, and to move forward out of a gated lane', () => {
    should(needsOwner(CLASSIC, 'tested', 'closed')).deepEqual({ ok: true, value: true });
    should(needsOwner(CLASSIC, 'implement', 'closed')).deepEqual({ ok: true, value: true });
    should(needsOwner(CLASSIC, 'plan', 'implement')).deepEqual({ ok: true, value: true });
    should(needsOwner(CLASSIC, 'tested', 'implement')).deepEqual({ ok: true, value: false });
    should(needsOwner(CLASSIC, 'plan', 'plan')).deepEqual({ ok: true, value: false });
    should(needsOwner(CLASSIC, 'implement', 'review')).deepEqual({ ok: true, value: false });
    should(needsOwner(laneSetOf('quick'), 'doing', 'closed')).deepEqual({ ok: true, value: true });
    should(needsOwner(laneSetOf('quick'), 'doing', 'to-test')).deepEqual({ ok: true, value: false });
    should(needsOwner(laneSetOf('quick'), 'to-test', 'closed')).deepEqual({ ok: true, value: true });
    should(needsOwner(CLASSIC, 'ghost', 'closed')).deepEqual(unknown('ghost'));
    should(needsOwner(CLASSIC, 'plan', 'ghost')).deepEqual(unknown('ghost'));
  });

  it('should count a blocker done once it ships, or once it is released when that is what is waited for', () => {
    for (const category of ['backlog', 'active', 'review'] as const) {
      should(isBlockerDone(category, 'shipped', true)).be.false();
    }
    should(isBlockerDone('shipped', 'shipped')).be.true();
    should(isBlockerDone('shipped', 'released')).be.false();
    should(isBlockerDone('shipped', 'released', true)).be.true();
    should(isBlockerDone('verify', 'released')).be.true();
    should(isBlockerDone('closed', 'released')).be.true();
  });
});

describe('lane proposal references', () => {
  const projectId = '0b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

  it('should round trip a project and version through the reference', () => {
    const reference = lanesModule.laneProposalReference(projectId, 3);
    should(reference).equal(`lanes:${projectId}:3`);
    should(lanesModule.parseLaneProposalReference(reference)).deepEqual({ projectId, version: 3 });
  });

  it('should read the unfiled project too', () => {
    should(lanesModule.parseLaneProposalReference('lanes:unfiled:1')).deepEqual({ projectId: 'unfiled', version: 1 });
  });

  it('should refuse anything that is not a lane proposal reference', () => {
    for (const bad of [
      null,
      '',
      'task:abc',
      `lanes:${projectId}`,
      `lanes:${projectId}:`,
      `lanes:${projectId}:x`,
      `lanes:${projectId}:-1`,
      `lanes:${projectId}:1.5`,
      'lanes:not-a-project:2',
    ]) {
      should(lanesModule.parseLaneProposalReference(bad)).be.undefined();
    }
  });

  it('should name the two answers the card offers', () => {
    should(lanesModule.LANE_PROPOSAL_ANSWERS).deepEqual({ accept: 'Accept', edit: 'Edit' });
  });
});
