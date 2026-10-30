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
  BoardTaskView,
  LaneSet,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import should from 'should';
import {
  ALL_PROJECTS,
  BoardController,
  resolveLaneRef,
  resolveSessionRef,
  sessionNames,
} from '../../../src/lib/board/board-controllers';
import type { IBoardGateway, IBoardOutput, SessionDirectoryEntry } from '../../../src/lib/board/ports';
import type { ITextFileReader } from '../../../src/lib/tasks/ports';
import {
  card,
  DENISHA,
  directory,
  FERRETRY_ID,
  KIRIN,
  laneSet,
  listing,
  OTHER_ID,
  otherProject,
  pr,
  project,
  response,
  taskResponse,
} from './fixtures';

const PR_ONE = 'https://github.com/kirinnee/ferretry/pull/1';
const PR_TWO = 'https://github.com/kirinnee/ferretry/pull/2';

class FakeGateway implements IBoardGateway {
  readonly boardCalls: BoardQueryInput[] = [];
  readonly taskCalls: string[] = [];
  readonly projectCalls: (string | undefined)[] = [];
  readonly createCalls: { as: string | undefined; request: BoardTaskCreateRequestInput }[] = [];
  readonly actCalls: { as: string | undefined; id: string; request: BoardTaskActionRequestInput }[] = [];
  readonly skipCalls: { as: string | undefined; request: BoardSkipRequest }[] = [];

  boardResponse: BoardResponse = response();
  listingResponse: BoardProjectsResponse = listing({
    projects: [
      project({ id: 'unfiled' as never, name: 'Unfiled', path: null, laneSet: null }),
      project(),
      otherProject(),
    ],
    current: FERRETRY_ID as never,
  });
  taskView: BoardTaskView | undefined;
  taskLaneSet: LaneSet | null = laneSet();
  sessionList: readonly SessionDirectoryEntry[] = directory;
  createError: unknown;
  actError: unknown;
  readonly actFailures = new Map<string, unknown>();

  board(query: BoardQueryInput) {
    this.boardCalls.push(query);
    return Promise.resolve(this.boardResponse);
  }

  task(id: string): Promise<BoardTaskResponse> {
    this.taskCalls.push(id);
    return Promise.resolve(taskResponse(this.taskView ?? card({ id }), this.taskLaneSet));
  }

  create(as: string | undefined, request: BoardTaskCreateRequestInput): Promise<BoardTaskResponse> {
    this.createCalls.push({ as, request });
    if (this.createError !== undefined) return Promise.reject(this.createError);
    return Promise.resolve(taskResponse(card({ id: 'F2' }), laneSet()));
  }

  act(as: string | undefined, id: string, request: BoardTaskActionRequestInput): Promise<BoardTaskResponse> {
    this.actCalls.push({ as, id, request });
    if (this.actError !== undefined) return Promise.reject(this.actError);
    const url = 'pr' in request ? request.pr : undefined;
    if (url !== undefined && this.actFailures.has(url)) return Promise.reject(this.actFailures.get(url));
    return Promise.resolve(
      taskResponse(
        card({
          id,
          links: {
            prs: url ? [pr({ url, number: Number(url.split('/').at(-1)) })] : [],
            branch: null,
            commits: [],
            docs: [],
          },
        }),
        laneSet(),
      ),
    );
  }

  skip(as: string | undefined, request: BoardSkipRequest): Promise<BoardSkipResponse> {
    this.skipCalls.push({ as, request });
    if (this.actError !== undefined) return Promise.reject(this.actError);
    return Promise.resolve({ sessionId: as ?? '', skip: { reason: request.reason, at: '2026-10-30T10:00:00.000Z' } });
  }

  projects(as: string | undefined) {
    this.projectCalls.push(as);
    return Promise.resolve(this.listingResponse);
  }

  sessions() {
    return Promise.resolve(this.sessionList);
  }
}

class FakeFiles implements ITextFileReader {
  readonly reads: string[] = [];

  constructor(private readonly contents: Readonly<Record<string, string>> = { '/brief.md': 'the brief from a file' }) {}

  readText(path: string) {
    this.reads.push(path);
    const text = this.contents[path];
    return text === undefined ? Promise.reject(new Error(`no such file ${path}`)) : Promise.resolve(text);
  }
}

const harness = (
  gateway = new FakeGateway(),
  environmentSessionId: string | undefined = undefined,
  files = new FakeFiles(),
) => {
  const log: string[] = [];
  const output: IBoardOutput = {
    success: message => log.push(`ok: ${message}`),
    report: message => log.push(`report: ${message}`),
    diagnostic: message => log.push(`diag: ${message}`),
  };
  const controller = new BoardController({ gateway, output, files, binary: 'fy', environmentSessionId });
  return { gateway, files, log, controller };
};

const sent = (gateway: FakeGateway) => gateway.actCalls.map(call => call.request);

const refusal = async (work: () => Promise<unknown> | unknown): Promise<string> => {
  const failure = await Promise.resolve()
    .then(work)
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  should(failure).be.an.Error();
  should((failure as Error).name).equal('CliInputError');
  return (failure as Error).message;
};

describe('sessionNames', () => {
  it('should read a callsign when the directory has one, else the id', () => {
    // Arrange
    const names = sessionNames(directory);

    // Act + Assert
    should(names(DENISHA)).equal('denisha');
    should(names('sess-anon-0003')).equal('sess-anon-0003');
    should(names('unknown')).equal('unknown');
  });
});

describe('resolveSessionRef', () => {
  it('should take a session id, a callsign in any case, or @callsign', () => {
    // Act + Assert
    should(resolveSessionRef(KIRIN, directory)).equal(KIRIN);
    should(resolveSessionRef('denisha', directory)).equal(DENISHA);
    should(resolveSessionRef('DENISHA', directory)).equal(DENISHA);
    should(resolveSessionRef(' @kirin ', directory)).equal(KIRIN);
  });

  it('should refuse a blank name and a name nobody has', async () => {
    // Act + Assert
    should(await refusal(() => resolveSessionRef('  ', directory))).match(/name a session/u);
    should(await refusal(() => resolveSessionRef('@', directory))).match(/name a session/u);
    should(await refusal(() => resolveSessionRef('ghost', directory))).match(/no session "ghost"; use a callsign/u);
  });
});

describe('resolveLaneRef', () => {
  it('should resolve a lane by id or by name in any case', () => {
    // Act + Assert
    should(resolveLaneRef(laneSet(), 'review')).equal('review');
    should(resolveLaneRef(laneSet(), 'Review/CI')).equal('review');
    should(resolveLaneRef(laneSet(), ' plan/design ')).equal('plan');
  });

  it('should pass the word through when the project has no lane set', () => {
    // Act + Assert
    should(resolveLaneRef(null, ' doing ')).equal('doing');
  });

  it('should refuse an unknown lane and list the lanes there are', async () => {
    // Act + Assert
    should(await refusal(() => resolveLaneRef(laneSet(), 'nowhere'))).equal(
      'no lane "nowhere" on this board; lanes: todo (Todo), plan (Plan/Design), implement (Implement), review (Review/CI), merged (Merged)',
    );
  });
});

describe('fy board', () => {
  it('should show the calling session’s project by default, asking for a whole page', async () => {
    // Arrange
    const { controller, gateway, log } = harness();

    // Act
    await controller.board({});

    // Assert
    should(gateway.boardCalls).eql([{ project: FERRETRY_ID, limit: 500 }]);
    should(log).have.length(1);
    should(log[0]).startWith('ok: Ferretry — 0 cards');
  });

  it('should show every project for --project all, in any case', async () => {
    // Arrange
    const { controller, gateway, log } = harness();
    gateway.boardResponse = response({ projectId: null, laneSet: null });

    // Act
    await controller.board({ project: 'ALL' });
    await controller.board({ project: ALL_PROJECTS });

    // Assert
    should(gateway.boardCalls).eql([{ limit: 500 }, { limit: 500 }]);
    should(log[0]).startWith('ok: all projects — 0 cards');
  });

  it('should show every project when the session has no project and none is named', async () => {
    // Arrange
    const { controller, gateway } = harness();
    gateway.listingResponse = listing({ current: null });

    // Act
    await controller.board({ project: '  ' });

    // Assert
    should(gateway.boardCalls).eql([{ limit: 500 }]);
  });

  it('should resolve --project by name or id and refuse an unknown board', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act
    await controller.board({ project: 'other' });
    await controller.board({ project: FERRETRY_ID });

    // Assert
    should(gateway.boardCalls.map(query => query.project)).eql([OTHER_ID, FERRETRY_ID]);
    should(await refusal(() => controller.board({ project: 'nope' }))).match(/no project "nope"; boards: /u);
  });

  it('should pass the filters through to the query', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act
    await controller.board({ kind: 'bug', pr: 'open', activity: 'stale', closed: true, query: 'widget' });

    // Assert
    should(gateway.boardCalls[0]).eql({
      project: FERRETRY_ID,
      kind: 'bug',
      prState: 'open',
      activity: 'stale',
      state: 'closed',
      query: 'widget',
      limit: 500,
    });
  });

  it('should require a session for --mine, and then filter on it', async () => {
    // Arrange
    const outside = harness();
    const inside = harness(new FakeGateway(), DENISHA);

    // Act
    await inside.controller.board({ mine: true });

    // Assert
    should(await refusal(() => outside.controller.board({ mine: true }))).match(/--mine needs a session/u);
    should(inside.gateway.boardCalls[0]).containEql({ ferret: DENISHA });
  });

  it('should prefer --session to the environment session, and send it with the projects call', async () => {
    // Arrange
    const { controller, gateway } = harness(new FakeGateway(), DENISHA);

    // Act
    await controller.board({ mine: true, session: ` ${KIRIN} ` });
    await controller.board({});

    // Assert
    should(gateway.boardCalls[0]).containEql({ ferret: KIRIN });
    should(gateway.projectCalls).eql([KIRIN, DENISHA]);
  });

  it('should resolve --ferret by callsign and refuse a ferret nobody knows', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act
    await controller.board({ ferret: '@Kirin' });

    // Assert
    should(gateway.boardCalls[0]).containEql({ ferret: KIRIN });
    should(await refusal(() => controller.board({ ferret: 'ghost' }))).match(/no session "ghost"/u);
  });

  it('should refuse --mine together with --ferret', async () => {
    // Arrange
    const { controller } = harness(new FakeGateway(), DENISHA);

    // Act + Assert
    should(await refusal(() => controller.board({ mine: true, ferret: 'kirin' }))).match(
      /pass --mine or --ferret, not both/u,
    );
  });

  it('should print the daemon’s answer as JSON on request', async () => {
    // Arrange
    const { controller, gateway, log } = harness();
    gateway.boardResponse = response({ cards: [card()] });

    // Act
    await controller.board({ json: true });

    // Assert
    should(JSON.parse(log[0]?.slice(4) ?? '')).eql(JSON.parse(JSON.stringify(gateway.boardResponse)));
  });

  it('should print a markdown report on request', async () => {
    // Arrange
    const { controller, gateway, log } = harness();
    gateway.boardResponse = response({ cards: [card()] });

    // Act
    await controller.board({ md: true });

    // Assert
    should(log[0])
      .startWith('ok: # Ferretry — 1 cards')
      .and.containEql('| &F1 | Rename the widget | denisha | idle | no PR |');
  });

  it('should show callsigns, not session ids, in the rows', async () => {
    // Arrange
    const { controller, gateway, log } = harness();
    gateway.boardResponse = response({ cards: [card({ owner: DENISHA, assignee: KIRIN })] });

    // Act
    await controller.board({});

    // Assert
    should(log[0]).containEql('denisha→Kirin');
  });
});

describe('fy task show', () => {
  it('should show one card without asking for children when it has none', async () => {
    // Arrange
    const { controller, gateway, log } = harness();

    // Act
    await controller.show('#F412', {});

    // Assert
    should(gateway.taskCalls).eql(['F412']);
    should(gateway.boardCalls).eql([]);
    should(log[0]).startWith('ok: &F412  Rename the widget  [feature]');
  });

  it('should fetch the children only when the roll-up counts some, and keep only the card’s own', async () => {
    // Arrange
    const { controller, gateway, log } = harness();
    gateway.taskView = card({
      id: 'F5',
      rollup: {
        children: 1,
        byCategory: { backlog: 1, active: 0, review: 0, shipped: 0, verify: 0, closed: 0 },
        active: 0,
        lastTouchedAt: null,
      },
    });
    gateway.boardResponse = response({
      cards: [
        card({ id: 'F6', title: 'Child one', parent: { id: 'F5' } }),
        card({ id: 'F7', title: 'Stranger', parent: { id: 'F9' } }),
      ],
    });

    // Act
    await controller.show('F5', {});

    // Assert
    should(gateway.boardCalls).eql([{ project: FERRETRY_ID, state: 'all', limit: 500 }]);
    should(log[0]).containEql('&F6  Child one').and.not.containEql('Stranger');
  });

  it('should print the card, its lanes and its children as JSON on request', async () => {
    // Arrange
    const { controller, log } = harness();

    // Act
    await controller.show('F1', { json: true });

    // Assert
    const printed = JSON.parse(log[0]?.slice(4) ?? '') as {
      task: { id: string };
      laneSet: { version: number };
      children: unknown[];
    };
    should(printed.task.id).equal('F1');
    should(printed.laneSet.version).equal(3);
    should(printed.children).eql([]);
  });

  it('should refuse an id it cannot read before asking the daemon', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act + Assert
    should(await refusal(() => controller.show('junk', {}))).match(/expected a task id like &F21/u);
    should(gateway.taskCalls).eql([]);
  });
});

describe('fy task create', () => {
  const base = { kind: 'feature', title: 'Rename widget', ask: 'rename it', askSource: 'chat://1' };

  it('should create on the session’s own board and say where the card stands', async () => {
    // Arrange
    const { controller, gateway, log } = harness(new FakeGateway(), DENISHA);

    // Act
    await controller.create([], base);

    // Assert
    should(gateway.createCalls).have.length(1);
    should(gateway.createCalls[0]?.as).equal(DENISHA);
    should(gateway.createCalls[0]?.request).not.have.property('projectId');
    should(gateway.createCalls[0]?.request).containEql({
      kind: 'feature',
      title: 'Rename widget',
      assignee: null,
      brief: '',
    });
    should(log).eql(['ok: &F2 created — Todo, denisha, idle']);
  });

  it('should take the title from the trailing words', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act
    await controller.create(['Fix', 'the', 'thing'], { ...base, title: undefined });

    // Assert
    should(gateway.createCalls[0]?.request.title).equal('Fix the thing');
  });

  it('should resolve --project by name to its id', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act
    await controller.create([], { ...base, project: 'Other' });

    // Assert
    should(gateway.createCalls[0]?.request.projectId).equal(OTHER_ID);
    should(await refusal(() => controller.create([], { ...base, project: 'nope' }))).match(/no project "nope"/u);
  });

  it('should resolve the assignee callsign to a session id and refuse an unknown one', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act
    await controller.create([], { ...base, assignee: '@kirin' });

    // Assert
    should(gateway.createCalls[0]?.request.assignee).equal(KIRIN);
    should(await refusal(() => controller.create([], { ...base, assignee: 'ghost' }))).match(/no session "ghost"/u);
  });

  it('should read the brief from --brief-file', async () => {
    // Arrange
    const { controller, gateway, files } = harness();

    // Act
    await controller.create([], { ...base, briefFile: ' /brief.md ' });

    // Assert
    should(files.reads).eql(['/brief.md']);
    should(gateway.createCalls[0]?.request.brief).equal('the brief from a file');
  });

  it('should use --brief as given, and refuse both --brief and --brief-file', async () => {
    // Arrange
    const { controller, gateway, files } = harness();

    // Act
    await controller.create([], { ...base, brief: 'inline' });

    // Assert
    should(gateway.createCalls[0]?.request.brief).equal('inline');
    should(await refusal(() => controller.create([], { ...base, brief: 'x', briefFile: '/brief.md' }))).match(
      /pass --brief or --brief-file, not both/u,
    );
    should(files.reads).eql([]);
  });

  it('should let a missing brief file fail as the reader reports it', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act
    const failure = await controller.create([], { ...base, briefFile: '/missing.md' }).catch((error: unknown) => error);

    // Assert
    should((failure as Error).message).equal('no such file /missing.md');
    should(gateway.createCalls).eql([]);
  });

  it('should refuse a bad create before calling the daemon', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act + Assert
    should(await refusal(() => controller.create([], { ...base, kind: undefined }))).match(/--kind is required/u);
    should(await refusal(() => controller.create([], { ...base, pr: ['nonsense'] }))).match(
      /--pr takes a GitHub pull request URL/u,
    );
    should(gateway.createCalls).eql([]);
    should(gateway.projectCalls.length).be.belowOrEqual(1);
  });

  it('should attach each --pr as a link action after the card exists, and show the card as it ends up', async () => {
    // Arrange
    const { controller, gateway, log } = harness(new FakeGateway(), DENISHA);

    // Act
    await controller.create([], { ...base, pr: [PR_ONE, PR_TWO] });

    // Assert
    should(gateway.actCalls).eql([
      { as: DENISHA, id: 'F2', request: { action: 'link', pr: PR_ONE } },
      { as: DENISHA, id: 'F2', request: { action: 'link', pr: PR_TWO } },
    ]);
    should(log).eql(['ok: &F2 created — Todo, denisha, idle']);
  });

  it('should print the card, then say which PR link failed and how to retry, and refuse', async () => {
    // Arrange
    const { controller, gateway, log } = harness();
    gateway.actFailures.set(PR_TWO, new Error('GitHub said no'));
    gateway.actFailures.set('https://github.com/kirinnee/ferretry/pull/3', 'plain string failure');

    // Act
    const message = await refusal(() =>
      controller.create([], { ...base, pr: [PR_ONE, PR_TWO, 'https://github.com/kirinnee/ferretry/pull/3'] }),
    );

    // Assert
    should(message).equal('2 PR link(s) did not attach');
    should(log).have.length(3);
    should(log[0]).startWith('ok: &F2 created');
    should(log[1]).equal(
      `diag: &F2 was created but the PR link failed — ${PR_TWO}: GitHub said no\nlink it again: fy task link &F2 --pr <url>`,
    );
    should(log[2]).containEql('pull/3: plain string failure');
  });

  it('should print JSON on request', async () => {
    // Arrange
    const { controller, log } = harness();

    // Act
    await controller.create([], { ...base, json: true });

    // Assert
    should(JSON.parse(log[0]?.slice(4) ?? '').task.id).equal('F2');
  });

  it('should explain a project with no lanes and print the exact command that fixes it', async () => {
    // Arrange
    const { controller, gateway } = harness();
    gateway.createError = new FyHttpError('Other has no lanes', 409, 'no-lane-set');

    // Act
    const message = await refusal(() => controller.create([], { ...base, project: 'Other' }));

    // Assert
    should(message).containEql('Other has no lanes (no-lane-set)');
    should(message).containEql(
      'fy board lanes propose --template <pr-release-verify|pr-release|pr|ops|writing|quick> --project Other',
    );
  });

  it('should name the session’s own board in that command when no --project was given', async () => {
    // Arrange
    const { controller, gateway } = harness();
    gateway.createError = new FyHttpError('no lanes', 409, 'no-lane-set');

    // Act
    const message = await refusal(() => controller.create([], base));

    // Assert
    should(message).containEql('--project Ferretry');
  });

  it('should leave the placeholder in that command when the session has no board', async () => {
    // Arrange
    const { controller, gateway } = harness();
    gateway.listingResponse = listing({ current: null });
    gateway.createError = new FyHttpError('no lanes', 409, 'no-lane-set');

    // Act
    const message = await refusal(() => controller.create([], base));

    // Assert
    should(message).containEql('--project <project>');
  });

  it('should let a failure that is not a board refusal through', async () => {
    // Arrange
    const { controller, gateway } = harness();
    gateway.createError = new Error('socket closed');

    // Act
    const failure = await controller.create([], base).catch((error: unknown) => error);

    // Assert
    should((failure as Error).message).equal('socket closed');
    should((failure as Error).name).not.equal('CliInputError');
  });
});

describe('the action verbs', () => {
  it('should move to a lane by id or by name, and say where the card stands', async () => {
    // Arrange
    const { controller, gateway, log } = harness(new FakeGateway(), DENISHA);

    // Act
    await controller.move('#F1', 'implement', { reason: ' go ' });
    await controller.move('&F1', 'Review/CI', {});

    // Assert
    should(sent(gateway)).eql([
      { action: 'move', to: 'implement', reason: 'go' },
      { action: 'move', to: 'review' },
    ]);
    should(gateway.actCalls[0]).containEql({ as: DENISHA, id: 'F1' });
    should(log[0]).equal('ok: &F1 moved — Todo, denisha, idle');
  });

  it('should refuse a move to a lane the board does not have, listing the lanes', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act
    const message = await refusal(() => controller.move('F1', 'nowhere', {}));

    // Assert
    should(message).match(/^no lane "nowhere" on this board; lanes: todo \(Todo\), plan \(Plan\/Design\)/u);
    should(gateway.actCalls).eql([]);
  });

  it('should send a move on as typed when the project has no lane set', async () => {
    // Arrange
    const { controller, gateway } = harness();
    gateway.taskLaneSet = null;

    // Act
    await controller.move('F1', 'doing', {});

    // Assert
    should(sent(gateway)).eql([{ action: 'move', to: 'doing' }]);
  });

  it('should send a focus, a block, an unblock, a drop and a note', async () => {
    // Arrange
    const { controller, gateway, log } = harness();

    // Act
    await controller.focus('F1', {});
    await controller.block('F1', ['waiting', 'on', 'vendor'], {});
    await controller.unblock('F1', { reason: 'fixed' });
    await controller.drop('F1', { reason: 'superseded' });
    await controller.note('F1', ['hello', 'there'], {});

    // Assert
    should(sent(gateway)).eql([
      { action: 'focus' },
      { action: 'block', reason: 'waiting on vendor' },
      { action: 'unblock', reason: 'fixed' },
      { action: 'drop', reason: 'superseded' },
      { action: 'note', text: 'hello there' },
    ]);
    should(log.map(line => line.split(' — ')[0])).eql([
      'ok: &F1 is now your focus',
      'ok: &F1 blocked',
      'ok: &F1 unblocked',
      'ok: &F1 dropped',
      'ok: &F1 noted',
    ]);
  });

  it('should record a skip on the calling session, with the words as one reason', async () => {
    // Arrange
    const { controller, gateway, log } = harness(new FakeGateway(), DENISHA);

    // Act
    await controller.skip(['the', 'owner', 'said', 'not', 'to', 'track', 'this'], {});
    await controller.skip(['chit-chat'], { session: 'other-session', json: true });

    // Assert
    should(gateway.skipCalls).eql([
      { as: DENISHA, request: { reason: 'the owner said not to track this' } },
      { as: 'other-session', request: { reason: 'chit-chat' } },
    ]);
    should(log[0]).equal(
      'ok: no card for this work — the owner said not to track this. The board check stays quiet until you take a card.',
    );
    should(JSON.parse((log[1] as string).slice('ok: '.length))).match({
      sessionId: 'other-session',
      skip: { reason: 'chit-chat' },
    });
  });

  it('should refuse a skip with no reason, or with no session to record it on', async () => {
    // Arrange
    const { controller, gateway } = harness();
    const ferret = harness(new FakeGateway(), DENISHA);

    // Act + Assert
    should(await refusal(() => controller.skip(['chat'], {}))).match(/run it from a ferret's pane, or pass --session/u);
    should(await refusal(() => ferret.controller.skip(['  '], {}))).match(
      /say why this work needs no card: fy task skip/u,
    );
    should(gateway.skipCalls).eql([]);
    should(ferret.gateway.skipCalls).eql([]);
  });

  it('should send a depend and an undepend', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act
    await controller.depend('F1', '#F2', { until: 'released' });
    await controller.undepend('F1', '&F2', { reason: 'moot' });

    // Assert
    should(sent(gateway)).eql([
      { action: 'depend', task: { id: 'F2' }, until: 'released' },
      { action: 'undepend', task: { id: 'F2' }, reason: 'moot' },
    ]);
  });

  it('should reopen into a lane named by its name, with the owner’s words', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act
    await controller.reopen('F1', { to: 'Plan/Design', ask: 'actually do more', source: 'chat://9' });

    // Assert
    should(sent(gateway)).eql([
      {
        action: 'reopen',
        to: 'plan',
        reason: 'reopened with a new ask',
        ask: { text: 'actually do more', source: 'chat://9' },
      },
    ]);
  });

  it('should refuse a reopen with no lane, or into a lane the board does not have', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act + Assert
    should(await refusal(() => controller.reopen('F1', { ask: 'more' }))).match(/reopen needs --to <lane>/u);
    should(await refusal(() => controller.reopen('F1', { to: 'nowhere', ask: 'more' }))).match(/no lane "nowhere"/u);
    should(gateway.actCalls).eql([]);
  });

  it('should send a clarify and a link', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act
    await controller.clarify('F1', ['also', 'docs'], { source: 'chat://3' });
    await controller.link('F1', { pr: PR_ONE });

    // Assert
    should(sent(gateway)).eql([
      { action: 'clarify', text: 'also docs', source: 'chat://3' },
      { action: 'link', pr: PR_ONE },
    ]);
  });

  it('should assign by callsign, or to nobody with --none', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act
    await controller.assign('F1', 'kirin', {});
    await controller.assign('F1', undefined, { none: true });

    // Assert
    should(sent(gateway)).eql([
      { action: 'assign', assignee: KIRIN },
      { action: 'assign', assignee: null },
    ]);
  });

  it('should refuse an assign that names both a session and --none, or neither, or a stranger', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act + Assert
    should(await refusal(() => controller.assign('F1', 'kirin', { none: true }))).match(
      /pass a session or --none, not both/u,
    );
    should(await refusal(() => controller.assign('F1', undefined, {}))).match(/assign needs a session/u);
    should(await refusal(() => controller.assign('F1', 'ghost', {}))).match(/no session "ghost"/u);
    should(gateway.actCalls).eql([]);
  });

  it('should send an order and a file claim', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act
    await controller.order('F1', '3', {});
    await controller.order('F1', undefined, { none: true });
    await controller.file('F1', 'src/a.ts', {});
    await controller.file('F1', 'src/a.ts', { remove: true, reason: 'done' });

    // Assert
    should(sent(gateway)).eql([
      { action: 'order', order: 3 },
      { action: 'order', order: null },
      { action: 'file', path: 'src/a.ts' },
      { action: 'file', path: 'src/a.ts', release: true, reason: 'done' },
    ]);
  });

  it('should send a re-parent, under a card or with --none', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act
    await controller.reparent('F1', { parent: 'F85', reason: 'fits' });
    await controller.reparent('F1', { none: true });

    // Assert
    should(sent(gateway)).eql([
      { action: 'reparent', parent: { id: 'F85' }, reason: 'fits' },
      { action: 'reparent', parent: null },
    ]);
  });

  it('should edit with fields, or with the brief read from --brief-file', async () => {
    // Arrange
    const { controller, gateway, files } = harness();

    // Act
    await controller.edit('F1', { title: 'New name', summary: 'sum' });
    await controller.edit('F1', { briefFile: '/brief.md' });
    await controller.edit('F1', { brief: 'inline' });

    // Assert
    should(sent(gateway)).eql([
      { action: 'edit', title: 'New name', summary: 'sum' },
      { action: 'edit', brief: 'the brief from a file' },
      { action: 'edit', brief: 'inline' },
    ]);
    should(files.reads).eql(['/brief.md']);
    should(await refusal(() => controller.edit('F1', { brief: 'x', briefFile: '/brief.md' }))).match(
      /pass --brief or --brief-file, not both/u,
    );
    should(await refusal(() => controller.edit('F1', {}))).match(/nothing to edit/u);
  });

  it('should refile to another project, resolving the lane against that project’s own lanes', async () => {
    // Arrange
    const { controller, gateway } = harness(new FakeGateway(), DENISHA);

    // Act
    await controller.refile('F1', { project: 'Other', lane: 'Investigate', reason: ' wrong board ' });
    await controller.refile('F1', { project: OTHER_ID });

    // Assert
    should(sent(gateway)).eql([
      { action: 'refile', projectId: OTHER_ID, laneId: 'investigate', reason: 'wrong board' },
      { action: 'refile', projectId: OTHER_ID },
    ]);
    should(gateway.projectCalls).eql([DENISHA, DENISHA]);
  });

  it('should refuse a refile with no project, an unknown project, or a lane the target lacks', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act + Assert
    should(await refusal(() => controller.refile('F1', {}))).match(/refile needs --project <name>/u);
    should(await refusal(() => controller.refile('F1', { project: 'nope' }))).match(/no project "nope"/u);
    should(await refusal(() => controller.refile('F1', { project: 'Other', lane: 'review' }))).match(
      /no lane "review" on this board; lanes: todo \(Todo\), investigate \(Investigate\)/u,
    );
    should(gateway.actCalls).eql([]);
  });

  it('should act as the --session flag, else the environment session, else the owner', async () => {
    // Arrange
    const ferret = harness(new FakeGateway(), DENISHA);
    const owner = harness();

    // Act
    await ferret.controller.note('F1', ['a'], {});
    await ferret.controller.note('F1', ['b'], { session: KIRIN });
    await owner.controller.note('F1', ['c'], {});

    // Assert
    should(ferret.gateway.actCalls.map(call => call.as)).eql([DENISHA, KIRIN]);
    should(owner.gateway.actCalls.map(call => call.as)).eql([undefined]);
  });

  it('should print the daemon’s answer as JSON on request', async () => {
    // Arrange
    const { controller, log } = harness();

    // Act
    await controller.note('F1', ['a'], { json: true });

    // Assert
    should(JSON.parse(log[0]?.slice(4) ?? '').task.id).equal('F1');
  });

  it('should refuse an id it cannot read, for every verb that takes one', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act + Assert
    should(await refusal(() => controller.focus('junk', {}))).match(/expected a task id/u);
    should(await refusal(() => controller.move('junk', 'todo', {}))).match(/expected a task id/u);
    should(await refusal(() => controller.refile('junk', { project: 'Other' }))).match(/expected a task id/u);
    should(gateway.actCalls).eql([]);
  });

  it('should explain a refusal from the daemon with who may do it instead', async () => {
    // Arrange
    const { controller, gateway } = harness();
    gateway.actError = new FyHttpError('only the owner may drop this', 403, 'forbidden', {
      allowed: ['owner-human', 'owner'],
    });

    // Act
    const message = await refusal(() => controller.drop('F1', { reason: 'x' }));

    // Assert
    should(message).equal(
      [
        'only the owner may drop this (forbidden)',
        'who may do this instead:',
        '  - the owner (a person, from the app or the CLI outside a ferret)',
        "  - the card's owner ferret",
      ].join('\n'),
    );
  });

  it('should let a failure that is not a board refusal through', async () => {
    // Arrange
    const { controller, gateway } = harness();
    gateway.actError = new Error('socket closed');

    // Act
    const failure = await controller.focus('F1', {}).catch((error: unknown) => error);

    // Assert
    should((failure as Error).message).equal('socket closed');
  });
});

describe('the v1 spellings', () => {
  it('should refuse fy task status with the move that replaces it', async () => {
    // Arrange
    const { controller } = harness();

    // Act
    const message = await refusal(() => controller.retiredStatus('#F21', 'done', undefined));

    // Assert
    should(message.split('\n')).eql([
      '`fy task status` is retired: a task now moves between the lanes of its project’s board.'.replace('’', "'"),
      'use: fy task move &F21 <lane> --reason "now done"',
      'see the lanes: fy board lanes show',
    ]);
  });

  it('should carry the reason the person gave into the spelling, quoting it safely', async () => {
    // Arrange
    const { controller } = harness();

    // Act
    const message = await refusal(() => controller.retiredStatus('F21', 'done', 'it said "ship"'));

    // Assert
    should(message).containEql('use: fy task move &F21 <lane> --reason "it said \\"ship\\""');
  });

  it('should refuse fy task phase with the move that replaces it', async () => {
    // Arrange
    const { controller } = harness();

    // Act
    const message = await refusal(() => controller.retiredPhase('&f21', 'review', undefined));

    // Assert
    should(message.split('\n')).eql([
      '`fy task phase` is retired: audit phases are lanes now.',
      'use: fy task move &F21 <lane> --reason "now review"',
      'see the lanes: fy board lanes show',
    ]);
    should(await refusal(() => controller.retiredPhase('F21', 'review', 'because'))).containEql('--reason "because"');
  });

  it('should refuse an id it cannot read even when the verb is retired', async () => {
    // Arrange
    const { controller } = harness();

    // Act + Assert
    should(await refusal(() => controller.retiredStatus('junk', 'done', undefined))).match(
      /expected a task id like &F21/u,
    );
    should(await refusal(() => controller.retiredPhase('junk', 'review', undefined))).match(/expected a task id/u);
  });

  it('should record feedback as a note, saying so on stderr', async () => {
    // Arrange
    const { controller, gateway, log } = harness();

    // Act
    await controller.feedback('F1', ['too', 'slow'], {});

    // Assert
    should(log[0]).equal('diag: `fy task feedback` is retired; recording it as a note: fy task note &F1 "feedback: …"');
    should(sent(gateway)).eql([{ action: 'note', text: 'feedback: too slow' }]);
    should(log[1]).startWith('ok: &F1 noted');
  });

  it('should list as the board --mine, saying so', async () => {
    // Arrange
    const { controller, gateway, log } = harness(new FakeGateway(), DENISHA);

    // Act
    await controller.listShim({ kind: 'bug', query: 'x' });

    // Assert
    should(log[0]).startWith('diag: `fy task list` is now `fy board --mine`');
    should(gateway.boardCalls[0]).eql({ project: FERRETRY_ID, ferret: DENISHA, kind: 'bug', query: 'x', limit: 500 });
    should(log[1]).startWith('ok: Ferretry');
  });

  it('should list everybody’s as the board across projects with --all', async () => {
    // Arrange
    const { controller, gateway, log } = harness();
    gateway.boardResponse = response({ projectId: null, laneSet: null });

    // Act
    await controller.listShim({ all: true, md: true });

    // Assert
    should(log[0]).startWith('diag: `fy task list` is now `fy board --project all`');
    should(gateway.boardCalls[0]).eql({ limit: 500 });
    should(log[1]).startWith('ok: # all projects');
  });

  it('should refuse the --mine list outside a ferret', async () => {
    // Arrange
    const { controller } = harness();

    // Act + Assert
    should(await refusal(() => controller.listShim({}))).match(/--mine needs a session/u);
  });
});
