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
import { Command } from 'commander';
import should from 'should';
import { registerTaskCommands } from '../../../src/adapters/tasks/task-commands';
import type { ITaskGateway, ITaskOutput, ITextFileReader } from '../../../src/lib/tasks/ports';
import type { TaskScope } from '../../../src/lib/tasks/task-scope';
import { taskSummary, taskView } from './fake-daemon';

const scoped = (id = 'F1'): ScopedTaskView => ({ ...taskView(id), sessionId: 'session-7' });

class RecordingGateway implements ITaskGateway {
  createdWith: TaskCreateRequest | undefined;
  listedScope: TaskScope | undefined;
  listedFilters: readonly (readonly [string, string])[] | undefined;
  shownWith: readonly [string, TaskId, number] | undefined;
  actedWith: readonly [string, TaskId, TaskActionRequest] | undefined;

  create(sessionId: string, request: TaskCreateRequest): Promise<ScopedTaskView> {
    this.createdWith = request;
    return Promise.resolve({ ...scoped('F9'), sessionId });
  }

  list(
    scope: TaskScope,
    filters: readonly (readonly [string, string])[],
  ): Promise<SessionTaskListResponse | FleetTaskListResponse> {
    this.listedScope = scope;
    this.listedFilters = filters;
    return Promise.resolve({
      v: 1,
      sessionId: 'session-7',
      tasks: [{ ...taskSummary('F1'), sessionId: 'session-7' }],
      parseErrors: 0,
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  }

  show(sessionId: string, id: TaskId, afterSequence: number): Promise<ScopedTaskDetailResponse> {
    this.shownWith = [sessionId, id, afterSequence];
    return Promise.resolve({ sessionId, task: { ...taskView(id), sessionId }, activity: [] });
  }

  act(sessionId: string, id: TaskId, request: TaskActionRequest): Promise<ScopedTaskView> {
    this.actedWith = [sessionId, id, request];
    return Promise.resolve({ ...scoped(id), sessionId });
  }
}

class CapturedOutput implements ITaskOutput {
  readonly lines: string[] = [];

  success(message: string): void {
    this.lines.push(message);
  }
}

class StubFiles implements ITextFileReader {
  readText(): Promise<string> {
    return Promise.resolve('the brief from disk');
  }
}

interface Harness {
  readonly run: (...argv: string[]) => Promise<void>;
  readonly gateway: RecordingGateway;
  readonly output: CapturedOutput;
}

/** Builds the command group exactly as the composition root does, over test doubles. */
function harness(environmentSessionId: string | undefined = 'session-7'): Harness {
  const gateway = new RecordingGateway();
  const output = new CapturedOutput();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerTaskCommands(program, { gateway, io: output, files: new StubFiles(), environmentSessionId });
  return {
    gateway,
    output,
    run: async (...argv: string[]) => {
      await program.parseAsync(['node', 'fy', 'task', ...argv]);
    },
  };
}

const creating = [
  'create',
  '--kind',
  'feature',
  '--title',
  'Rename the widget',
  '--ask',
  'please rename it',
  '--ask-source',
  'chat://1',
];

describe('fy task create', () => {
  it('should send the record and print the new id', async () => {
    // Arrange
    const { run, gateway, output } = harness();

    // Act
    await run(...creating);

    // Assert
    should(gateway.createdWith?.title).equal('Rename the widget');
    should(gateway.createdWith?.ask).eql({ text: 'please rename it', source: 'chat://1' });
    should(output.lines).eql(['#F9']);
  });

  it('should take the title from the trailing words', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run('create', '-k', 'bug', '--ask', 'a', '--ask-source', 'chat://1', 'Fix', 'the', 'widget');

    // Assert
    should(gateway.createdWith?.title).equal('Fix the widget');
    should(gateway.createdWith?.kind).equal('bug');
  });

  it('should collect repeated dependency, file and link flags', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run(
      ...creating,
      '--depends-on',
      'F2',
      '--depends-on',
      '#b3',
      '--file',
      'src/a.ts',
      '--file',
      'src/b.ts',
      '--pr',
      'pr://1',
      '--doc',
      'docs/x.md',
      '--branch',
      'port/x',
    );

    // Assert
    should(gateway.createdWith?.dependsOn).eql(['F2', 'B3']);
    should(gateway.createdWith?.files).eql(['src/a.ts', 'src/b.ts']);
    should(gateway.createdWith?.links).eql({ prs: ['pr://1'], docs: ['docs/x.md'], branch: 'port/x' });
  });

  it('should read the brief from --description-file', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run(...creating, '--description-file', 'brief.md');

    // Assert
    should(gateway.createdWith?.description).equal('the brief from disk');
  });

  it('should refuse a create with no --kind', async () => {
    // Arrange
    const { run } = harness();

    // Act + Assert — commander enforces the required flag before the controller runs.
    await should(run('create', '--title', 'x')).be.rejected();
  });

  it('should refuse a create with no session in scope', async () => {
    // Arrange
    const { run } = harness('');

    // Act + Assert
    await should(run(...creating)).be.rejectedWith(/no session id/u);
  });
});

describe('fy task list', () => {
  it('should use the ambient session and render the board', async () => {
    // Arrange
    const { run, gateway, output } = harness();

    // Act
    await run('list');

    // Assert
    should(gateway.listedScope).eql({ sessionId: 'session-7' });
    should(output.lines[0]).containEql('#F1');
  });

  it('should pass repeated --status filters through in order', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run('list', '--status', 'todo', '--status', 'live', '--assignee', 'ada', '--kind', 'bug', '--repo', '/w/app');

    // Assert
    should(gateway.listedFilters).eql([
      ['repo', '/w/app'],
      ['assignee', 'ada'],
      ['kind', 'bug'],
      ['status', 'todo'],
      ['status', 'live'],
    ]);
  });

  it('should read the fleet with --all and honour an explicit --session', async () => {
    // Arrange
    const fleet = harness();
    const explicit = harness();

    // Act
    await fleet.run('list', '--all');
    await explicit.run('list', '--session', 'other');

    // Assert
    should(fleet.gateway.listedScope).eql({ sessionId: null });
    should(explicit.gateway.listedScope).eql({ sessionId: 'other' });
  });

  it('should refuse --all together with --session', async () => {
    // Arrange
    const { run } = harness();

    // Act + Assert
    await should(run('list', '--all', '--session', 'other')).be.rejectedWith(/not both/u);
  });

  it('should render the kanban, dag, markdown and json shapes', async () => {
    // Arrange
    const kanban = harness();
    const dag = harness();
    const markdown = harness();
    const json = harness();

    // Act
    await kanban.run('list', '--view', 'kanban');
    await dag.run('list', '--view', 'dag');
    await markdown.run('list', '--md');
    await json.run('list', '--json');

    // Assert
    should(kanban.output.lines[0]).containEql('NOT STARTED (1)');
    should(dag.output.lines[0]).containEql('→ ∅');
    should(markdown.output.lines[0]).startWith('# Tasks');
    should(JSON.parse(json.output.lines[0] ?? '{}')).have.property('sessionId', 'session-7');
  });
});

describe('fy task show', () => {
  it('should normalize the id and default the cursor', async () => {
    // Arrange
    const { run, gateway, output } = harness();

    // Act
    await run('show', '#f7');

    // Assert
    should(gateway.shownWith).eql(['session-7', 'F7', 0]);
    should(output.lines[0]).containEql('#F7');
  });

  it('should pass --after and render markdown on request', async () => {
    // Arrange
    const { run, gateway, output } = harness();

    // Act
    await run('show', 'F7', '--after', '12', '--md');

    // Assert
    should(gateway.shownWith).eql(['session-7', 'F7', 12]);
    should(output.lines[0]).startWith('# #F7');
  });
});

describe('fy task mutations', () => {
  it('should build a status move', async () => {
    // Arrange
    const { run, gateway, output } = harness();

    // Act
    await run('status', 'F7', 'live', '--reason', 'deployed', '--note', 'behind a flag');

    // Assert
    should(gateway.actedWith).eql([
      'session-7',
      'F7',
      { action: 'status', status: 'live', reason: 'deployed', note: 'behind a flag' },
    ]);
    should(output.lines[0]).containEql('#F7');
  });

  it('should refuse a status move with no --reason', async () => {
    // Arrange
    const { run } = harness();

    // Act + Assert
    await should(run('status', 'F7', 'live')).be.rejected();
  });

  it('should build a phase move', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run('phase', 'F7', 'design', '--reason', 'needs a spec');

    // Assert
    should(gateway.actedWith?.[2]).eql({ action: 'phase', phase: 'design', reason: 'needs a spec' });
  });

  it('should build a reopen carrying the new ask', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run('reopen', 'F7', '--reason', 'regressed', '--ask', 'it broke', '--source', 'chat://9');

    // Assert
    should(gateway.actedWith?.[2]).eql({
      action: 'reopen',
      reason: 'regressed',
      ask: 'it broke',
      source: 'chat://9',
    });
  });

  it('should join the clarification words', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run('clarify', 'F7', 'make', 'it', 'blue', '--source', 'chat://4');

    // Assert
    should(gateway.actedWith?.[2]).eql({ action: 'clarify', text: 'make it blue', source: 'chat://4' });
  });

  it('should add and remove a dependency', async () => {
    // Arrange
    const added = harness();
    const removed = harness();

    // Act
    await added.run('depend', 'F7', '#f2');
    await removed.run('depend', 'F7', 'F2', '--remove');

    // Assert
    should(added.gateway.actedWith?.[2]).eql({ action: 'dependency', taskId: 'F2', remove: false });
    should(removed.gateway.actedWith?.[2]).eql({ action: 'dependency', taskId: 'F2', remove: true });
  });

  it('should claim a file with an optional reason', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run('file', 'F7', 'src/a.ts', '--reason', 'mine for now');

    // Assert
    should(gateway.actedWith?.[2]).eql({
      action: 'file',
      path: 'src/a.ts',
      remove: false,
      reason: 'mine for now',
    });
  });

  it('should record a note and a feedback entry', async () => {
    // Arrange
    const note = harness();
    const feedback = harness();

    // Act
    await note.run('note', 'F7', 'looked', 'at', 'it');
    await feedback.run('feedback', 'F7', 'needs', 'tests');

    // Assert
    should(note.gateway.actedWith?.[2]).eql({ action: 'note', text: 'looked at it' });
    should(feedback.gateway.actedWith?.[2]).eql({ action: 'feedback', text: 'needs tests' });
  });

  it('should attach exactly one link', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run('link', 'F7', '--pr', 'pr://1');

    // Assert
    should(gateway.actedWith?.[2]).eql({ action: 'link', field: 'pr', value: 'pr://1' });
  });

  it('should refuse two links at once', async () => {
    // Arrange
    const { run } = harness();

    // Act + Assert
    await should(run('link', 'F7', '--pr', 'pr://1', '--doc', 'docs/x.md')).be.rejectedWith(/exactly one of/u);
  });

  it('should assign, unassign, rank and unrank', async () => {
    // Arrange
    const assign = harness();
    const unassign = harness();
    const order = harness();
    const unrank = harness();

    // Act
    await assign.run('assign', 'F7', 'ada');
    await unassign.run('assign', 'F7', '--none');
    await order.run('order', 'F7', '3');
    await unrank.run('order', 'F7', '--none');

    // Assert
    should(assign.gateway.actedWith?.[2]).eql({ action: 'assign', assignee: 'ada' });
    should(unassign.gateway.actedWith?.[2]).eql({ action: 'assign', assignee: null });
    should(order.gateway.actedWith?.[2]).eql({ action: 'order', order: 3 });
    should(unrank.gateway.actedWith?.[2]).eql({ action: 'order', order: null });
  });

  it('should print the whole record for a mutation with --json', async () => {
    // Arrange
    const { run, output } = harness();

    // Act
    await run('note', 'F7', 'hello', '--json');

    // Assert
    should(JSON.parse(output.lines[0] ?? '{}')).have.property('id', 'F7');
  });

  it('should refuse a mutation against the fleet-wide scope', async () => {
    // Arrange
    const { run } = harness('');

    // Act + Assert
    await should(run('note', 'F7', 'hello')).be.rejectedWith(/no session id/u);
  });
});
