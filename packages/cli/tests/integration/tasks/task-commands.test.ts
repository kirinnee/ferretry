import { describe, it } from 'bun:test';
import type {
  BoardProjectsResponse,
  BoardQueryInput,
  BoardResponse,
  BoardSkipRequest,
  BoardSkipResponse,
  BoardTaskActionRequestInput,
  BoardTaskCreateRequestInput,
  BoardTaskResponse,
} from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import { registerBoardCommands } from '../../../src/adapters/board/board-commands';
import { registerTaskCommands } from '../../../src/adapters/tasks/task-commands';
import { BoardController } from '../../../src/lib/board/board-controllers';
import { MergeGateController } from '../../../src/lib/board/merge-gate';
import type { IBoardGateway, SessionDirectoryEntry } from '../../../src/lib/board/ports';
import { TASK_CREATE_RULE } from '../../../src/lib/board/umbrella';
import type { ITextFileReader } from '../../../src/lib/tasks/ports';
import { boardResponse, FERRETRY_ID, listing, taskResponse } from '../board/fixtures';

/** A merge gate nothing here asks: these tests are about the other verbs. */
const quietGate = (): MergeGateController =>
  new MergeGateController({
    gateway: { mergeGate: () => Promise.reject(new Error('not asked')) },
    io: { report: () => {}, diagnostic: () => {}, setExitCode: () => {} },
  });

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
  constructor(private readonly text = 'the brief from disk') {}

  readText(): Promise<string> {
    return Promise.resolve(this.text);
  }
}

interface Harness {
  readonly run: (...argv: string[]) => Promise<void>;
  readonly gateway: FakeBoardGateway;
  readonly output: CapturedOutput;
}

/** Builds the command groups exactly as the composition root does, over test doubles. */
function harness(environmentSessionId: string | undefined = 'session-7', files = new StubFiles()): Harness {
  const gateway = new FakeBoardGateway();
  const output = new CapturedOutput();
  const board = new BoardController({ gateway, output, files, binary: 'fy', environmentSessionId });
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerTaskCommands(program, { board, mergeGate: quietGate() });
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

  it('should report an external event for a card', async () => {
    // Arrange
    const { run, gateway, output } = harness();

    // Act
    await run('task', 'trigger', '&F412', 'deploy.done', '--reason', 'prod is up');

    // Assert
    should(gateway.acted?.id).equal('F412');
    should(gateway.acted?.request).eql({ action: 'trigger', event: 'deploy.done', reason: 'prod is up' });
    should(output.lines.join('\n')).containEql('event reported');
  });

  it('should refuse an event the daemon observes itself, before any request', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act + Assert
    await should(run('task', 'trigger', '&F412', 'pr.merged')).rejectedWith(/not an event you can report/u);
    should(gateway.acted).be.undefined();
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
    registerTaskCommands(program, { board, mergeGate: quietGate() });

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

describe('fy task merge-gate', () => {
  it("should ask the gate for the PR and exit 1 with the waits when the PR's card is queued", async () => {
    // Arrange
    const asked: string[] = [];
    const reports: string[] = [];
    let exitCode = 0;
    const mergeGate = new MergeGateController({
      gateway: {
        mergeGate: async pr => {
          asked.push(pr);
          return {
            pr,
            unit: [{ id: 'F20' }],
            waits: [{ task: { id: 'F20' }, on: { id: 'F18' }, until: 'shipped' }],
            unreadable: [],
          };
        },
      },
      io: {
        report: message => reports.push(message),
        diagnostic: () => {},
        setExitCode: code => {
          exitCode = code;
        },
      },
    });
    const board = new BoardController({
      gateway: new FakeBoardGateway(),
      output: new CapturedOutput(),
      files: new StubFiles(),
      binary: 'fy',
      environmentSessionId: 'session-7',
    });
    const program = new Command().name('fy').exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerTaskCommands(program, { board, mergeGate });

    // Act
    await program.parseAsync(['node', 'fy', 'task', 'merge-gate', 'https://github.com/kirinnee/ferretry/pull/42']);

    // Assert
    should(asked).eql(['https://github.com/kirinnee/ferretry/pull/42']);
    should(reports).eql(['&F20 waits on &F18 (until shipped)']);
    should(exitCode).equal(1);
  });
});

describe('fy task create --help', () => {
  it('should teach one card per outcome after the options: never asks, related cards first, no umbrella', async () => {
    // Arrange
    const board = new BoardController({
      gateway: new FakeBoardGateway(),
      output: new CapturedOutput(),
      files: new StubFiles(),
      binary: 'fy',
      environmentSessionId: 'session-7',
    });
    const written: string[] = [];
    const program = new Command().name('fy').exitOverride();
    program.configureOutput({ writeOut: text => written.push(text), writeErr: () => {} });
    registerTaskCommands(program, { board, mergeGate: quietGate() });

    // Act
    await program.parseAsync(['node', 'fy', 'task', 'create', '--help']).catch(() => undefined);

    // Assert
    const flat = (text: string): string => text.replace(/\s+/g, ' ');
    const help = flat(written.join(''));
    const rule = flat(TASK_CREATE_RULE);
    should(help).containEql('--broad <why>');
    should(help).containEql('prefer adding to a related card');
    should(help).containEql(rule);
    should(help.indexOf(rule)).be.above(help.indexOf('--broad <why>'));
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
    ['claim', ['claim', 'F412'], 'claim'],
    ['adopt', ['adopt', 'F412', '--reason', 'both ended'], 'adopt'],
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

describe('fy task create --private / --public', () => {
  it.each([
    ['--private', 'private'],
    ['--public', 'public'],
  ] as const)('should send %s as the card visibility', async (flag, visibility) => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run(...creating, flag);

    // Assert
    should(gateway.created?.request).have.property('visibility', visibility);
  });

  it('should leave visibility to the daemon when neither flag is given', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run(...creating);

    // Assert
    should(gateway.created?.request).not.have.property('visibility');
  });

  it('should refuse both flags before any request', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    const attempt = run(...creating, '--private', '--public');

    // Assert
    await should(attempt).rejected();
    should(gateway.created).be.undefined();
  });
});

describe('fy task edit --visibility', () => {
  it('should send visibility alone as one edit', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run('task', 'edit', 'F412', '--visibility', 'private');

    // Assert
    should(gateway.acted?.request).eql({ action: 'edit', visibility: 'private' });
  });

  it('should send visibility beside card text as the same single edit', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run('task', 'edit', 'F412', '--title', 'Changed', '--visibility', 'public');

    // Assert
    should(gateway.acted?.request).eql({ action: 'edit', title: 'Changed', visibility: 'public' });
  });

  it('should refuse a visibility that is neither public nor private before any request', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    const attempt = run('task', 'edit', 'F412', '--title', 'Changed', '--visibility', 'secret');

    // Assert
    await should(attempt).rejected();
    should(gateway.acted).be.undefined();
  });
});

describe('fy board --private / --all', () => {
  it('should query the public cards only by default', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run('board');

    // Assert
    should(gateway.queried).have.property('visibility', 'public');
  });

  it('should query the private cards with --private', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run('board', '--private');

    // Assert
    should(gateway.queried).have.property('visibility', 'private');
  });

  it('should leave visibility out with --all so every card comes back', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    await run('board', '--all');

    // Assert
    should(gateway.queried).not.have.property('visibility');
  });

  it('should refuse --private with --all', async () => {
    // Arrange
    const { run, gateway } = harness();

    // Act
    const attempt = run('board', '--private', '--all');

    // Assert
    await should(attempt).rejected();
    should(gateway.queried).be.undefined();
  });
});

describe('fy task show --yaml and fy task patch', () => {
  it('should print the editable document with the card revision', async () => {
    // Arrange
    const { run, output } = harness();

    // Act
    await run('task', 'show', 'F412', '--yaml');

    // Assert
    should(output.lines.join('\n')).match(/\nrevision: 1\ntitle: /u);
  });

  it('should send the document read from --file as ONE edit carrying its revision', async () => {
    // Arrange
    const { run, gateway } = harness('session-7', new StubFiles('revision: 1\nsummary: One patch, one edit'));

    // Act
    await run('task', 'patch', 'F412', '--file', 'f412.yaml');

    // Assert
    should(gateway.acted?.request).eql({ action: 'edit', revision: 1, summary: 'One patch, one edit' });
  });
});
