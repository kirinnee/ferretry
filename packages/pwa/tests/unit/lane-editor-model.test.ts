import { describe, expect, it } from 'bun:test';
import {
  LANE_CATEGORIES,
  LANE_TEMPLATES,
  type Lane,
  LaneSetActionRequestSchema,
  LaneTriggerSchema,
  MAX_BOARD_LANES,
} from '@ferretry/protocol';
import {
  addLane,
  deleteLane,
  draftChanged,
  draftFromLaneSet,
  draftProblems,
  draftToEdit,
  freshLaneId,
  laneWriteMessage,
  type LaneDraft,
  moveLane,
  renameLane,
  setLaneCategory,
  setLaneOwnerGate,
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

  it('drops a stored stage when the fields it is read from change, so the saved lane is never refused for it', () => {
    const staged = draftFromLaneSet({ ...current, lanes: LANE_TEMPLATES['pr-release-verify'].lanes });
    const lane = (draft: LaneDraft, id: string) => draft.lanes.find(entry => entry.id === id) as Lane;
    const ungated = setLaneOwnerGate(staged, 'plan', false);
    expect(lane(ungated, 'plan').stage).toBeUndefined();
    expect(LaneSetActionRequestSchema.safeParse(draftToEdit(current, ungated)).success).toBe(true);
    expect(lane(setLaneTriggers(staged, 'merged', ['ci.green']), 'merged').stage).toBeUndefined();
    expect(lane(setLaneCategory(staged, 'merged', 'review'), 'merged').stage).toBeUndefined();
    expect(lane(setLaneTriggers(staged, 'plan', []), 'plan').stage).toEqual(lane(staged, 'plan').stage);
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
