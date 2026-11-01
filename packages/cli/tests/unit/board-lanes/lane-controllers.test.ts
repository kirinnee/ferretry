import { describe, it } from 'bun:test';
import type {
  BoardProject,
  BoardProjectId,
  BoardSwitch,
  LaneSetActionRequest,
  LaneSetChangeResponse,
} from '@ferretry/protocol';
import should from 'should';
import { LaneController } from '../../../src/lib/board-lanes/lane-controllers';
import {
  renderBoardLanes,
  renderBoardSwitch,
  renderLaneChange,
  renderLaneSet,
} from '../../../src/lib/board-lanes/lane-render';
import type { ILaneGateway } from '../../../src/lib/board-lanes/ports';
import { FERRETRY_ID, laneSet, listing, project } from './fixtures';

class FakeGateway implements ILaneGateway {
  readonly changes: { projectId: BoardProjectId; request: LaneSetActionRequest }[] = [];

  constructor(
    private readonly board: BoardProject = project(),
    private readonly agenda: LaneSetChangeResponse['agenda'] = 'raised',
  ) {}

  projects() {
    return Promise.resolve(listing({ current: this.board.id }));
  }

  project() {
    return Promise.resolve(this.board);
  }

  change(projectId: BoardProjectId, request: LaneSetActionRequest) {
    this.changes.push({ projectId, request });
    return Promise.resolve({ laneSet: laneSet({ version: 4 }), agenda: this.agenda });
  }

  readonly switches: { projectId: BoardProjectId; on: boolean }[] = [];

  switchOf(projectId: BoardProjectId): Promise<BoardSwitch> {
    return Promise.resolve({ projectId, on: true, setBy: 'migration', setAt: '2026-11-01T12:00:00.000Z' });
  }

  setSwitch(projectId: BoardProjectId, on: boolean): Promise<BoardSwitch> {
    this.switches.push({ projectId, on });
    return Promise.resolve({ projectId, on, setBy: 'owner', setAt: '2026-11-01T12:00:00.000Z' });
  }
}

const harness = (gateway = new FakeGateway()) => {
  const lines: string[] = [];
  return { gateway, lines, controller: new LaneController(gateway, { success: line => lines.push(line) }, 'fy') };
};

describe('fy board lanes propose', () => {
  it('should propose for the calling session’s board and say the owner was asked', async () => {
    const { controller, gateway, lines } = harness();
    await controller.propose({ json: false }, { template: 'pr' });
    should(gateway.changes).eql([
      { projectId: FERRETRY_ID, request: { action: 'propose', template: 'pr', renames: {} } },
    ]);
    should(lines[0])
      .match(/Ferretry lanes, version 4/u)
      .and.match(/Accept \/ Edit choice/u);
  });

  it('should print the daemon’s answer as JSON on request', async () => {
    const { controller, lines } = harness();
    await controller.propose({ json: true, project: 'Ferretry' }, { template: 'pr' });
    should(JSON.parse(lines[0] ?? '')).containEql({ agenda: 'raised' });
  });
});

describe('fy board lanes show', () => {
  it('should print the lanes with their ids', async () => {
    const { controller, lines } = harness();
    await controller.show({ json: false });
    should(lines[0])
      .match(/todo\tTodo\t\(backlog\)/u)
      .and.match(/not yet confirmed/u);
  });

  it('should print the project as JSON on request', async () => {
    const { controller, lines } = harness();
    await controller.show({ json: true });
    should(JSON.parse(lines[0] ?? '')).containEql({ id: FERRETRY_ID });
  });

  it('should give the command to run when the project has no lanes', async () => {
    const { controller, lines } = harness(new FakeGateway(project({ laneSet: null })));
    await controller.show({ json: false });
    should(lines[0]).match(
      /has no lanes yet\. Propose them: fy board lanes propose --template <template> --project Ferretry/u,
    );
  });
});

describe('fy board status, on and off', () => {
  it("should say whether the calling session's board is on, and who set it", async () => {
    const { controller, lines } = harness();
    await controller.status({ json: false });
    should(lines[0]).equal(
      'Ferretry: board on — set when the board became opt-in (2026-11-01T12:00:00.000Z).\nFerrets here keep a card for their work.',
    );
  });

  it("should throw the owner's switch and print the daemon's answer", async () => {
    const { controller, gateway, lines } = harness();
    await controller.turn({ json: false, project: 'Ferretry' }, false);
    await controller.turn({ json: true }, true);
    should(gateway.switches).eql([
      { projectId: FERRETRY_ID, on: false },
      { projectId: FERRETRY_ID, on: true },
    ]);
    should(lines[0])
      .match(/^Ferretry: board off — set by the owner/u)
      .and.match(/fy board on --project Ferretry$/u);
    should(JSON.parse(lines[1] ?? '')).containEql({ on: true });
  });

  it('should spell a board nobody decided, and a time it does not know', () => {
    should(
      renderBoardSwitch({ projectId: FERRETRY_ID as never, on: false, setBy: 'default', setAt: null }, 'Docs', 'fy'),
    ).startWith('Docs: board off — nobody switched it on.');
    should(
      renderBoardSwitch({ projectId: FERRETRY_ID as never, on: true, setBy: 'owner', setAt: null }, 'Docs', 'fy'),
    ).startWith('Docs: board on — set by the owner (unknown).');
    should(
      renderBoardSwitch({ projectId: FERRETRY_ID as never, on: true, setBy: 'migration', setAt: null }, 'Docs', 'fy'),
    ).startWith('Docs: board on — set when the board became opt-in (unknown).');
  });
});

describe('fy board lanes edit', () => {
  it('should edit against the version it just read', async () => {
    const { controller, gateway, lines } = harness();
    await controller.edit({ json: false }, { rename: ['todo=Backlog'] });
    const request = gateway.changes[0]?.request;
    should(request).containEql({ action: 'edit', version: 3 });
    should(lines[0]).match(/version 4/u);
  });

  it('should print JSON on request', async () => {
    const { controller, lines } = harness();
    await controller.edit({ json: true }, { rename: ['todo=Backlog'] });
    should(JSON.parse(lines[0] ?? '')).containEql({ agenda: 'raised' });
  });

  it('should refuse a project with no lanes and say how to get some', async () => {
    const { controller, gateway } = harness(new FakeGateway(project({ laneSet: null })));
    await controller.edit({ json: false }, { rename: ['todo=Backlog'] }).then(
      () => should.fail('expected a refusal', 'a refusal'),
      (error: Error) => should(error.message).match(/Ferretry has no lanes to edit.*fy board lanes propose/u),
    );
    should(gateway.changes).eql([]);
  });
});

describe('fy board workflow show', () => {
  it('should print each lane as a gate or an automatic step', async () => {
    const { controller, lines } = harness();
    await controller.workflow({ json: false });
    should(lines[0])
      .match(/Ferretry workflow, lanes version 3/u)
      .and.match(/plan\tPlan\/Design\tGATE/u);
  });

  it('should print the project as JSON on request', async () => {
    const { controller, lines } = harness();
    await controller.workflow({ json: true, project: 'Ferretry' });
    should(JSON.parse(lines[0] ?? '')).containEql({ id: FERRETRY_ID });
  });
});

describe('fy board workflow edit', () => {
  it('should edit a stage against the version it just read', async () => {
    const { controller, gateway, lines } = harness();
    await controller.editWorkflow({ json: false }, { lane: 'implement', gate: ['Ship it=next'] });
    should(gateway.changes[0]?.request).containEql({ action: 'edit', version: 3 });
    should(lines[0]).match(/version 4/u);
  });

  it('should print JSON on request', async () => {
    const { controller, lines } = harness();
    await controller.editWorkflow({ json: true }, { lane: 'plan', auto: 'none' });
    should(JSON.parse(lines[0] ?? '')).containEql({ agenda: 'raised' });
  });

  it('should refuse a project with no lanes and say how to get some', async () => {
    const { controller, gateway } = harness(new FakeGateway(project({ laneSet: null })));
    await controller.editWorkflow({ json: false }, { lane: 'plan', auto: 'none' }).then(
      () => should.fail('expected a refusal', 'a refusal'),
      (error: Error) => should(error.message).match(/Ferretry has no lanes to edit.*fy board lanes propose/u),
    );
    should(gateway.changes).eql([]);
  });
});

describe('rendering lanes', () => {
  it('should say a set confirmed on the admin token was confirmed by the token, not the owner', () => {
    const text = renderLaneSet(laneSet({ confirmedBy: 'owner', confirmedVia: 'admin-token' }), 'Ferretry');
    should(text).match(
      /confirmed by the admin token \(the owner at this machine, or a ferret without its own credential\)/u,
    );
    should(text).not.match(/confirmed by the owner/u);
  });

  it('should mark a confirmed set and an owner-gated lane', () => {
    const text = renderLaneSet(laneSet({ confirmedBy: 'owner' }), 'Ferretry');
    should(text)
      .match(/confirmed by the owner/u)
      .and.match(/plan\tPlan\/Design\t\(active, owner-gated\)/u);
  });

  it('should say when a card belongs in each lane, from its category and what enters it', () => {
    const text = renderLaneSet(laneSet({ confirmedBy: 'owner' }), 'Ferretry');
    should(text)
      .match(/todo\tTodo\t\(backlog\)\tuse when: not started yet/u)
      .and.match(/plan\tPlan\/Design\t\(active, owner-gated\)\tuse when: you are planning or designing it/u)
      .and.match(
        /implement\tIn progress\t\(active\)\tuse when: you are building it now; moves in when a session starts on it/u,
      );
  });

  it('should explain each agenda outcome', () => {
    const base = { laneSet: laneSet() };
    should(renderLaneChange({ ...base, agenda: 'not-needed' }, 'Ferretry')).match(/No question for the owner/u);
    should(renderLaneChange({ ...base, agenda: 'failed' }, 'Ferretry')).match(/tell the owner yourself/u);
  });

  it('should render a board that has lanes', () => {
    should(renderBoardLanes(project(), 'fy')).match(/Ferretry lanes, version 3/u);
  });
});
