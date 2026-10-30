import { describe, it } from 'bun:test';
import type {
  BoardProjectsResponse,
  BoardQueryInput,
  BoardResponse,
  BoardTaskActionRequestInput,
  BoardTaskCreateRequestInput,
  BoardTaskResponse,
  FleetTaskListResponse,
  ScopedTaskDetailResponse,
  ScopedTaskView,
  SessionTaskListResponse,
  TaskActionRequest,
  TaskId,
} from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import { registerBoardCommands } from '../../../src/adapters/board/board-commands';
import { registerTaskCommands } from '../../../src/adapters/tasks/task-commands';
import { BoardController } from '../../../src/lib/board/board-controllers';
import type { IBoardGateway, SessionDirectoryEntry } from '../../../src/lib/board/ports';
import type { ITaskGateway, ITaskOutput, ITextFileReader } from '../../../src/lib/tasks/ports';
import type { TaskScope } from '../../../src/lib/tasks/task-scope';
import { boardResponse, FERRETRY_ID, listing, taskResponse } from '../board/fixtures';
import { taskSummary, taskView } from './fake-daemon';

class FakeBoardGateway implements IBoardGateway {
  queried: BoardQueryInput | undefined;
  shown: string | undefined;
  created: { as: string | undefined; request: BoardTaskCreateRequestInput } | undefined;
  acted: { as: string | undefined; id: string; request: BoardTaskActionRequestInput } | undefined;
  projectsAs: string | undefined;
  projectsAnswer: BoardProjectsResponse = listing({ current: FERRETRY_ID as BoardProjectsResponse['current'] });

  board(query: BoardQueryInput): Promise<BoardResponse> {
    this.queried = query;
    return Promise.resolve(boardResponse());
  }

  task(id: string): Promise<BoardTaskResponse> {
    this.shown = id;
    return Promise.resolve(taskResponse());
  }

  create(as: string | undefined, request: BoardTaskCreateRequestInput): Promise<BoardTaskResponse> {
    this.created = { as, request };
    return Promise.resolve(taskResponse({ id: 'F9' as never }));
  }

  act(as: string | undefined, id: string, request: BoardTaskActionRequestInput): Promise<BoardTaskResponse> {
    this.acted = { as, id, request };
    return Promise.resolve(taskResponse({ laneId: 'implement' }));
  }

  projects(as: string | undefined): Promise<BoardProjectsResponse> {
    this.projectsAs = as;
    return Promise.resolve(this.projectsAnswer);
  }

  sessions(): Promise<readonly SessionDirectoryEntry[]> {
    return Promise.resolve([{ id: 'session-8', callsign: 'denisha' }]);
  }
}

class LegacyGateway implements ITaskGateway {
  listedScope: TaskScope | undefined;

  create(): Promise<ScopedTaskView> {
    throw new Error('the legacy gateway is only read by `list --legacy`');
  }

  list(scope: TaskScope): Promise<SessionTaskListResponse | FleetTaskListResponse> {
    this.listedScope = scope;
    return Promise.resolve({
      v: 1,
      sessionId: 'session-7',
      tasks: [{ ...taskSummary('F1'), sessionId: 'session-7' }],
      parseErrors: 0,
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  }

  show(sessionId: string, id: TaskId): Promise<ScopedTaskDetailResponse> {
    return Promise.resolve({ sessionId, task: { ...taskView(id), sessionId }, activity: [] });
  }

  act(_sessionId: string, _id: TaskId, _request: TaskActionRequest): Promise<ScopedTaskView> {
    throw new Error('the legacy gateway is only read by `list --legacy`');
  }
}

class CapturedOutput implements ITaskOutput {
  readonly lines: string[] = [];
  readonly notices: string[] = [];

  success(message: string): void {
    this.lines.push(message);
  }

  report(message: string): void {
    this.lines.push(message);
  }

  diagnostic(message: string): void {
    this.notices.push(message);
  }
}

class StubFiles implements ITextFileReader {
  readText(): Promise<string> {
    return Promise.resolve('the brief from disk');
  }
}

interface Harness {
  readonly run: (...argv: string[]) => Promise<void>;
  readonly gateway: FakeBoardGateway;
  readonly legacy: LegacyGateway;
  readonly output: CapturedOutput;
}

/** Builds the command groups exactly as the composition root does, over test doubles. */
function harness(environmentSessionId: string | undefined = 'session-7'): Harness {
  const gateway = new FakeBoardGateway();
  const legacy = new LegacyGateway();
  const output = new CapturedOutput();
  const board = new BoardController({ gateway, output, files: new StubFiles(), binary: 'fy', environmentSessionId });
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerTaskCommands(program, { board, legacyGateway: legacy, io: output, environmentSessionId });
  registerBoardCommands(program, board);
  return {
    gateway,
    legacy,
    output,
    run: async (...argv: string[]) => void (await program.parseAsync(['node', 'fy', ...argv])),
  };
}

const creating = [
  'task',
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
  it('should send the record as the ambient session and print the new id', async () => {
    // Arrange
    const { run, gateway, output } = harness();

    // Act
    await run(...creating, '--term', 'widget=the thing', '--depends-on', 'F2');

    // Assert
    should(gateway.created?.as).equal('session-7');
    should(gateway.created?.request.title).equal('Rename the widget');
    should(gateway.created?.request.ask).eql({ text: 'please rename it', source: 'chat://1' });
    should(output.lines.join('\n')).containEql('&F9');
  });

  it('should take the title from the trailing words', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run('task', 'create', '-k', 'bug', '--ask', 'a', '--ask-source', 'chat://1', 'Fix', 'the', 'widget');

    // Assert
    should(gateway.created?.request.title).equal('Fix the widget');
  });
});

describe('fy task lifecycle verbs', () => {
  it('should show a card, accepting every spelling of its id', async () => {
    // Arrange
    const { run, gateway, output } = harness();

    // Act
    await run('task', 'show', '#F412');

    // Assert
    should(gateway.shown).equal('F412');
    should(output.lines.join('\n')).containEql('&F412');
  });

  it('should move a card to a named lane with its reason', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run('task', 'move', '&F412', 'implement', '--reason', 'started');

    // Assert
    should(gateway.acted?.id).equal('F412');
    should(gateway.acted?.as).equal('session-7');
    should(gateway.acted?.request).containEql({ action: 'move' });
  });

  it('should let --session override the ambient session', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run('task', 'note', 'F412', 'a note', '--session', 'session-9');

    // Assert
    should(gateway.acted?.as).equal('session-9');
  });

  it('should resolve a callsign when assigning', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run('task', 'assign', 'F412', 'denisha');

    // Assert
    should(gateway.acted?.request).containEql({ action: 'assign', assignee: 'session-8' });
  });
});

describe('the transition shims', () => {
  it('should refuse fy task status with the new spelling', async () => {
    const { run } = harness();
    await should(run('task', 'status', 'F412', 'done', '--reason', 'x')).be.rejectedWith({
      message: /task move &F412/,
    });
  });

  it('should refuse fy task phase with the new spelling', async () => {
    const { run } = harness();
    await should(run('task', 'phase', 'F412', 'review', '--reason', 'x')).be.rejectedWith({
      message: /task move &F412/,
    });
  });

  it('should answer fy task list as fy board --mine with a notice', async () => {
    // Arrange
    const { run, gateway, output } = harness();

    // Act
    await run('task', 'list');

    // Assert
    should(output.notices.join('\n')).containEql('fy board --mine');
    should(gateway.queried).have.property('ferret', 'session-7');
  });

  it('should keep the old routes behind --legacy', async () => {
    // Arrange
    const { run, legacy, gateway } = harness();

    // Act
    await run('task', 'list', '--legacy');

    // Assert
    should(legacy.listedScope).not.equal(undefined);
    should(gateway.queried).equal(undefined);
  });
});

describe('fy board', () => {
  it('should print the current project board grouped by lane', async () => {
    // Arrange
    const { run, gateway, output } = harness();

    // Act
    await run('board');

    // Assert
    should(gateway.queried).have.property('project');
    should(output.lines.join('\n')).containEql('&F412');
  });

  it('should pass the filters through to the query', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run('board', '--project', 'all', '--kind', 'bug', '--pr', 'open', '--activity', 'stale', '--closed');

    // Assert
    should(gateway.queried).containEql({ kind: 'bug', prState: 'open', activity: 'stale' });
  });

  it('should print JSON when asked', async () => {
    // Arrange
    const { run, output } = harness();

    // Act
    await run('board', '--json');

    // Assert
    should(() => JSON.parse(output.lines.join('\n'))).not.throw();
  });
});
