import { describe, it } from 'bun:test';
import type {
  FleetTaskListResponse,
  ScopedTaskDetailResponse,
  ScopedTaskView,
  SessionTaskListResponse,
  TaskActionRequest,
  TaskCreateRequest,
  TaskId,
} from '@ferretry/protocol';
import should from 'should';
import type { ITaskGateway, ITaskOutput, ITextFileReader } from '../../../src/lib/tasks/ports';
import {
  TaskActionController,
  TaskCreateController,
  TaskListController,
  TaskShowController,
} from '../../../src/lib/tasks/task-controllers';
import type { TaskScope } from '../../../src/lib/tasks/task-scope';
import { summary, view } from './fixtures';

interface Call {
  readonly method: string;
  readonly arguments: readonly unknown[];
}

/** Records what the controller asked the daemon for, and answers with a canned record. */
class FakeGateway implements ITaskGateway {
  readonly calls: Call[] = [];

  constructor(private readonly board: SessionTaskListResponse | FleetTaskListResponse) {}

  create(sessionId: string, request: TaskCreateRequest): Promise<ScopedTaskView> {
    this.calls.push({ method: 'create', arguments: [sessionId, request] });
    return Promise.resolve({ ...view({ id: 'F9' }), sessionId });
  }

  list(scope: TaskScope, filters: readonly (readonly [string, string])[]) {
    this.calls.push({ method: 'list', arguments: [scope, filters] });
    return Promise.resolve(this.board);
  }

  show(sessionId: string, id: TaskId, afterSequence: number): Promise<ScopedTaskDetailResponse> {
    this.calls.push({ method: 'show', arguments: [sessionId, id, afterSequence] });
    return Promise.resolve({ sessionId, task: { ...view({ id }), sessionId }, activity: [] });
  }

  act(sessionId: string, id: TaskId, request: TaskActionRequest): Promise<ScopedTaskView> {
    this.calls.push({ method: 'act', arguments: [sessionId, id, request] });
    return Promise.resolve({ ...view({ id, phase: 'build', status: 'in_progress' }), sessionId });
  }
}

class CapturedOutput implements ITaskOutput {
  readonly lines: string[] = [];

  success(message: string): void {
    this.lines.push(message);
  }
}

class FakeFiles implements ITextFileReader {
  readonly requested: string[] = [];

  constructor(private readonly contents: string) {}

  readText(path: string): Promise<string> {
    this.requested.push(path);
    return Promise.resolve(this.contents);
  }
}

const sessionBoard = (tasks = [summary({ id: 'F1' })]): SessionTaskListResponse => ({
  v: 1,
  sessionId: 'session-7',
  tasks: tasks.map(task => ({ ...task, sessionId: 'session-7' })),
  parseErrors: 0,
  updatedAt: '2026-01-02T00:00:00.000Z',
});

const scope: TaskScope = { sessionId: 'session-7' };
const minimalCreate = { kind: 'feature', title: 'Rename the widget', ask: 'do it', askSource: 'chat://1' };

describe('creating a task', () => {
  it('should print only the new id so `id=$(fy task create …)` works', async () => {
    // Arrange
    const gateway = new FakeGateway(sessionBoard());
    const output = new CapturedOutput();
    const controller = new TaskCreateController(gateway, output, new FakeFiles(''));

    // Act
    await controller.run({ scope, options: minimalCreate, titleWords: [], json: false });

    // Assert
    should(output.lines).eql(['#F9']);
    should(gateway.calls[0]?.arguments[0]).equal('session-7');
  });

  it('should print the whole record when --json is asked for', async () => {
    // Arrange
    const output = new CapturedOutput();
    const controller = new TaskCreateController(new FakeGateway(sessionBoard()), output, new FakeFiles(''));

    // Act
    await controller.run({ scope, options: minimalCreate, titleWords: [], json: true });

    // Assert
    should(JSON.parse(output.lines[0] ?? '{}')).have.property('id', 'F9');
  });

  it('should read the brief from --description-file', async () => {
    // Arrange
    const gateway = new FakeGateway(sessionBoard());
    const files = new FakeFiles('the brief from disk');
    const controller = new TaskCreateController(gateway, new CapturedOutput(), files);

    // Act
    await controller.run({
      scope,
      options: { ...minimalCreate, descriptionFile: '  brief.md  ' },
      titleWords: [],
      json: false,
    });

    // Assert
    should(files.requested).eql(['brief.md']);
    const sent = gateway.calls[0]?.arguments[1] as TaskCreateRequest | undefined;
    should(sent?.description).equal('the brief from disk');
  });

  it('should refuse both brief sources rather than silently dropping one', async () => {
    // Arrange
    const controller = new TaskCreateController(
      new FakeGateway(sessionBoard()),
      new CapturedOutput(),
      new FakeFiles(''),
    );

    // Act
    const failure = controller.run({
      scope,
      options: { ...minimalCreate, description: 'inline', descriptionFile: 'brief.md' },
      titleWords: [],
      json: false,
    });

    // Assert
    await should(failure).be.rejectedWith(/not both/u);
  });

  it('should refuse to create against the fleet-wide scope', async () => {
    // Arrange
    const controller = new TaskCreateController(
      new FakeGateway(sessionBoard()),
      new CapturedOutput(),
      new FakeFiles(''),
    );

    // Act
    const failure = controller.run({
      scope: { sessionId: null },
      options: minimalCreate,
      titleWords: [],
      json: false,
    });

    // Assert
    await should(failure).be.rejectedWith(/read-only/u);
  });
});

describe('listing tasks', () => {
  it('should render the plain board by default and pass the filters through', async () => {
    // Arrange
    const gateway = new FakeGateway(sessionBoard());
    const output = new CapturedOutput();
    const controller = new TaskListController(gateway, output);

    // Act
    await controller.run({ scope, options: { assignee: 'ada' }, markdown: false, json: false });

    // Assert
    should(output.lines[0]).containEql('#F1');
    should(gateway.calls[0]?.arguments[1]).eql([['assignee', 'ada']]);
  });

  it('should render the kanban and dag views on request', async () => {
    // Arrange
    const kanban = new CapturedOutput();
    const dag = new CapturedOutput();

    // Act
    await new TaskListController(new FakeGateway(sessionBoard()), kanban).run({
      scope,
      options: { view: 'kanban' },
      markdown: false,
      json: false,
    });
    await new TaskListController(new FakeGateway(sessionBoard()), dag).run({
      scope,
      options: { view: 'dag' },
      markdown: false,
      json: false,
    });

    // Assert
    should(kanban.lines[0]).containEql('NOT STARTED (1)');
    should(dag.lines[0]).containEql('→ ∅');
  });

  it('should render markdown when asked, and JSON in preference to it', async () => {
    // Arrange
    const markdown = new CapturedOutput();
    const json = new CapturedOutput();

    // Act
    await new TaskListController(new FakeGateway(sessionBoard()), markdown).run({
      scope,
      options: {},
      markdown: true,
      json: false,
    });
    await new TaskListController(new FakeGateway(sessionBoard()), json).run({
      scope,
      options: {},
      markdown: true,
      json: true,
    });

    // Assert
    should(markdown.lines[0]).startWith('# Tasks');
    should(JSON.parse(json.lines[0] ?? '{}')).have.property('sessionId', 'session-7');
  });

  it('should read the fleet without demanding a session', async () => {
    // Arrange
    const fleet: FleetTaskListResponse = { ...sessionBoard(), sessionId: null };
    const gateway = new FakeGateway(fleet);

    // Act
    await new TaskListController(gateway, new CapturedOutput()).run({
      scope: { sessionId: null },
      options: {},
      markdown: false,
      json: false,
    });

    // Assert
    should(gateway.calls[0]?.arguments[0]).eql({ sessionId: null });
  });

  it('should refuse an unknown view before contacting the daemon', async () => {
    // Arrange
    const gateway = new FakeGateway(sessionBoard());

    // Act
    const failure = new TaskListController(gateway, new CapturedOutput()).run({
      scope,
      options: { view: 'gantt' },
      markdown: false,
      json: false,
    });

    // Assert
    await should(failure).be.rejectedWith(/--view must be one of/u);
    should(gateway.calls).be.empty();
  });
});

describe('showing one task', () => {
  it('should normalize the id and default the history cursor to the beginning', async () => {
    // Arrange
    const gateway = new FakeGateway(sessionBoard());
    const output = new CapturedOutput();

    // Act
    await new TaskShowController(gateway, output).run({ scope, id: '#f7', markdown: false, json: false });

    // Assert
    should(gateway.calls[0]?.arguments).eql(['session-7', 'F7', 0]);
    should(output.lines[0]).containEql('#F7');
  });

  it('should pass --after through as a cursor', async () => {
    // Arrange
    const gateway = new FakeGateway(sessionBoard());

    // Act
    await new TaskShowController(gateway, new CapturedOutput()).run({
      scope,
      id: 'F7',
      after: '12',
      markdown: false,
      json: false,
    });

    // Assert
    should(gateway.calls[0]?.arguments[2]).equal(12);
  });

  it('should render markdown and JSON on request', async () => {
    // Arrange
    const markdown = new CapturedOutput();
    const json = new CapturedOutput();

    // Act
    await new TaskShowController(new FakeGateway(sessionBoard()), markdown).run({
      scope,
      id: 'F7',
      markdown: true,
      json: false,
    });
    await new TaskShowController(new FakeGateway(sessionBoard()), json).run({
      scope,
      id: 'F7',
      markdown: true,
      json: true,
    });

    // Assert
    should(markdown.lines[0]).startWith('# #F7');
    should(JSON.parse(json.lines[0] ?? '{}')).have.property('sessionId', 'session-7');
  });

  it('should refuse an unparseable id and a non-numeric cursor', async () => {
    // Arrange
    const gateway = new FakeGateway(sessionBoard());
    const controller = new TaskShowController(gateway, new CapturedOutput());

    // Act + Assert
    await should(controller.run({ scope, id: 'nope', markdown: false, json: false })).be.rejectedWith(/task id/u);
    await should(controller.run({ scope, id: 'F7', after: 'x', markdown: false, json: false })).be.rejectedWith(
      /--after must be/u,
    );
    should(gateway.calls).be.empty();
  });
});

describe('acting on a task', () => {
  it('should send the action and echo where the task landed', async () => {
    // Arrange
    const gateway = new FakeGateway(sessionBoard());
    const output = new CapturedOutput();
    const request: TaskActionRequest = { action: 'note', text: 'looked at it' };

    // Act
    await new TaskActionController(gateway, output).run({ scope, id: '&f7', request, json: false });

    // Assert
    should(gateway.calls[0]?.arguments).eql(['session-7', 'F7', request]);
    should(output.lines).eql(['#F7  build']);
  });

  it('should print the whole record when --json is asked for', async () => {
    // Arrange
    const output = new CapturedOutput();
    const request: TaskActionRequest = { action: 'note', text: 'looked at it' };

    // Act
    await new TaskActionController(new FakeGateway(sessionBoard()), output).run({
      scope,
      id: 'F7',
      request,
      json: true,
    });

    // Assert
    should(JSON.parse(output.lines[0] ?? '{}')).have.property('phase', 'build');
  });

  it('should refuse a write against the fleet-wide scope', async () => {
    // Arrange
    const gateway = new FakeGateway(sessionBoard());

    // Act
    const failure = new TaskActionController(gateway, new CapturedOutput()).run({
      scope: { sessionId: null },
      id: 'F7',
      request: { action: 'note', text: 'x' },
      json: false,
    });

    // Assert
    await should(failure).be.rejectedWith(/read-only/u);
    should(gateway.calls).be.empty();
  });
});
