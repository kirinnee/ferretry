import { describe, it } from 'bun:test';
import { LANE_TEMPLATES, type LaneLayoutValue, type LaneSet, UNFILED_PROJECT_ID } from '@ferretry/protocol';
import should from 'should';
import {
  actorName,
  confirmLaneSet,
  describeLaneSetFailure,
  editLaneSet,
  type LaneActor,
  noLaneSetMessage,
  proposeLaneSet,
  unfiledLaneSet,
} from '../../../src/lib/board-projects/index.ts';
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
