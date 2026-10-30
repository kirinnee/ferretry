import { describe, it } from 'bun:test';
import should from 'should';
import * as lanesModule from '../../src/lib/board-lanes.ts';
import {
  categoryOf,
  DependencyUntilSchema,
  firstLaneOfCategory,
  isBackwardMove,
  isBlockerDone,
  LANE_CATEGORIES,
  LANE_TEMPLATES,
  type Lane,
  LaneCategorySchema,
  LaneIdSchema,
  LaneLayoutSchema,
  laneForTrigger,
  laneLayoutFromTemplate,
  laneLayoutProblems,
  LaneNameSchema,
  LaneRenamesSchema,
  LaneSchema,
  type LaneSet,
  LaneSetSchema,
  LaneTemplateNameSchema,
  LaneTriggerSchema,
  LaneVariantsSchema,
  laneOf,
  needsOwner,
  nextLane,
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

  it('should give Ferretry its lanes, triggers, gates and thresholds', () => {
    should(FERRETRY.lanes).deepEqual([
      { id: 'todo', name: 'Todo', category: 'backlog', staleAfter: '3d' },
      {
        id: 'plan',
        name: 'Plan/Design',
        category: 'active',
        enterOn: ['work.started'],
        ownerGate: true,
        staleAfter: '2h',
      },
      { id: 'implement', name: 'Implement', category: 'active', enterOn: ['work.started'], staleAfter: '2h' },
      {
        id: 'review',
        name: 'Review/CI',
        category: 'review',
        enterOn: ['pr.opened', 'pr.ready', 'signal.done'],
        staleAfter: '24h',
      },
      { id: 'merged', name: 'Merged', category: 'shipped', enterOn: ['pr.merged'], staleAfter: '3d' },
      { id: 'released', name: 'Released', category: 'shipped', enterOn: ['release.published'] },
      { id: 'tested', name: 'Manually tested', category: 'verify', enterOn: ['release.running'], ownerGate: true },
      { id: 'closed', name: 'Closed', category: 'closed', ownerGate: true },
    ]);
    should(FERRETRY.variants.quick).deepEqual([
      'todo',
      'implement',
      'review',
      'merged',
      'released',
      'tested',
      'closed',
    ]);
    should(FERRETRY.variants['design-first']).deepEqual(FERRETRY.lanes.map(entry => entry.id));
  });

  it('should close on the last lane’s trigger in the sets with no verify lane', () => {
    const closing = (template: lanesModule.LaneTemplateName) =>
      LANE_TEMPLATES[template].lanes.find(entry => entry.category === 'closed');
    should(closing('pr-release')).deepEqual({
      id: 'released',
      name: 'Released',
      category: 'closed',
      enterOn: ['release.published'],
    });
    should(closing('pr')).deepEqual({ id: 'merged', name: 'Merged', category: 'closed', enterOn: ['pr.merged'] });
    should(closing('quick')?.enterOn).deepEqual(['signal.done']);
    should(closing('ops')?.ownerGate).be.true();
    should(closing('writing')?.ownerGate).be.true();
  });

  it('should name the lanes of the other templates', () => {
    const names = (template: lanesModule.LaneTemplateName) => LANE_TEMPLATES[template].lanes.map(entry => entry.name);
    should(names('ops')).deepEqual(['Todo', 'Investigate', 'Fix', 'Verify', 'Closed']);
    should(names('writing')).deepEqual(['Todo', 'Research', 'Draft', 'Review', 'Published', 'Closed']);
    should(names('quick')).deepEqual(['Todo', 'Doing', 'Closed']);
  });

  it('should apply a proposal’s renames and keep lane ids', () => {
    // Act
    const renamed = laneLayoutFromTemplate('pr-release-verify', { plan: 'Investigate', tested: 'QA' });

    // Assert
    should(renamed.ok).be.true();
    if (!renamed.ok) return;
    should(renamed.value.lanes.map(entry => `${entry.id}:${entry.name}`)).containDeep([
      'plan:Investigate',
      'tested:QA',
    ]);
    should(renamed.value.lanes.map(entry => entry.id)).deepEqual(FERRETRY.lanes.map(entry => entry.id));
    should(laneLayoutFromTemplate('quick')).deepEqual({ ok: true, value: LANE_TEMPLATES.quick });
  });

  it('should refuse a rename of a lane the template does not have', () => {
    should(laneLayoutFromTemplate('quick', { plan: 'Plan' })).deepEqual({
      ok: false,
      error: { code: 'unknown-lane', laneId: 'plan' },
    });
  });
});

describe('lane helpers', () => {
  const unknown = (laneId: string) => ({ ok: false, error: { code: 'unknown-lane', laneId } });
  /** A set whose variant names a lane it does not have: only reachable without parsing. */
  const broken: LaneSet = { ...FERRETRY, variants: { quick: ['todo', 'ghost'] } };

  it('should find a lane and its category', () => {
    should(laneOf(FERRETRY, 'merged')).deepEqual({ ok: true, value: FERRETRY.lanes[4] });
    should(laneOf(FERRETRY, 'ghost')).deepEqual(unknown('ghost'));
    should(categoryOf(FERRETRY, 'tested')).deepEqual({ ok: true, value: 'verify' });
    should(categoryOf(FERRETRY, 'ghost')).deepEqual(unknown('ghost'));
  });

  it('should tell a move back by lane order', () => {
    should(isBackwardMove(FERRETRY, 'tested', 'implement')).deepEqual({ ok: true, value: true });
    should(isBackwardMove(FERRETRY, 'plan', 'implement')).deepEqual({ ok: true, value: false });
    should(isBackwardMove(FERRETRY, 'implement', 'plan')).deepEqual({ ok: true, value: true });
    should(isBackwardMove(FERRETRY, 'ghost', 'plan')).deepEqual(unknown('ghost'));
    should(isBackwardMove(FERRETRY, 'plan', 'ghost')).deepEqual(unknown('ghost'));
  });

  it('should walk a workflow’s variant, or every lane when it has none', () => {
    const ids = (result: ReturnType<typeof variantLanes>) => (result.ok ? result.value.map(entry => entry.id) : result);
    should(ids(variantLanes(FERRETRY, 'quick'))).deepEqual(FERRETRY.variants.quick);
    should(ids(variantLanes({ ...FERRETRY, variants: {} }, 'investigate'))).deepEqual(
      FERRETRY.lanes.map(entry => entry.id),
    );
    should(variantLanes(broken, 'quick')).deepEqual(unknown('ghost'));
  });

  it('should find the next lane, skipping what the variant skips', () => {
    const next = (workflow: 'quick' | 'design-first', from: string) => {
      const result = nextLane(FERRETRY, workflow, from);
      return result.ok ? (result.value?.id ?? null) : result;
    };
    should(next('quick', 'todo')).equal('implement');
    should(next('design-first', 'todo')).equal('plan');
    should(next('quick', 'plan')).equal('implement');
    should(next('quick', 'closed')).be.null();
    should(nextLane(FERRETRY, 'quick', 'ghost')).deepEqual(unknown('ghost'));
    should(nextLane(broken, 'quick', 'todo')).deepEqual(unknown('ghost'));
  });

  it('should find the first lane of a category in a variant', () => {
    should(firstLaneOfCategory(FERRETRY, 'design-first', 'active')).deepEqual({ ok: true, value: FERRETRY.lanes[1] });
    should(firstLaneOfCategory(FERRETRY, 'quick', 'active')).deepEqual({ ok: true, value: FERRETRY.lanes[2] });
    should(firstLaneOfCategory(laneSetOf('quick'), 'quick', 'verify')).deepEqual({
      ok: false,
      error: { code: 'no-lane-of-category', category: 'verify' },
    });
    should(firstLaneOfCategory(broken, 'quick', 'backlog')).deepEqual(unknown('ghost'));
  });

  it('should send a trigger to the first lane of the variant that enters on it', () => {
    const target = (workflow: 'quick' | 'design-first', trigger: lanesModule.LaneTrigger) => {
      const result = laneForTrigger(FERRETRY, workflow, trigger);
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
    should(needsOwner(FERRETRY, 'tested', 'closed')).deepEqual({ ok: true, value: true });
    should(needsOwner(FERRETRY, 'implement', 'closed')).deepEqual({ ok: true, value: true });
    should(needsOwner(FERRETRY, 'plan', 'implement')).deepEqual({ ok: true, value: true });
    should(needsOwner(FERRETRY, 'tested', 'implement')).deepEqual({ ok: true, value: false });
    should(needsOwner(FERRETRY, 'plan', 'plan')).deepEqual({ ok: true, value: false });
    should(needsOwner(FERRETRY, 'implement', 'review')).deepEqual({ ok: true, value: false });
    should(needsOwner(laneSetOf('quick'), 'doing', 'closed')).deepEqual({ ok: true, value: false });
    should(needsOwner(FERRETRY, 'ghost', 'closed')).deepEqual(unknown('ghost'));
    should(needsOwner(FERRETRY, 'plan', 'ghost')).deepEqual(unknown('ghost'));
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
