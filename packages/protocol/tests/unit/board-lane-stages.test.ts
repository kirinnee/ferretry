import { describe, it } from 'bun:test';
import should from 'should';
import {
  EXTERNAL_LANE_TRIGGERS,
  type GateOption,
  gateOptions,
  gateOutcomeLane,
  isExternalTrigger,
  LANE_TEMPLATES,
  type Lane,
  LaneSchema,
  type LaneSet,
  LaneSetSchema,
  type LaneStage,
  LaneTemplateNameSchema,
  LaneTriggerSchema,
  laneLayoutProblems,
  laneStage,
  laneUse,
  needsOwner,
  PLAN_GATE,
  VERIFY_GATE,
} from '../../src/lib/board-lanes.ts';

const PROJECT = '00000000-0000-4000-8000-000000000001';

const lane = (id: string, category: Lane['category'], extra: Partial<Lane> = {}): Lane => ({
  id,
  name: id,
  category,
  ...extra,
});

/** A lane as an app that predates stages stores it: only the compatibility fields. */
const unstaged = ({ stage: _stage, ...rest }: Lane): Lane => rest;

const FERRETRY: LaneSet = {
  projectId: PROJECT,
  version: 1,
  confirmedBy: 'owner',
  proposedBy: 'session-1',
  ...LANE_TEMPLATES['pr-release-verify'],
};

const option = (id: string, outcome: GateOption['outcome']): GateOption => ({ id, label: id, outcome });

describe('a lane’s stage, derived when it stores none', () => {
  it('should make an owner-gated plan lane a gate that goes on to the next lane', () => {
    should(laneStage(lane('plan', 'active', { enterOn: ['work.started'], ownerGate: true }))).deepEqual({
      kind: 'gate',
      options: [{ id: 'ok', label: 'OK to build', outcome: { kind: 'next' } }],
    });
    should(laneStage(lane('check', 'review', { ownerGate: true }))).equal(PLAN_GATE);
  });

  it('should make every verify lane the Done / Not good gate, owner-gated or not', () => {
    // Arrange
    const expected: LaneStage = {
      kind: 'gate',
      options: [
        { id: 'done', label: 'Done', outcome: { kind: 'close' } },
        { id: 'not-good', label: 'Not good', outcome: { kind: 'reopen-with-agenda' } },
      ],
    };

    // Act + Assert
    should(laneStage(lane('tested', 'verify', { enterOn: ['release.published'], ownerGate: true }))).deepEqual(
      expected,
    );
    should(laneStage(lane('tested', 'verify'))).deepEqual(expected);
    should(laneStage(lane('tested', 'verify', { ownerGate: false }))).deepEqual(expected);
  });

  it('should make a closed lane automatic: the owner enters it, or its own trigger does', () => {
    should(laneStage(lane('closed', 'closed', { ownerGate: true }))).deepEqual({ kind: 'auto', triggers: [] });
    should(laneStage(lane('merged', 'closed', { enterOn: ['pr.merged'] }))).deepEqual({
      kind: 'auto',
      triggers: ['pr.merged'],
    });
  });

  it('should make any other lane move on its own triggers, or by the ferret when it has none', () => {
    should(laneStage(lane('doing', 'active', { enterOn: ['work.started', 'pr.opened'] }))).deepEqual({
      kind: 'auto',
      triggers: ['work.started', 'pr.opened'],
    });
    should(laneStage(lane('todo', 'backlog'))).deepEqual({ kind: 'auto', triggers: [] });
    should(laneStage(lane('fix', 'active', { ownerGate: false }))).deepEqual({ kind: 'auto', triggers: [] });
  });

  it('should read a stored stage as it is', () => {
    // Arrange
    const stage: LaneStage = { kind: 'gate', options: [option('send', { kind: 'lane', laneId: 'waiting' })] };

    // Act + Assert
    should(laneStage(lane('ready', 'review', { ownerGate: true, stage }))).equal(stage);
  });

  it('should list a gate’s options in order, and none for an automatic stage', () => {
    should(gateOptions(lane('tested', 'verify')).map(entry => entry.id)).deepEqual(['done', 'not-good']);
    should(gateOptions(lane('doing', 'active', { enterOn: ['work.started'] }))).deepEqual([]);
  });
});

describe('a stage and its compatibility fields', () => {
  const parse = (value: unknown) => LaneSchema.safeParse(value);
  const messages = (value: unknown) => parse(value).error?.issues.map(issue => issue.message) ?? [];

  it('should owner-gate a gate that leaves the gate out, except a verify lane, which is the owner’s already', () => {
    // Act
    const planned = parse(lane('plan', 'active', { stage: PLAN_GATE }));
    const tested = parse(lane('tested', 'verify', { stage: VERIFY_GATE }));

    // Assert
    should(planned.data).deepEqual({ ...lane('plan', 'active'), ownerGate: true, stage: PLAN_GATE });
    should(tested.data).deepEqual(lane('tested', 'verify', { stage: VERIFY_GATE }));
  });

  it('should enter an automatic stage on its triggers when the lane leaves them out', () => {
    // Act
    const parsed = parse(lane('deployed', 'shipped', { stage: { kind: 'auto', triggers: ['deploy.done'] } }));

    // Assert
    should(parsed.data).deepEqual(
      lane('deployed', 'shipped', { enterOn: ['deploy.done'], stage: { kind: 'auto', triggers: ['deploy.done'] } }),
    );
  });

  it('should round-trip either spelling unchanged', () => {
    for (const template of LaneTemplateNameSchema.options) {
      for (const entry of LANE_TEMPLATES[template].lanes) {
        should(parse(entry).data).deepEqual(entry);
        should(parse(unstaged(entry)).data).deepEqual(unstaged(entry));
        should(parse(parse(entry).data).data).deepEqual(entry);
      }
    }
  });

  it('should take the triggers in any order', () => {
    should(
      parse(
        lane('doing', 'active', {
          enterOn: ['pr.opened', 'work.started'],
          stage: { kind: 'auto', triggers: ['work.started', 'pr.opened'] },
        }),
      ).success,
    ).be.true();
  });

  it('should refuse a stage its compatibility fields disagree with', () => {
    should(messages(lane('closed', 'closed', { ownerGate: true, stage: PLAN_GATE }))).deepEqual([
      'a closed lane is the end of the workflow, never a gate',
    ]);
    should(messages(lane('plan', 'active', { ownerGate: false, stage: PLAN_GATE }))).deepEqual([
      'a gate is owner-gated',
    ]);
    should(
      messages(lane('doing', 'active', { enterOn: ['work.started'], stage: { kind: 'auto', triggers: [] } })),
    ).deepEqual(['an automatic stage enters on its triggers']);
    should(
      messages(
        lane('doing', 'active', { enterOn: ['work.started'], stage: { kind: 'auto', triggers: ['pr.opened'] } }),
      ),
    ).deepEqual(['an automatic stage enters on its triggers']);
    should(messages(lane('plan', 'active', { ownerGate: true, stage: { kind: 'auto', triggers: [] } }))).deepEqual([
      'an automatic stage is not owner-gated: a lane the owner passes is a gate',
    ]);
  });

  it('should refuse a stage that is not one, leaving the lane as it came', () => {
    should(parse(lane('doing', 'active', { stage: { kind: 'manual' } as never })).success).be.false();
    should(parse(lane('doing', 'active', { stage: { kind: 'auto' } as never })).success).be.false();
  });

  it('should keep an owner-gated closed lane automatic', () => {
    should(
      parse(lane('closed', 'closed', { ownerGate: true, stage: { kind: 'auto', triggers: [] } })).success,
    ).be.true();
  });

  it('should report a broken stage at the lane’s stage when a set is parsed', () => {
    // Act
    const parsed = LaneSetSchema.safeParse({
      ...FERRETRY,
      lanes: FERRETRY.lanes.map(entry => (entry.id === 'plan' ? { ...entry, ownerGate: false } : entry)),
    });

    // Assert
    should(parsed.success).be.false();
    should(parsed.error?.issues.map(issue => issue.path)).deepEqual([['lanes', 1, 'stage']]);
  });
});

describe('a gate option that names a lane', () => {
  const SOUND = [lane('todo', 'backlog'), lane('doing', 'active'), lane('closed', 'closed')];
  const gated = (laneId: string): Lane =>
    lane('ready', 'review', {
      ownerGate: true,
      stage: { kind: 'gate', options: [option('send', { kind: 'lane', laneId })] },
    });
  const problemsOf = (lanes: readonly Lane[]) =>
    laneLayoutProblems({ lanes, variants: {} }).map(([, message]) => message);

  it('should name another lane of the set', () => {
    should(problemsOf([...SOUND.slice(0, 2), gated('closed'), SOUND[2] as Lane])).deepEqual([]);
    should(problemsOf([...SOUND.slice(0, 2), gated('nowhere'), SOUND[2] as Lane])).deepEqual([
      'a gate option names a lane of this set',
    ]);
    should(problemsOf([...SOUND.slice(0, 2), gated('ready'), SOUND[2] as Lane])).deepEqual([
      'a gate option sends the card to another lane',
    ]);
  });
});

describe('external triggers', () => {
  it('should be the ones Ferretry cannot see, and only those', () => {
    should([...EXTERNAL_LANE_TRIGGERS]).deepEqual(['pr.review_approved', 'deploy.done']);
    should(LaneTriggerSchema.options.filter(isExternalTrigger)).deepEqual(['pr.review_approved', 'deploy.done']);
    should(isExternalTrigger('release.published')).be.false();
    should(isExternalTrigger('pr.merged')).be.false();
  });

  it('should say a reported trigger is reported in a lane’s use', () => {
    should(laneUse(lane('deployed', 'shipped', { enterOn: ['deploy.done'] }))).equal(
      'merged, waiting for a release; moves in when a deploy finishes (reported)',
    );
    should(laneUse(lane('approved', 'review', { enterOn: ['pr.review_approved'] }))).equal(
      'built and waiting to be reviewed; moves in when a reviewer approves the PR (reported)',
    );
  });
});

describe('where a gate’s answer sends a card', () => {
  /** A labelling-style set: Prepare → Send for review? → Waiting → Deployed → Confirm deployed? → Closed. */
  const LABELLING: LaneSet = {
    projectId: PROJECT,
    version: 1,
    confirmedBy: 'owner',
    proposedBy: 'session-1',
    lanes: [
      lane('todo', 'backlog'),
      lane('prepare', 'active', { enterOn: ['work.started'] }),
      lane('send', 'review', {
        ownerGate: true,
        stage: {
          kind: 'gate',
          options: [
            option('send', { kind: 'next' }),
            option('skip', { kind: 'lane', laneId: 'deployed' }),
            option('redo', { kind: 'reopen-with-agenda' }),
          ],
        },
      }),
      lane('waiting', 'review', { enterOn: ['pr.review_approved'] }),
      lane('deployed', 'shipped', { enterOn: ['deploy.done'] }),
      lane('confirm', 'verify', { ownerGate: true }),
      lane('closed', 'closed', { ownerGate: true }),
    ],
    variants: {},
    doneLane: 'closed',
    notGoodLane: 'prepare',
  };
  const target = (laneSet: LaneSet, laneId: string, optionId: string, workflow: 'quick' | 'design-first' = 'quick') => {
    const result = gateOutcomeLane(laneSet, workflow, laneId, optionId);
    return result.ok ? `${result.value.option.id}→${result.value.lane.id}` : result.error;
  };

  it('should go to the next lane of the card’s variant', () => {
    should(target(LABELLING, 'send', 'send')).equal('send→waiting');
    should(target(FERRETRY, 'plan', 'ok', 'design-first')).equal('ok→implement');
  });

  it('should go to the lane an option names', () => {
    should(target(LABELLING, 'send', 'skip')).equal('skip→deployed');
  });

  it('should reopen into the set’s Not good lane and close into its Done lane', () => {
    should(target(LABELLING, 'send', 'redo')).equal('redo→prepare');
    should(target(FERRETRY, 'released', 'not-good')).equal('not-good→implement');
    should(target(FERRETRY, 'released', 'done')).equal('done→closed');
    should(target(LABELLING, 'confirm', 'done')).equal('done→closed');
  });

  it('should answer with the option chosen, so a caller knows a reopen needs the owner’s words', () => {
    // Act
    const result = gateOutcomeLane(FERRETRY, 'quick', 'released', 'not-good');

    // Assert
    should(result.ok && result.value.option.outcome).deepEqual({ kind: 'reopen-with-agenda' });
  });

  it('should refuse a lane that is not a gate, an option it lacks, and a lane it does not have', () => {
    should(target(FERRETRY, 'implement', 'ok')).deepEqual({ code: 'not-a-gate', laneId: 'implement' });
    should(target(FERRETRY, 'released', 'ok')).deepEqual({
      code: 'unknown-option',
      laneId: 'released',
      optionId: 'ok',
    });
    should(target(FERRETRY, 'nowhere', 'ok')).deepEqual({ code: 'unknown-lane', laneId: 'nowhere' });
  });

  it('should refuse to go on from the last lane of a variant', () => {
    // Arrange
    const last: LaneSet = {
      ...LABELLING,
      variants: { quick: ['todo', 'prepare', 'send'] },
    };

    // Act + Assert
    should(target(last, 'send', 'send')).deepEqual({ code: 'no-next-lane', laneId: 'send' });
  });

  it('should refuse a target lane the set lacks', () => {
    // Arrange: parsed sets cannot hold this, so build it by hand.
    const broken = {
      ...LABELLING,
      lanes: LABELLING.lanes.filter(entry => entry.id !== 'deployed'),
    } as LaneSet;

    // Act + Assert
    should(target(broken, 'send', 'skip')).deepEqual({ code: 'unknown-lane', laneId: 'deployed' });
  });

  it('should refuse a variant that names a lane the set lacks', () => {
    // Arrange
    const broken = { ...LABELLING, variants: { quick: ['todo', 'gone'] } } as LaneSet;

    // Act + Assert
    should(target(broken, 'send', 'send')).deepEqual({ code: 'unknown-lane', laneId: 'gone' });
  });
});

describe('the templates’ stages', () => {
  it('should state on every lane the stage its compatibility fields describe', () => {
    for (const template of LaneTemplateNameSchema.options) {
      for (const entry of LANE_TEMPLATES[template].lanes) {
        should(entry.stage).deepEqual(laneStage(unstaged(entry)));
      }
    }
  });

  it('should gate exactly the lanes the owner passes', () => {
    const gates = (template: (typeof LaneTemplateNameSchema.options)[number]) =>
      LANE_TEMPLATES[template].lanes.filter(entry => entry.stage?.kind === 'gate').map(entry => entry.id);
    should(gates('pr-release-verify')).deepEqual(['plan', 'released']);
    should(gates('pr-release')).deepEqual(['plan']);
    should(gates('pr')).deepEqual(['plan']);
    should(gates('ops')).deepEqual(['verify']);
    should(gates('writing')).deepEqual([]);
    should(gates('quick')).deepEqual(['to-test']);
  });
});

describe('the owner’s gate, read from the stage', () => {
  /** A hand-made set whose verify lane is not owner-gated: it is still the owner's by its category. */
  const UNGATED_VERIFY: LaneSet = {
    projectId: PROJECT,
    version: 1,
    confirmedBy: 'owner',
    proposedBy: 'session-1',
    lanes: [
      lane('todo', 'backlog'),
      lane('doing', 'active', { enterOn: ['work.started'] }),
      lane('check', 'verify'),
      lane('after', 'shipped'),
      lane('closed', 'closed', { ownerGate: true }),
    ],
    variants: {},
    doneLane: 'closed',
    notGoodLane: 'doing',
  };
  const gated = (laneSet: LaneSet, from: string, to: string) => {
    const result = needsOwner(laneSet, from, to);
    return result.ok ? result.value : result.error;
  };

  it('should keep a move forward out of any verify lane for the owner, owner-gated or not', () => {
    should(gated(UNGATED_VERIFY, 'check', 'after')).be.true();
    should(gated(UNGATED_VERIFY, 'check', 'doing')).be.false();
    should(gated(UNGATED_VERIFY, 'doing', 'check')).be.false();
  });

  it('should keep a stored gate for the owner, and an owner-gated lane however it is staged', () => {
    // Arrange
    const staged: LaneSet = {
      ...UNGATED_VERIFY,
      lanes: UNGATED_VERIFY.lanes.map(entry => ({ ...entry, stage: laneStage(entry) })),
    };

    // Act + Assert
    should(gated(staged, 'check', 'after')).be.true();
    should(gated(staged, 'doing', 'after')).be.false();
    should(gated(FERRETRY, 'plan', 'implement')).be.true();
    should(gated(FERRETRY, 'implement', 'merged')).be.false();
  });
});
