import { describe, it } from 'bun:test';
import should from 'should';
import { renderWorkflow } from '../../../src/lib/board-lanes/workflow-render';
import {
  buildWorkflowEditRequest,
  parseGateOption,
  parseTriggers,
} from '../../../src/lib/board-lanes/workflow-request';
import { laneSet, project } from './fixtures';

describe('gate options', () => {
  it('should read a label and an outcome into an option with a dashed id', () => {
    // Arrange / Act
    const option = parseGateOption('Not good=reopen');

    // Assert
    should(option).eql({ id: 'not-good', label: 'Not good', outcome: { kind: 'reopen-with-agenda' } });
  });

  it('should read each outcome word', () => {
    should(parseGateOption('Go=next').outcome).eql({ kind: 'next' });
    should(parseGateOption('Done=close').outcome).eql({ kind: 'close' });
    should(parseGateOption('Back=lane:todo').outcome).eql({ kind: 'lane', laneId: 'todo' });
  });

  it('should refuse an option with no label, no outcome or an unknown outcome', () => {
    should(() => parseGateOption('next')).throw(/--gate takes/u);
    should(() => parseGateOption('=next')).throw(/--gate takes/u);
    should(() => parseGateOption('Go=sideways')).throw(/--gate takes/u);
    should(() => parseGateOption('Go=lane:')).throw(/--gate takes/u);
  });

  it('should refuse a label longer than a button can hold', () => {
    should(() => parseGateOption(`${'x'.repeat(25)}=next`)).throw(/not usable/u);
  });
});

describe('automatic triggers', () => {
  it('should read a comma list', () => {
    should(parseTriggers('pr.opened, ci.green')).eql(['pr.opened', 'ci.green']);
  });

  it('should read none as no trigger', () => {
    should(parseTriggers('none')).eql([]);
  });

  it('should name the triggers when one is unknown', () => {
    should(() => parseTriggers('pr.opened,teleport')).throw(/teleport.*deploy\.done/u);
  });

  it('should refuse an empty list', () => {
    should(() => parseTriggers(' , ')).throw(/--auto takes/u);
  });
});

describe('editing a stage', () => {
  const current = laneSet();

  it('should make a lane a gate and keep every other lane and the version it read', () => {
    // Arrange / Act
    const request = buildWorkflowEditRequest(current, {
      lane: 'implement',
      gate: ['Ship it=next', 'Rework=lane:todo'],
    });

    // Assert
    if (request.action !== 'edit') throw new Error('expected an edit');
    should(request.version).equal(3);
    const edited = request.layout.lanes.find(lane => lane.id === 'implement');
    should(edited?.stage).eql({
      kind: 'gate',
      options: [
        { id: 'ship-it', label: 'Ship it', outcome: { kind: 'next' } },
        { id: 'rework', label: 'Rework', outcome: { kind: 'lane', laneId: 'todo' } },
      ],
    });
    should(edited?.ownerGate).equal(true);
    should(request.layout.lanes.filter(lane => lane.id !== 'implement')).eql(
      current.lanes.filter(lane => lane.id !== 'implement'),
    );
    should(request.relocate).eql({});
  });

  it('should make an owner-gated lane automatic and drop its gate mirror', () => {
    // Arrange / Act
    const request = buildWorkflowEditRequest(current, { lane: 'plan', auto: 'work.started' });

    // Assert
    if (request.action !== 'edit') throw new Error('expected an edit');
    const edited = request.layout.lanes.find(lane => lane.id === 'plan');
    should(edited?.stage).eql({ kind: 'auto', triggers: ['work.started'] });
    should(edited?.ownerGate).be.undefined();
    should(edited?.enterOn).eql(['work.started']);
  });

  it('should leave a lane with no trigger without enterOn', () => {
    const request = buildWorkflowEditRequest(current, { lane: 'implement', auto: 'none' });
    if (request.action !== 'edit') throw new Error('expected an edit');
    const edited = request.layout.lanes.find(lane => lane.id === 'implement');
    should(edited?.stage).eql({ kind: 'auto', triggers: [] });
    should(edited?.enterOn).be.undefined();
  });

  it('should say which lane, and which lanes exist, when the lane is missing or unknown', () => {
    should(() => buildWorkflowEditRequest(current, { gate: ['Go=next'] })).throw(/--lane <id>/u);
    should(() => buildWorkflowEditRequest(current, { lane: 'nope', gate: ['Go=next'] })).throw(/no lane nope.*todo/u);
  });

  it('should refuse a gate and an automatic step together, and neither', () => {
    should(() => buildWorkflowEditRequest(current, { lane: 'plan', gate: ['Go=next'], auto: 'none' })).throw(
      /not both/u,
    );
    should(() => buildWorkflowEditRequest(current, { lane: 'plan' })).throw(/nothing to edit/u);
  });

  it('should refuse more than three options, a repeated option and two reopens', () => {
    should(() =>
      buildWorkflowEditRequest(current, { lane: 'plan', gate: ['A=next', 'B=next', 'C=next', 'D=next'] }),
    ).throw(/not usable/u);
    should(() => buildWorkflowEditRequest(current, { lane: 'plan', gate: ['A=next', 'a=close'] })).throw(/unique/u);
    should(() => buildWorkflowEditRequest(current, { lane: 'plan', gate: ['A=reopen', 'B=reopen'] })).throw(
      /at most once/u,
    );
  });
});

describe('rendering a workflow', () => {
  it('should list each lane in order as a gate with its options or an automatic step', () => {
    // Arrange / Act
    const text = renderWorkflow(project(), 'fy');

    // Assert
    const rows = text.split('\n');
    should(rows[0]).equal('Ferretry workflow, lanes version 3');
    should(rows[1]).match(/^ {2}todo\tTodo\tAUTO\t/u);
    should(rows[2]).equal('  plan\tPlan/Design\tGATE\tOK to build → the next lane');
    should(rows[3]).match(
      /^ {2}implement\tIn progress\tAUTO\t.*moves in when a session starts on it or a PR opens or a PR is ready/u,
    );
  });

  it('should say a lane with no trigger is moved by the ferret', () => {
    const text = renderWorkflow(project(), 'fy');
    should(text.split('\n')[1]).match(/not started yet/u);
  });

  it('should say where each kind of option sends the card', () => {
    // Arrange
    const current = laneSet();
    const edit = buildWorkflowEditRequest(current, {
      lane: 'implement',
      gate: ['Close it=close', 'Rework=reopen', 'Park=lane:todo'],
    });
    if (edit.action !== 'edit') throw new Error('expected an edit');

    // Act
    const text = renderWorkflow(project({ laneSet: { ...current, lanes: edit.layout.lanes } }), 'fy');

    // Assert
    should(text)
      .match(/Close it → Merged \(closed\)/u)
      .and.match(/Rework → In progress, with the owner's words/u)
      .and.match(/Park → Todo/u);
  });

  it('should name a lane by its id when the option points at one the set does not have', () => {
    const current = laneSet();
    const edit = buildWorkflowEditRequest(current, { lane: 'implement', gate: ['Away=lane:gone'] });
    if (edit.action !== 'edit') throw new Error('expected an edit');
    should(renderWorkflow(project({ laneSet: { ...current, lanes: edit.layout.lanes } }), 'fy')).match(/Away → gone/u);
  });

  it('should say how to propose lanes when a project has none', () => {
    should(renderWorkflow(project({ laneSet: null }), 'fy')).match(/no lanes yet.*fy board lanes propose/u);
  });
});
