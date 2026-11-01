import { describe, it } from 'bun:test';
import type {
  BoardProjectsResponse,
  BoardQueryInput,
  BoardResponse,
  BoardSkipRequest,
  BoardSkipResponse,
  BoardSwitch,
  BoardTaskActionRequestInput,
  BoardTaskCreateRequestInput,
  BoardTaskResponse,
} from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import { registerBoardCommands } from '../../../src/adapters/board/board-commands';
import { registerTaskCommands } from '../../../src/adapters/tasks/task-commands';
import { BoardController } from '../../../src/lib/board/board-controllers';
import type { IBoardGateway, SessionDirectoryEntry } from '../../../src/lib/board/ports';
import type { ITextFileReader } from '../../../src/lib/tasks/ports';
import { boardResponse, FERRETRY_ID, listing, taskResponse } from '../board/fixtures';

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

  skipped: { as: string | undefined; request: BoardSkipRequest } | undefined;

  skip(as: string | undefined, request: BoardSkipRequest): Promise<BoardSkipResponse> {
    this.skipped = { as, request };
    return Promise.resolve({ sessionId: as ?? '', skip: { reason: request.reason, at: '2026-10-30T10:00:00.000Z' } });
  }

  projects(as: string | undefined): Promise<BoardProjectsResponse> {
    this.projectsAs = as;
    return Promise.resolve(this.projectsAnswer);
  }

  sessions(): Promise<readonly SessionDirectoryEntry[]> {
    return Promise.resolve([{ id: 'session-8', callsign: 'denisha' }]);
  }

  switchOf(projectId: BoardSwitch['projectId']): Promise<BoardSwitch> {
    return Promise.resolve({ projectId, on: true, setBy: 'owner', setAt: null });
  }
}

class CapturedOutput {
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
  readonly output: CapturedOutput;
}

/** Builds the command groups exactly as the composition root does, over test doubles. */
function harness(environmentSessionId: string | undefined = 'session-7'): Harness {
  const gateway = new FakeBoardGateway();
  const output = new CapturedOutput();
  const board = new BoardController({ gateway, output, files: new StubFiles(), binary: 'fy', environmentSessionId });
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerTaskCommands(program, { board });
  registerBoardCommands(program, board);
  return {
    gateway,
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

describe('fy task skip', () => {
  it('should record the words as the reason, on the acting session', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run('task', 'skip', 'owner', 'said', 'not', 'to', 'track', '--session', 'session-8');

    // Assert
    should(gateway.skipped).eql({ as: 'session-8', request: { reason: 'owner said not to track' } });
  });
});

describe('fy task move --help', () => {
  it('should teach which lane fits which work, by category, after the options', async () => {
    // Arrange
    const gateway = new FakeBoardGateway();
    const board = new BoardController({
      gateway,
      output: new CapturedOutput(),
      files: new StubFiles(),
      binary: 'fy',
      environmentSessionId: 'session-7',
    });
    const written: string[] = [];
    const program = new Command().name('fy').exitOverride();
    program.configureOutput({ writeOut: text => written.push(text), writeErr: () => {} });
    registerTaskCommands(program, { board });

    // Act
    await program.parseAsync(['node', 'fy', 'task', 'move', '--help']).catch(() => undefined);

    // Assert
    const help = written.join('');
    should(help).containEql('--reason <why>');
    should(help.indexOf('Pick the lane by what the work is')).be.above(help.indexOf('--reason <why>'));
    should(help).containEql('`fy board lanes show` lists this project\'s lanes with "use when"');
    should(help).containEql('  active  ');
    should(help).containEql('Blocked is not a lane');
  });
});

describe('every remaining task verb', () => {
  const verbs: readonly (readonly [string, readonly string[], string])[] = [
    ['focus', ['focus', 'F412'], 'focus'],
    ['block', ['block', 'F412', 'waiting', 'on', 'legal'], 'block'],
    ['unblock', ['unblock', 'F412'], 'unblock'],
    ['depend', ['depend', 'F412', 'F2', '--until', 'released'], 'depend'],
    ['undepend', ['undepend', 'F412', 'F2'], 'undepend'],
    ['drop', ['drop', 'F412', '--reason', 'superseded'], 'drop'],
    ['reopen', ['reopen', 'F412', '--to', 'implement', '--ask', 'one more thing'], 'reopen'],
    ['clarify', ['clarify', 'F412', 'also', 'the', 'header', '--source', 'chat://2'], 'clarify'],
    ['link', ['link', 'F412', '--branch', 'feat/x'], 'link'],
    ['order', ['order', 'F412', '3'], 'order'],
    ['reparent', ['reparent', 'F412', '--parent', 'F85'], 'reparent'],
    ['reparent --none', ['reparent', 'F412', '--none'], 'reparent'],
    ['file', ['file', 'F412', 'src/a.ts'], 'file'],
    ['edit', ['edit', 'F412', '--summary', 'a line', '--term', 'x=y'], 'edit'],
    ['refile', ['refile', 'F412', '--project', 'Ferretry'], 'refile'],
    ['feedback', ['feedback', 'F412', 'nice'], 'note'],
  ];

  for (const [name, argv, action] of verbs) {
    it(`should send ${name} as the ${action} action`, async () => {
      // Arrange
      const { run, gateway } = harness();

      // Act
      await run('task', ...argv);

      // Assert
      should(gateway.acted?.id).equal('F412');
      should(gateway.acted?.request).have.property('action', action);
    });
  }
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
