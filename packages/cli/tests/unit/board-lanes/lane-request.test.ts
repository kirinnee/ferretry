import { describe, it } from 'bun:test';
import should from 'should';
import {
  buildEditRequest,
  buildProposeRequest,
  parseRenames,
  resolveBoardProject,
} from '../../../src/lib/board-lanes/lane-request';
import { FERRETRY_ID, laneSet, listing } from './fixtures';

describe('lane renames', () => {
  it('should read old=new pairs by lane id', () => {
    should(parseRenames(['todo=Backlog', ' review = Code review '])).eql({ todo: 'Backlog', review: 'Code review' });
  });

  it('should keep an equals sign inside the new name', () => {
    should(parseRenames(['todo=a=b'])).eql({ todo: 'a=b' });
  });

  it('should refuse a pair with no equals sign, no id or no name', () => {
    should(() => parseRenames(['todo'])).throw(/old=new/u);
    should(() => parseRenames(['=Backlog'])).throw(/old=new/u);
    should(() => parseRenames(['todo= '])).throw(/old=new/u);
  });

  it('should refuse an id that is not a lane id', () => {
    should(() => parseRenames(['Not An Id=Backlog'])).throw(/--rename is not usable/u);
  });

  it('should refuse naming one lane twice', () => {
    should(() => parseRenames(['todo=A', 'todo=B'])).throw(/more than once/u);
  });
});

describe('proposing lanes', () => {
  it('should build a propose request from a template and its renames', () => {
    should(buildProposeRequest({ template: 'quick', rename: ['doing=Working'] })).eql({
      action: 'propose',
      template: 'quick',
      renames: { doing: 'Working' },
    });
  });

  it('should propose with no renames by default', () => {
    should(buildProposeRequest({ template: 'pr' })).eql({ action: 'propose', template: 'pr', renames: {} });
  });

  it('should name the templates when the template is unknown or missing', () => {
    should(() => buildProposeRequest({ template: 'nope' })).throw(/pr-release-verify/u);
    should(() => buildProposeRequest({})).throw(/--template/u);
  });
});

describe('editing lanes', () => {
  const current = laneSet();

  it('should rename a lane without changing its id', () => {
    const request = buildEditRequest(current, { rename: ['todo=Backlog'] });
    if (request.action !== 'edit') throw new Error('expected an edit');
    should(request.version).equal(3);
    should(request.layout.lanes[0]).containEql({ id: 'todo', name: 'Backlog' });
    should(request.relocate).eql({});
  });

  it('should drop a removed lane from the lanes and every variant, and say where its cards go', () => {
    const request = buildEditRequest(current, { remove: ['plan'], into: 'implement' });
    if (request.action !== 'edit') throw new Error('expected an edit');
    should(request.layout.lanes.map(lane => lane.id)).not.containEql('plan');
    for (const ids of Object.values(request.layout.variants)) should(ids).not.containEql('plan');
    should(request.relocate).eql({ plan: 'implement' });
  });

  it('should drop a variant that would be left with no lanes', () => {
    const single = laneSet({ variants: { quick: ['plan'], 'design-first': ['todo', 'plan'] } });
    const request = buildEditRequest(single, { remove: ['plan'], into: 'todo' });
    if (request.action !== 'edit') throw new Error('expected an edit');
    should(request.layout.variants).eql({ 'design-first': ['todo'] });
  });

  it('should refuse a lane the set does not have', () => {
    should(() => buildEditRequest(current, { rename: ['ghost=Boo'] })).throw(/no lane ghost/u);
    should(() => buildEditRequest(current, { remove: ['ghost'], into: 'todo' })).throw(/no lane ghost/u);
  });

  it('should refuse an edit that changes nothing', () => {
    should(() => buildEditRequest(current, {})).throw(/nothing to edit/u);
  });

  it('should refuse renaming and removing the same lane', () => {
    should(() => buildEditRequest(current, { rename: ['plan=P'], remove: ['plan'], into: 'todo' })).throw(
      /both renamed and removed/u,
    );
  });

  it('should refuse a removal that does not say where the cards go', () => {
    should(() => buildEditRequest(current, { remove: ['plan'] })).throw(/--into/u);
  });

  it('should refuse --into without --remove', () => {
    should(() => buildEditRequest(current, { rename: ['todo=T'], into: 'todo' })).throw(/only goes with --remove/u);
  });

  it('should refuse sending cards to a lane that is unknown or removed', () => {
    should(() => buildEditRequest(current, { remove: ['plan'], into: 'ghost' })).throw(/must be a lane that stays/u);
    should(() => buildEditRequest(current, { remove: ['plan'], into: 'plan' })).throw(/must be a lane that stays/u);
  });
});

describe('resolving the board a command means', () => {
  it('should match a project by id', () => {
    should(resolveBoardProject(FERRETRY_ID, listing()).name).equal('Ferretry');
  });

  it('should match a project by name, ignoring case', () => {
    should(resolveBoardProject('  UNFILED ', listing()).id).equal('unfiled');
  });

  it('should default to the calling session’s board', () => {
    should(resolveBoardProject(undefined, listing({ current: FERRETRY_ID as never })).id).equal(FERRETRY_ID);
    should(resolveBoardProject('  ', listing({ current: FERRETRY_ID as never })).id).equal(FERRETRY_ID);
  });

  it('should list the boards when the named project is unknown', () => {
    should(() => resolveBoardProject('ghost', listing())).throw(/no project "ghost"; boards: Unfiled, Ferretry/u);
  });

  it('should ask for --project when the caller has no board', () => {
    should(() => resolveBoardProject(undefined, listing())).throw(/--project/u);
  });
});
