import { describe, expect, it } from 'bun:test';
import {
  EXTERNAL_LANE_TRIGGERS,
  gateOptions,
  LANE_CATEGORIES,
  LANE_TEMPLATES,
  type Lane,
  LaneSetActionRequestSchema,
  LaneTriggerSchema,
  MAX_BOARD_LANES,
  MAX_GATE_LABEL_LENGTH,
  MAX_GATE_OPTIONS,
  PLAN_GATE,
  VERIFY_GATE,
} from '@ferretry/protocol';
import {
  addGateOption,
  addLane,
  canSwitchStage,
  deleteLane,
  draftChanged,
  draftFromLaneSet,
  draftProblems,
  draftToEdit,
  freshLaneId,
  isReportedTrigger,
  laneStageKind,
  laneWriteMessage,
  type LaneDraft,
  moveLane,
  OUTCOME_LABELS,
  outcomeFromValue,
  outcomeValue,
  removeGateOption,
  renameLane,
  reopenTaken,
  setGateOptionLabel,
  setGateOptionOutcome,
  setLaneCategory,
  setLaneOwnerGate,
  setLaneStageKind,
  setLaneStaleAfter,
  setLaneTriggers,
  setWorkflowLane,
  TEMPLATE_LABELS,
  TRIGGER_LABELS,
  CATEGORY_LABELS,
  workflowLanes,
} from '../../src/lib/lane-editor-model.ts';
import { laneSetFor } from './board-support.ts';

const current = laneSetFor();
const start = (): LaneDraft => draftFromLaneSet(current);
const ids = (draft: LaneDraft): string[] => draft.lanes.map(lane => lane.id);
const messages = (draft: LaneDraft): string[] => draftProblems(current, draft).map(problem => problem.message);
const must = <T>(value: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!value.ok) throw new Error(`expected ok, got ${JSON.stringify(value.error)}`);
  return value.value;
};

describe('a fresh draft', () => {
  it('copies the lanes and variants, owes no relocation, and has no problems and no changes', () => {
    const draft = start();
    expect(ids(draft)).toEqual(current.lanes.map(lane => lane.id));
    expect(draft.relocate).toEqual({});
    expect(draftProblems(current, draft)).toEqual([]);
    expect(draftChanged(current, draft)).toBe(false);
  });
});

describe('reordering', () => {
  it('moves a lane one place, keeps variants in lane order, and stops at the ends', () => {
    const moved = moveLane(start(), 'review', -1);
    expect(ids(moved).slice(2, 4)).toEqual(['review', 'implement']);
    expect(workflowLanes(moved, 'design-first').slice(2, 4)).toEqual(['review', 'implement']);
    expect(draftChanged(current, moved)).toBe(true);
    expect(moveLane(start(), 'todo', -1)).toEqual(start());
    expect(moveLane(start(), 'closed', 1)).toEqual(start());
    expect(moveLane(start(), 'ghost', 1)).toEqual(start());
  });
});

describe('renaming and fields', () => {
  it('renames a lane without touching its id', () => {
    const renamed = renameLane(start(), 'review', 'Code review');
    expect(renamed.lanes.find(lane => lane.id === 'review')?.name).toBe('Code review');
    expect(ids(renamed)).toEqual(ids(start()));
    expect(draftToEdit(current, renamed)).toMatchObject({ action: 'edit', version: current.version });
  });

  it('changes category, triggers, owner gate and staleness, and removes a field when it is emptied', () => {
    let draft = setLaneCategory(start(), 'merged', 'review');
    draft = setLaneTriggers(draft, 'merged', ['pr.merged', 'ci.green']);
    draft = setLaneOwnerGate(draft, 'merged', true);
    draft = setLaneStaleAfter(draft, 'merged', ' 5d ');
    const merged = draft.lanes.find(lane => lane.id === 'merged') as Lane;
    expect(merged).toMatchObject({
      category: 'review',
      enterOn: ['pr.merged', 'ci.green'],
      ownerGate: true,
      staleAfter: '5d',
    });
    draft = setLaneTriggers(draft, 'merged', []);
    draft = setLaneOwnerGate(draft, 'merged', false);
    draft = setLaneStaleAfter(draft, 'merged', '  ');
    const bare = draft.lanes.find(lane => lane.id === 'merged') as Lane;
    expect(bare).toEqual({ id: 'merged', name: 'Merged', category: 'review' });
  });

  it('lets a lane’s emphasis follow its new category, so a changed lane is never refused for it', () => {
    const emphatic = {
      ...start(),
      lanes: start().lanes.map(lane => (lane.id === 'merged' ? { ...lane, emphasis: 'info' as const } : lane)),
    };
    const draft = setLaneCategory(emphatic, 'merged', 'verify');
    expect(draft.lanes.find(lane => lane.id === 'merged')?.emphasis).toBeUndefined();
  });

  it('drops a stored stage when the owner gate it mirrors is changed by hand, so the saved lane is never refused for it', () => {
    const staged = draftFromLaneSet({ ...current, lanes: LANE_TEMPLATES['pr-release-verify'].lanes });
    const ungated = setLaneOwnerGate(staged, 'plan', false);
    expect(ungated.lanes.find(entry => entry.id === 'plan')?.stage).toBeUndefined();
    expect(LaneSetActionRequestSchema.safeParse(draftToEdit(current, ungated)).success).toBe(true);
  });

  it('counts a change undone as no change, whatever order the fields were put back in', () => {
    let draft = setLaneStaleAfter(start(), 'merged', '9d');
    draft = setLaneStaleAfter(draft, 'merged', '3d');
    expect(draftChanged(current, draft)).toBe(false);
  });
});

describe('adding', () => {
  it('adds an active lane before the closed one and into every workflow that has a list', () => {
    const added = addLane(start());
    expect(ids(added).slice(-2)).toEqual(['new-lane', 'closed']);
    expect(added.lanes.find(lane => lane.id === 'new-lane')).toMatchObject({ name: 'New lane', category: 'active' });
    expect(workflowLanes(added, 'quick')).toContain('new-lane');
    expect(workflowLanes(added, 'design-first').slice(-2)).toEqual(['new-lane', 'closed']);
    expect(messages(added)).toEqual([]);
  });

  it('gives each new lane an id no lane has, and appends when there is no closed lane', () => {
    const twice = addLane(addLane(start()));
    expect(ids(twice).filter(id => id.startsWith('new-lane'))).toEqual(['new-lane', 'new-lane-2']);
    expect(freshLaneId(current.lanes, 'Plan/Design')).toBe('plan-design');
    expect(freshLaneId(current.lanes, 'Todo')).toBe('todo-2');
    expect(freshLaneId(current.lanes, '!!!')).toBe('lane');
    expect(freshLaneId(current.lanes, '2nd pass')).toBe('lane-2nd-pass');
    expect(freshLaneId([], 'x'.repeat(60)).length).toBeLessThanOrEqual(32);
    const open = { ...start(), lanes: start().lanes.filter(lane => lane.category !== 'closed') };
    expect(ids(addLane(open)).at(-1)).toBe('new-lane');
  });

  it('stops at the most lanes a board may have', () => {
    let draft = start();
    for (let count = 0; count < MAX_BOARD_LANES; count += 1) draft = addLane(draft);
    expect(draft.lanes).toHaveLength(MAX_BOARD_LANES);
    expect(addLane(draft)).toBe(draft);
  });
});

describe('deleting needs a place for the cards', () => {
  it('removes the lane, from the variants too, and records where its cards go', () => {
    const deleted = must(deleteLane(start(), 'merged', 'review'));
    expect(ids(deleted)).not.toContain('merged');
    expect(workflowLanes(deleted, 'design-first')).not.toContain('merged');
    expect(deleted.relocate).toEqual({ merged: 'review' });
    expect(messages(deleted)).toEqual([]);
    expect(draftChanged(current, deleted)).toBe(true);
  });

  it('follows a chain: cards promised to a lane that is deleted next go to the new target', () => {
    const first = must(deleteLane(start(), 'merged', 'released'));
    const second = must(deleteLane(first, 'released', 'tested'));
    expect(second.relocate).toEqual({ merged: 'tested', released: 'tested' });
    expect(Object.values(second.relocate).every(to => ids(second).includes(to))).toBe(true);
  });

  it('refuses an unknown lane, an unknown target, itself as the target, and the last lane', () => {
    expect(deleteLane(start(), 'ghost', 'todo')).toEqual({
      ok: false,
      error: { code: 'unknown-lane', laneId: 'ghost' },
    });
    expect(deleteLane(start(), 'merged', 'ghost')).toEqual({
      ok: false,
      error: { code: 'unknown-target', laneId: 'ghost' },
    });
    expect(deleteLane(start(), 'merged', 'merged')).toEqual({
      ok: false,
      error: { code: 'unknown-target', laneId: 'merged' },
    });
    const lone = { ...start(), lanes: [start().lanes[0] as Lane], variants: {} };
    expect(deleteLane(lone, 'todo', 'todo')).toEqual({ ok: false, error: { code: 'last-lane' } });
  });

  it('says so, live, when a lane is dropped with no relocation', () => {
    const dropped: LaneDraft = { ...start(), lanes: start().lanes.filter(lane => lane.id !== 'review') };
    expect(messages(dropped)).toContain('Lane "Review/CI" was removed: choose where its cards go.');
    const placed: LaneDraft = { ...dropped, relocate: { review: 'implement' } };
    expect(messages(placed)).not.toContain('Lane "Review/CI" was removed: choose where its cards go.');
  });
});

describe('workflow variants', () => {
  it('shows the lanes a workflow walks, or every lane when it has no list', () => {
    expect(workflowLanes(start(), 'quick')).not.toContain('plan');
    const bare: LaneDraft = { ...start(), variants: {} };
    expect(workflowLanes(bare, 'quick')).toEqual(ids(bare));
  });

  it('puts a lane in or out of one workflow, keeps lane order, and keeps at least one lane', () => {
    const out = setWorkflowLane(start(), 'design-first', 'review', false);
    expect(workflowLanes(out, 'design-first')).not.toContain('review');
    expect(workflowLanes(out, 'quick')).toContain('review');
    const back = setWorkflowLane(out, 'design-first', 'review', true);
    expect(workflowLanes(back, 'design-first')).toEqual(workflowLanes(start(), 'design-first'));
    const same = start();
    expect(setWorkflowLane(same, 'design-first', 'review', true)).toBe(same);
  });

  it('leaves the last lane of a workflow in', () => {
    const single: LaneDraft = { ...start(), variants: { quick: ['todo'] } };
    expect(setWorkflowLane(single, 'quick', 'todo', false)).toBe(single);
  });

  it('turns a workflow with no list into one when a lane is taken out', () => {
    const bare: LaneDraft = { ...start(), variants: {} };
    const quick = setWorkflowLane(bare, 'quick', 'plan', false);
    expect(quick.variants.quick).not.toContain('plan');
    expect(quick.variants.quick).toContain('todo');
  });
});

describe('live validation', () => {
  it('names a blank or over-long lane name and a bad duration against the lane', () => {
    let draft = renameLane(start(), 'todo', '  ');
    draft = renameLane(draft, 'plan', 'x'.repeat(41));
    draft = setLaneStaleAfter(draft, 'implement', 'soon');
    const found = draftProblems(current, draft);
    expect(found).toContainEqual({ laneId: 'todo', message: 'A lane needs a name.' });
    expect(found).toContainEqual({ laneId: 'plan', message: 'A lane name is one line of at most 40 characters.' });
    expect(found).toContainEqual({ laneId: 'implement', message: '"soon" is not a duration like 30m, 2h or 3d.' });
  });

  it('reports the protocol’s layout rules in sentences', () => {
    let draft = setLaneCategory(start(), 'todo', 'active');
    expect(messages(draft)).toContain('A lane set needs at least one backlog lane.');
    draft = setLaneCategory(start(), 'merged', 'closed');
    expect(messages(draft)).toContain('A lane set needs exactly one closed lane.');
    draft = setLaneOwnerGate(start(), 'closed', false);
    expect(messages(draft)).toContain('The closed lane is owner-gated in a set that has a verify lane.');
  });

  it('refuses more lanes than a board may have', () => {
    const many: LaneDraft = {
      ...start(),
      lanes: Array.from({ length: MAX_BOARD_LANES + 1 }, (_, index) => ({
        id: `lane-${String(index)}`,
        name: `Lane ${String(index)}`,
        category: index === 0 ? ('backlog' as const) : index === 1 ? ('closed' as const) : ('active' as const),
      })),
      variants: {},
    };
    expect(draftProblems(current, many)).toContainEqual({ laneId: null, message: 'A board has at most 16 lanes.' });
  });
});

describe('saving', () => {
  it('builds an edit the protocol accepts, with trimmed names and the relocations', () => {
    const draft = must(deleteLane(renameLane(start(), 'review', '  Code review '), 'merged', 'review'));
    const request = draftToEdit(current, draft);
    const parsed = LaneSetActionRequestSchema.parse(request);
    expect(parsed).toMatchObject({ action: 'edit', version: current.version, relocate: { merged: 'review' } });
    expect(parsed.action === 'edit' && parsed.layout.lanes.find(lane => lane.id === 'review')?.name).toBe(
      'Code review',
    );
  });

  it('is the quick template’s own layout when nothing was changed', () => {
    const quick = { ...current, lanes: LANE_TEMPLATES.quick.lanes, variants: LANE_TEMPLATES.quick.variants };
    expect(draftChanged(quick, draftFromLaneSet(quick))).toBe(false);
  });
});

describe('what a refused write says', () => {
  it('turns the daemon’s code into a sentence and falls back to its own message', () => {
    const say = (code: string | null) => laneWriteMessage({ code, message: 'daemon said so' });
    expect(say('version-conflict')).toContain('changed since you opened');
    expect(say('owner-only')).toContain('Only the owner');
    expect(say('already-confirmed')).toContain('already confirmed');
    expect(say('relocation-missing')).toContain('place for its cards');
    expect(say('no-machine')).toContain('no longer paired');
    expect(say(null)).toBe('daemon said so');
    expect(say('weird')).toBe('daemon said so');
  });

  it('names every template', () => {
    expect(Object.keys(TEMPLATE_LABELS).sort()).toEqual(Object.keys(LANE_TEMPLATES).sort());
  });
});

describe('the words the editor uses', () => {
  it('has a plain-words label for every trigger, none of them a machine id', () => {
    expect(Object.keys(TRIGGER_LABELS).sort()).toEqual([...LaneTriggerSchema.options].sort());
    for (const label of Object.values(TRIGGER_LABELS)) expect(label).not.toMatch(/[a-z]\.[a-z]/);
    expect(TRIGGER_LABELS['release.running']).toBe('this machine runs that release');
    expect(TRIGGER_LABELS['deploy.done']).toBe('a deploy is reported done');
  });

  it('has a label for every lane category', () => {
    expect(Object.keys(CATEGORY_LABELS).sort()).toEqual([...LANE_CATEGORIES].sort());
    expect(CATEGORY_LABELS.verify).toBe('To test (verify)');
    expect(CATEGORY_LABELS.review).toBe('In review');
  });
});

const fromTemplate = (name: keyof typeof LANE_TEMPLATES): LaneDraft =>
  draftFromLaneSet({ ...current, lanes: LANE_TEMPLATES[name].lanes, variants: LANE_TEMPLATES[name].variants });
const laneOf = (draft: LaneDraft, id: string): Lane => {
  const found = draft.lanes.find(entry => entry.id === id);
  if (found === undefined) throw new Error(`no lane ${id}`);
  return found;
};
const accepted = (draft: LaneDraft): boolean =>
  LaneSetActionRequestSchema.safeParse(draftToEdit(current, draft)).success;

describe('a lane’s stage', () => {
  it('reads the stage a lane stores, else the one its fields describe', () => {
    const template = fromTemplate('pr-release-verify');
    expect(laneStageKind(laneOf(template, 'plan'))).toBe('gate');
    expect(laneStageKind(laneOf(template, 'implement'))).toBe('auto');
    expect(laneStageKind(laneOf(start(), 'tested'))).toBe('gate');
    expect(laneStageKind(laneOf(start(), 'todo'))).toBe('auto');
  });

  it('gives a closed lane no stage switch: only the owner closes', () => {
    expect(canSwitchStage(laneOf(start(), 'closed'))).toBe(false);
    expect(canSwitchStage(laneOf(start(), 'implement'))).toBe(true);
    expect(setLaneStageKind(start(), 'closed', 'gate')).toEqual(start());
    expect(setLaneStageKind(start(), 'ghost', 'gate')).toEqual(start());
  });

  it('switches a non-verify lane to a plan gate and owner-gates it; back to automatic clears the gate', () => {
    const gated = setLaneStageKind(start(), 'implement', 'gate');
    expect(laneOf(gated, 'implement').stage).toEqual(PLAN_GATE);
    expect(laneOf(gated, 'implement').ownerGate).toBe(true);
    expect(accepted(gated)).toBe(true);
    const back = setLaneStageKind(gated, 'implement', 'auto');
    expect(laneOf(back, 'implement').stage).toEqual({ kind: 'auto', triggers: ['work.started'] });
    expect(laneOf(back, 'implement').ownerGate).toBeUndefined();
    expect(accepted(back)).toBe(true);
  });

  it('switches a verify lane to the verify gate without forcing the owner gate, and back', () => {
    const template = fromTemplate('quick');
    const auto = setLaneStageKind(template, 'to-test', 'auto');
    expect(laneOf(auto, 'to-test').stage).toEqual({
      kind: 'auto',
      triggers: ['pr.merged', 'release.published', 'signal.done'],
    });
    expect(laneOf(auto, 'to-test').ownerGate).toBeUndefined();
    expect(accepted(auto)).toBe(true);
    const gate = setLaneStageKind(auto, 'to-test', 'gate');
    expect(laneOf(gate, 'to-test').stage).toEqual(VERIFY_GATE);
    expect(accepted(gate)).toBe(true);
  });

  it('does nothing when the lane already is that stage', () => {
    expect(setLaneStageKind(fromTemplate('pr-release-verify'), 'plan', 'gate')).toEqual(
      fromTemplate('pr-release-verify'),
    );
    expect(setLaneStageKind(start(), 'todo', 'auto')).toEqual(start());
  });

  it('lets the lane’s emphasis follow its new stage', () => {
    const template = fromTemplate('pr-release-verify');
    expect(laneOf(setLaneStageKind(template, 'plan', 'auto'), 'plan').emphasis).toBeUndefined();
  });

  it('keeps an automatic stage’s triggers the lane’s own, and a gate’s entry triggers apart from its options', () => {
    const template = fromTemplate('pr-release-verify');
    const retimed = setLaneTriggers(template, 'implement', ['pr.opened']);
    expect(laneOf(retimed, 'implement').stage).toEqual({ kind: 'auto', triggers: ['pr.opened'] });
    expect(laneOf(retimed, 'implement').enterOn).toEqual(['pr.opened']);
    expect(accepted(retimed)).toBe(true);
    const emptied = setLaneTriggers(template, 'implement', []);
    expect(laneOf(emptied, 'implement').stage).toEqual({ kind: 'auto', triggers: [] });
    expect(laneOf(emptied, 'implement').enterOn).toBeUndefined();
    expect(accepted(emptied)).toBe(true);
    const gateEntry = setLaneTriggers(template, 'plan', ['ci.green']);
    expect(laneOf(gateEntry, 'plan').stage).toEqual(laneOf(template, 'plan').stage);
    expect(accepted(gateEntry)).toBe(true);
  });

  it('keeps the options through a category change, and refuses a gate on the closed lane', () => {
    const template = fromTemplate('pr-release-verify');
    const verify = setLaneCategory(setLaneStageKind(template, 'plan', 'gate'), 'plan', 'verify');
    expect(laneOf(verify, 'plan').stage).toEqual(PLAN_GATE);
    const active = setLaneCategory(template, 'released', 'active');
    expect(laneOf(active, 'released').stage).toEqual(VERIFY_GATE);
    expect(laneOf(active, 'released').ownerGate).toBe(true);
    expect(accepted(active)).toBe(true);
    const shipped = setLaneCategory(template, 'merged', 'review');
    expect(laneOf(shipped, 'merged').stage).toEqual(laneOf(template, 'merged').stage);
    const closing = setLaneCategory(template, 'plan', 'closed');
    expect(laneOf(closing, 'plan').stage).toBeUndefined();
  });
});

describe('a gate’s options', () => {
  const plan = (): LaneDraft => fromTemplate('pr-release-verify');
  const options = (draft: LaneDraft, id = 'plan') => gateOptions(laneOf(draft, id));

  it('adds options up to the most a gate may have, each with an id no option has', () => {
    let draft = plan();
    draft = addGateOption(draft, 'plan');
    draft = addGateOption(draft, 'plan');
    expect(options(draft).map(option => option.id)).toEqual(['ok', 'option', 'option-2']);
    expect(options(draft)).toHaveLength(MAX_GATE_OPTIONS);
    expect(addGateOption(draft, 'plan')).toEqual(draft);
    expect(options(draft)[1]).toEqual({ id: 'option', label: 'Option', outcome: { kind: 'next' } });
    expect(accepted(draft)).toBe(true);
  });

  it('removes an option but never the last one', () => {
    const two = addGateOption(plan(), 'plan');
    const one = removeGateOption(two, 'plan', 'option');
    expect(options(one).map(option => option.id)).toEqual(['ok']);
    expect(removeGateOption(one, 'plan', 'ok')).toEqual(one);
  });

  it('relabels an option without changing its id', () => {
    const draft = setGateOptionLabel(plan(), 'plan', 'ok', 'Go build');
    expect(options(draft)[0]).toEqual({ id: 'ok', label: 'Go build', outcome: { kind: 'next' } });
    expect(
      draftToEdit(current, setGateOptionLabel(plan(), 'plan', 'ok', '  Go  ')).layout.lanes.find(l => l.id === 'plan')
        ?.stage,
    ).toEqual({ kind: 'gate', options: [{ id: 'ok', label: 'Go', outcome: { kind: 'next' } }] });
  });

  it('points an option at the next lane, a named lane, a reopen or a close', () => {
    let draft = plan();
    draft = setGateOptionOutcome(draft, 'plan', 'ok', { kind: 'lane', laneId: 'implement' });
    expect(options(draft)[0]?.outcome).toEqual({ kind: 'lane', laneId: 'implement' });
    draft = setGateOptionOutcome(draft, 'plan', 'ok', { kind: 'close' });
    expect(options(draft)[0]?.outcome).toEqual({ kind: 'close' });
    draft = setGateOptionOutcome(draft, 'plan', 'ok', { kind: 'reopen-with-agenda' });
    expect(options(draft)[0]?.outcome).toEqual({ kind: 'reopen-with-agenda' });
    expect(accepted(draft)).toBe(true);
  });

  it('allows one reopen with a conversation, and a lane that is not its own', () => {
    const two = setGateOptionOutcome(addGateOption(plan(), 'plan'), 'plan', 'ok', { kind: 'reopen-with-agenda' });
    expect(reopenTaken(laneOf(two, 'plan'), 'option')).toBe(true);
    expect(reopenTaken(laneOf(two, 'plan'), 'ok')).toBe(false);
    expect(setGateOptionOutcome(two, 'plan', 'option', { kind: 'reopen-with-agenda' })).toEqual(two);
    expect(setGateOptionOutcome(plan(), 'plan', 'ok', { kind: 'lane', laneId: 'plan' })).toEqual(plan());
  });

  it('edits the derived gate of a lane that stores none, and leaves an automatic lane alone', () => {
    const classic = addGateOption(start(), 'tested');
    expect(options(classic, 'tested').map(option => option.id)).toEqual(['done', 'not-good', 'option']);
    expect(accepted(classic)).toBe(true);
    expect(addGateOption(start(), 'implement')).toEqual(start());
    expect(setGateOptionLabel(start(), 'implement', 'ok', 'x')).toEqual(start());
  });

  it('sends a deleted lane’s gate options to where its cards go, or on when that is the gate’s own lane', () => {
    const named = setGateOptionOutcome(plan(), 'plan', 'ok', { kind: 'lane', laneId: 'implement' });
    const moved = must(deleteLane(named, 'implement', 'merged'));
    expect(options(moved)[0]?.outcome).toEqual({ kind: 'lane', laneId: 'merged' });
    const own = must(deleteLane(named, 'implement', 'plan'));
    expect(options(own)[0]?.outcome).toEqual({ kind: 'next' });
  });

  it('names a blank or over-long option label against its lane', () => {
    const blank = setGateOptionLabel(plan(), 'plan', 'ok', '   ');
    expect(draftProblems(current, blank)).toContainEqual({ laneId: 'plan', message: 'An option needs a label.' });
    const long = setGateOptionLabel(plan(), 'plan', 'ok', 'x'.repeat(MAX_GATE_LABEL_LENGTH + 1));
    expect(draftProblems(current, long)).toContainEqual({
      laneId: 'plan',
      message: `An option label is one line of at most ${String(MAX_GATE_LABEL_LENGTH)} characters.`,
    });
    expect(draftProblems(current, plan()).filter(problem => problem.laneId === 'plan')).toEqual([]);
  });
});

describe('the words for a gate', () => {
  it('round-trips each outcome through the value a picker holds', () => {
    for (const outcome of [
      { kind: 'next' },
      { kind: 'lane', laneId: 'merged' },
      { kind: 'reopen-with-agenda' },
      { kind: 'close' },
    ] as const) {
      expect(outcomeFromValue(outcomeValue(outcome))).toEqual(outcome);
    }
    expect(outcomeFromValue('nonsense')).toBeNull();
    expect(outcomeFromValue('lane:')).toBeNull();
  });

  it('says every outcome in plain words, and marks only the reported triggers', () => {
    expect(OUTCOME_LABELS).toEqual({
      next: 'Next lane',
      lane: 'A specific lane',
      'reopen-with-agenda': 'Not good (reopen and talk)',
      close: 'Close',
    });
    expect(LaneTriggerSchema.options.filter(isReportedTrigger).sort()).toEqual([...EXTERNAL_LANE_TRIGGERS].sort());
  });
});
