import { describe, it } from 'bun:test';
import type {
  BoardProjectsResponse,
  BoardQueryInput,
  BoardResponse,
  BoardSkipRequest,
  BoardSkipResponse,
  CardActionRequestInput,
  CardCreateRequestInput,
  CardResponse,
  CardView,
  LaneSet,
} from '../../../contract/index.ts';
import type { RelatedResponse } from '../../../cli/lib/related.ts';
import should from 'should';
import {
  ALL_PROJECTS,
  BoardController,
  resolveLaneRef,
  resolveFerretRef,
  ferretNames,
} from '../../../cli/lib/board-controller.ts';
import type { BoardGateway, BoardOutput, FerretDirectoryEntry, TextFiles } from '../../../cli/lib/ports.ts';
import { RelatedCheck } from '../../../cli/lib/related.ts';
import { askHit, CapturingOutput, cardHit, FakeRelatedGateway } from './related-fixtures.ts';
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
  cardResponse,
} from './fixtures.ts';

const PR_ONE = 'https://github.com/kirinnee/ferretry/pull/1';
const PR_TWO = 'https://github.com/kirinnee/ferretry/pull/2';

class DaemonRefusal extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

class FakeGateway implements BoardGateway {
  readonly boardCalls: BoardQueryInput[] = [];
  readonly cardCalls: string[] = [];
  projectCalls = 0;
  readonly createCalls: { request: CardCreateRequestInput }[] = [];
  readonly actCalls: { id: string; request: CardActionRequestInput }[] = [];
  readonly skipCalls: { request: BoardSkipRequest }[] = [];

  boardResponse: BoardResponse = response();
  listingResponse: BoardProjectsResponse = listing({
    projects: [
      project({ id: 'unfiled' as never, name: 'Unfiled', path: null, laneSet: null }),
      project(),
      otherProject(),
    ],
    current: FERRETRY_ID as never,
  });
  cardView: CardView | undefined;
  cardLaneSet: LaneSet | null = laneSet();
  ferretList: readonly FerretDirectoryEntry[] = directory;
  createError: unknown;
  actError: unknown;
  readonly actFailures = new Map<string, unknown>();

  board(query: BoardQueryInput) {
    this.boardCalls.push(query);
    return Promise.resolve(this.boardResponse);
  }

  card(id: string): Promise<CardResponse> {
    this.cardCalls.push(id);
    return Promise.resolve(cardResponse(this.cardView ?? card({ id }), this.cardLaneSet));
  }

  create(request: CardCreateRequestInput): Promise<CardResponse> {
    this.createCalls.push({ request });
    if (this.createError !== undefined) return Promise.reject(this.createError);
    return Promise.resolve(cardResponse(card({ id: 'F2' }), laneSet()));
  }

  act(id: string, request: CardActionRequestInput): Promise<CardResponse> {
    this.actCalls.push({ id, request });
    if (this.actError !== undefined) return Promise.reject(this.actError);
    const url = 'pr' in request ? request.pr : undefined;
    if (url !== undefined && this.actFailures.has(url)) return Promise.reject(this.actFailures.get(url));
    return Promise.resolve(
      cardResponse(
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

  skip(request: BoardSkipRequest): Promise<BoardSkipResponse> {
    this.skipCalls.push({ request });
    if (this.actError !== undefined) return Promise.reject(this.actError);
    return Promise.resolve({ ferret: DENISHA, skip: { reason: request.reason, at: '2026-10-30T10:00:00.000Z' } });
  }

  projects() {
    this.projectCalls += 1;
    return Promise.resolve(this.listingResponse);
  }

  mergeGate() {
    return Promise.resolve({ pr: PR_ONE, unit: [], waits: [], unreadable: [] });
  }

  related() {
    return Promise.resolve({ matches: [] });
  }

  ferrets() {
    return Promise.resolve(this.ferretList);
  }
}

class FakeFiles implements TextFiles {
  readonly reads: string[] = [];

  constructor(private readonly contents: Readonly<Record<string, string>> = { '/brief.md': 'the brief from a file' }) {}

  readText(path: string) {
    this.reads.push(path);
    const text = this.contents[path];
    return text === undefined ? Promise.reject(new Error(`no such file ${path}`)) : Promise.resolve(text);
  }
}

const harness = (gateway = new FakeGateway(), ownFerret: string | undefined = undefined, files = new FakeFiles()) => {
  const log: string[] = [];
  const output: BoardOutput = {
    success: message => log.push(`ok: ${message}`),
    diagnostic: message => log.push(`diag: ${message}`),
  };
  const controller = new BoardController({ gateway, output, files, binary: 'fy', ownFerret });
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

describe('ferretNames', () => {
  it('should read a callsign when the directory has one, else the id', () => {
    // Arrange
    const names = ferretNames(directory);

    // Act + Assert
    should(names(DENISHA)).equal('denisha');
    should(names('sess-anon-0003')).equal('sess-anon-0003');
    should(names('unknown')).equal('unknown');
  });
});

describe('resolveFerretRef', () => {
  it('should take a session id, a callsign in any case, or @callsign', () => {
    // Act + Assert
    should(resolveFerretRef(KIRIN, directory)).equal(KIRIN);
    should(resolveFerretRef('denisha', directory)).equal(DENISHA);
    should(resolveFerretRef('DENISHA', directory)).equal(DENISHA);
    should(resolveFerretRef(' @kirin ', directory)).equal(KIRIN);
  });

  it('should refuse a blank name and a name nobody has', async () => {
    // Act + Assert
    should(await refusal(() => resolveFerretRef('  ', directory))).match(/name a ferret/u);
    should(await refusal(() => resolveFerretRef('@', directory))).match(/name a ferret/u);
    should(await refusal(() => resolveFerretRef('ghost', directory))).match(/no ferret "ghost"; use a name/u);
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
    should(gateway.boardCalls).eql([{ project: FERRETRY_ID, visibility: 'public', limit: 500 }]);
    should(log).have.length(2);
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
    should(gateway.boardCalls).eql([
      { visibility: 'public', limit: 500 },
      { visibility: 'public', limit: 500 },
    ]);
    should(log[0]).startWith('ok: all projects — 0 cards');
  });

  it('should show public cards and say so, and show the rest with --private or --all', async () => {
    // Arrange
    const { controller, gateway, log } = harness();

    // Act
    await controller.board({});
    await controller.board({ private: true });
    await controller.board({ all: true });

    // Assert
    should(gateway.boardCalls.map(query => query.visibility)).eql(['public', 'private', undefined]);
    should(log.filter(line => line.includes('public cards only'))).eql([
      "ok: public cards only: fy board --private shows the ferrets' own cards, --all shows both",
    ]);
  });

  it('should show every project when the session has no project and none is named', async () => {
    // Arrange
    const { controller, gateway } = harness();
    gateway.listingResponse = listing({ current: null });

    // Act
    await controller.board({ project: '  ' });

    // Assert
    should(gateway.boardCalls).eql([{ visibility: 'public', limit: 500 }]);
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
      visibility: 'public',
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
    should(await refusal(() => outside.controller.board({ mine: true }))).match(/--mine needs a ferret/u);
    should(inside.gateway.boardCalls[0]).containEql({ ferret: DENISHA });
  });

  it('should filter --mine on the ferret this process is', async () => {
    // Arrange
    const { controller, gateway } = harness(new FakeGateway(), DENISHA);

    // Act
    await controller.board({ mine: true });
    await controller.board({});

    // Assert
    should(gateway.boardCalls[0]).containEql({ ferret: DENISHA });
    should(gateway.boardCalls[1]).not.have.property('ferret');
  });

  it('should resolve --ferret by callsign and refuse a ferret nobody knows', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act
    await controller.board({ ferret: '@Kirin' });

    // Assert
    should(gateway.boardCalls[0]).containEql({ ferret: KIRIN });
    should(await refusal(() => controller.board({ ferret: 'ghost' }))).match(/no ferret "ghost"/u);
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

describe('fy card show', () => {
  it('should show one card without asking for children when it has none', async () => {
    // Arrange
    const { controller, gateway, log } = harness();

    // Act
    await controller.show('&F412', {});

    // Assert
    should(gateway.cardCalls).eql(['F412']);
    should(gateway.boardCalls).eql([]);
    should(log[0]).startWith('ok: &F412  Rename the widget  [feature]');
  });

  it('should fetch the children only when the roll-up counts some, and keep only the card’s own', async () => {
    // Arrange
    const { controller, gateway, log } = harness();
    gateway.cardView = card({
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
      card: { id: string };
      laneSet: { version: number };
      children: unknown[];
    };
    should(printed.card.id).equal('F1');
    should(printed.laneSet.version).equal(3);
    should(printed.children).eql([]);
  });

  it('should refuse an id it cannot read before asking the daemon', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act + Assert
    should(await refusal(() => controller.show('junk', {}))).match(/expected a card id like &F21/u);
    should(gateway.cardCalls).eql([]);
  });
});

describe('fy card new', () => {
  const base = { kind: 'feature', title: 'Rename widget', ask: 'rename it', askSource: 'chat://1' };

  it('should create on the session’s own board and say where the card stands', async () => {
    // Arrange
    const { controller, gateway, log } = harness(new FakeGateway(), DENISHA);

    // Act
    await controller.create([], base);

    // Assert
    should(gateway.createCalls).have.length(1);
    should(gateway.createCalls[0]?.request).not.have.property('projectId');
    should(gateway.createCalls[0]?.request).containEql({
      kind: 'feature',
      title: 'Rename widget',
      assignee: null,
      brief: '',
    });
    should(log).eql(['ok: &F2 created — Todo, denisha, idle']);
  });

  it("should warn once that a card with the owner's words under a --parent will be private", async () => {
    // Arrange
    const { controller, log } = harness(new FakeGateway(), DENISHA);

    // Act
    await controller.create([], { ...base, parent: 'F5' });
    await controller.create([], base);

    // Assert
    should(log.filter(line => line.startsWith('diag:'))).eql([
      'diag: this card will be private (a sub-card); drop --parent so the owner sees it',
    ]);
  });

  it('should create a private or public card with --private or --public', async () => {
    // Arrange
    const { controller, gateway } = harness(new FakeGateway(), DENISHA);

    // Act
    await controller.create([], { ...base, private: true });
    await controller.create([], { ...base, public: true });

    // Assert
    should(gateway.createCalls.map(call => call.request.visibility)).eql(['private', 'public']);
  });

  it("should send the owner's Yes a card rests on, in any spelling fy agenda takes", async () => {
    // Arrange
    const { controller, gateway, log } = harness(new FakeGateway(), DENISHA);

    // Act
    await controller.create([], { ...base, approval: '!A12' });

    // Assert
    should(gateway.createCalls[0]?.request).containEql({ approval: 'A12' });
    should(log).eql(['ok: &F2 created — Todo, denisha, idle']);
  });

  it('should send the thread a card carries out, and refuse one that is not an agenda item', async () => {
    // Arrange
    const { controller, gateway } = harness(new FakeGateway(), DENISHA);

    // Act
    await controller.create([], { ...base, thread: '!A12' });
    const error = await controller.create([], { ...base, thread: 'F12' }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // Assert
    should(gateway.createCalls[0]?.request).containEql({ thread: 'A12' });
    should((error as Error).message).startWith('--thread: "F12" is not an ask reference');
    should(gateway.createCalls).have.length(1);
  });

  it('should refuse an approval that is not an agenda item before asking the daemon', async () => {
    // Arrange
    const { controller, gateway } = harness(new FakeGateway(), DENISHA);

    // Act
    const error = await controller.create([], { ...base, approval: 'F12' }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // Assert
    should(error).be.instanceOf(Error);
    should((error as Error).message).startWith('--approval: "F12" is not an ask reference');
    should(gateway.createCalls).have.length(0);
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
    should(await refusal(() => controller.create([], { ...base, assignee: 'ghost' }))).match(/no ferret "ghost"/u);
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

  it('should read How to test from --how-to-test-file, or take --how-to-test, but never both', async () => {
    // Arrange
    const { controller, gateway, files } = harness(
      new FakeGateway(),
      undefined,
      new FakeFiles({ '/test.md': '## Setup\n1. Open the Board\n\n\n2FA codes\n4. See the steps\n' }),
    );

    // Act
    await controller.create([], { ...base, howToTestFile: '/test.md' });
    await controller.create([], { ...base, howToTest: ' 1. Inline ' });

    // Assert
    should(files.reads).eql(['/test.md']);
    should(gateway.createCalls.map(call => call.request.howToTest)).eql([
      '## Setup\n1. Open the Board\n\n\n2FA codes\n4. See the steps\n',
      ' 1. Inline ',
    ]);
    should(await refusal(() => controller.create([], { ...base, howToTest: 'x', howToTestFile: '/test.md' }))).match(
      /pass --how-to-test or --how-to-test-file, not both/u,
    );
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
    should(gateway.projectCalls).be.belowOrEqual(1);
  });

  it('should attach each --pr as a link action after the card exists, and show the card as it ends up', async () => {
    // Arrange
    const { controller, gateway, log } = harness(new FakeGateway(), DENISHA);

    // Act
    await controller.create([], { ...base, pr: [PR_ONE, PR_TWO] });

    // Assert
    should(gateway.actCalls).eql([
      { id: 'F2', request: { action: 'link', pr: PR_ONE } },
      { id: 'F2', request: { action: 'link', pr: PR_TWO } },
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
      `diag: &F2 was created but the PR link failed — ${PR_TWO}: GitHub said no\nlink it again: fy card link &F2 --pr <url>`,
    );
    should(log[2]).containEql('pull/3: plain string failure');
  });

  it('should print JSON on request', async () => {
    // Arrange
    const { controller, log } = harness();

    // Act
    await controller.create([], { ...base, json: true });

    // Assert
    should(JSON.parse(log[0]?.slice(4) ?? '').card.id).equal('F2');
  });

  it('should explain a project with no lanes and print the exact command that fixes it', async () => {
    // Arrange
    const { controller, gateway } = harness();
    gateway.createError = new DaemonRefusal('Other has no lanes', 409, 'no-lane-set');

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
    gateway.createError = new DaemonRefusal('no lanes', 409, 'no-lane-set');

    // Act
    const message = await refusal(() => controller.create([], base));

    // Assert
    should(message).containEql('--project Ferretry');
  });

  it('should leave the placeholder in that command when the session has no board', async () => {
    // Arrange
    const { controller, gateway } = harness();
    gateway.listingResponse = listing({ current: null });
    gateway.createError = new DaemonRefusal('no lanes', 409, 'no-lane-set');

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
    await controller.move('&F1', 'implement', { reason: ' go ' });
    await controller.move('&F1', 'Review/CI', {});

    // Assert
    should(sent(gateway)).eql([
      { action: 'move', to: 'implement', reason: 'go' },
      { action: 'move', to: 'review' },
    ]);
    should(gateway.actCalls[0]).containEql({ id: 'F1' });
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
    gateway.cardLaneSet = null;

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

  it('should report an external event, with the reason trimmed and left out when absent', async () => {
    // Arrange
    const { controller, gateway, log } = harness();

    // Act
    await controller.trigger('&F1', ' deploy.done ', { reason: ' prod is up ' });
    await controller.trigger('F1', 'pr.review_approved', {});

    // Assert
    should(sent(gateway)).eql([
      { action: 'trigger', event: 'deploy.done', reason: 'prod is up' },
      { action: 'trigger', event: 'pr.review_approved' },
    ]);
    should(log[0]?.split(' — ')[0]).equal('ok: &F1 event reported');
  });

  it('should refuse an event that is not an external one before sending anything', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act
    const message = await refusal(() => controller.trigger('F1', 'pr.merged', {}));

    // Assert
    should(message).match(/^"pr\.merged" is not an event you can report; one of pr\.review_approved \| deploy\.done/u);
    should(gateway.actCalls).eql([]);
  });

  it('should record a skip with the words as one reason', async () => {
    // Arrange
    const { controller, gateway, log } = harness(new FakeGateway(), DENISHA);

    // Act
    await controller.skip(['the', 'owner', 'said', 'not', 'to', 'track', 'this'], {});
    await controller.skip(['chit-chat'], { json: true });

    // Assert
    should(gateway.skipCalls).eql([
      { request: { reason: 'the owner said not to track this' } },
      { request: { reason: 'chit-chat' } },
    ]);
    should(log[0]).equal(
      'ok: no card for this work — the owner said not to track this. The board check stays quiet until you take a card.',
    );
    should(JSON.parse((log[1] as string).slice('ok: '.length))).match({
      ferret: DENISHA,
      skip: { reason: 'chit-chat' },
    });
  });

  it('should refuse a skip with no reason', async () => {
    // Arrange
    const ferret = harness(new FakeGateway(), DENISHA);

    // Act + Assert
    should(await refusal(() => ferret.controller.skip(['  '], {}))).match(
      /say why this work needs no card: fy card skip/u,
    );
    should(ferret.gateway.skipCalls).eql([]);
  });

  it('should send a depend and an undepend', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act
    await controller.depend('F1', '&F2', { until: 'released' });
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

  it('should claim a card without naming anyone', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act
    await controller.claim('F1', {});

    // Assert
    should(sent(gateway)).eql([{ action: 'claim' }]);
  });

  it('should adopt a card, naming no one and carrying the reason', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act
    await controller.adopt('F1', { reason: 'both ended' });

    // Assert
    should(sent(gateway)).eql([{ action: 'adopt', reason: 'both ended' }]);
  });

  it('should refuse an assign that names both a session and --none, or neither, or a stranger', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act + Assert
    should(await refusal(() => controller.assign('F1', 'kirin', { none: true }))).match(
      /pass a ferret or --none, not both/u,
    );
    should(await refusal(() => controller.assign('F1', undefined, {}))).match(/assign needs a ferret/u);
    should(await refusal(() => controller.assign('F1', 'ghost', {}))).match(/no ferret "ghost"/u);
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

  it('should send --visibility, alone or with text, as ONE edit and print one result', async () => {
    // Arrange
    const { controller, gateway, log } = harness();

    // Act
    await controller.edit('F1', { visibility: 'private' });
    await controller.edit('F1', { title: 'New name', visibility: 'public', json: true });

    // Assert
    should(sent(gateway)).eql([
      { action: 'edit', visibility: 'private' },
      { action: 'edit', title: 'New name', visibility: 'public' },
    ]);
    should(log).have.length(2);
    should(JSON.parse(log[1]?.slice(4) ?? '').card.id).equal('F1');
    should(await refusal(() => controller.edit('F1', { visibility: 'secret' }))).match(/--visibility must be one of/u);
    should(sent(gateway)).have.length(2);
  });

  it('should edit How to test from --how-to-test or --how-to-test-file', async () => {
    // Arrange
    const { controller, gateway } = harness(new FakeGateway(), undefined, new FakeFiles({ '/test.md': '1. Open it' }));

    // Act
    await controller.edit('F1', { howToTestFile: '/test.md' });
    await controller.edit('F1', { howToTest: '1. Inline' });

    // Assert
    should(sent(gateway)).eql([
      { action: 'edit', howToTest: '1. Open it' },
      { action: 'edit', howToTest: '1. Inline' },
    ]);
  });

  it('should send only the parts --now/--done/--next name, without reading the card', async () => {
    // Arrange — the daemon merges them into the card's progress in its own write, so concurrent edits never undo each other.
    const gateway = new FakeGateway();
    gateway.cardView = card({ id: 'F1', progress: { now: 'old', doneSoFar: '- done', next: '1. next' } });
    const { controller } = harness(gateway);

    // Act
    await controller.progress('F1', { now: 'new' });
    await controller.progress('F1', { done: '- a\n- b', next: '' });

    // Assert
    should(sent(gateway)).eql([
      { action: 'edit', progress: { now: 'new' } },
      { action: 'edit', progress: { doneSoFar: '- a\n- b', next: '' } },
    ]);
    should(gateway.cardCalls).eql([]);
  });

  it('should send the whole progress from --file without reading the card, and let a flag override a part', async () => {
    // Arrange
    const files = new FakeFiles({ '/progress.yaml': 'now: from file\ndoneSoFar: |\n  - a\nnext: later\n' });
    const { controller, gateway } = harness(new FakeGateway(), undefined, files);

    // Act
    await controller.progress('F1', { file: '/progress.yaml' });
    await controller.progress('F1', { file: '/progress.yaml', next: 'sooner' });
    const bad = await refusal(() => controller.progress('F1', { file: '/progress.yaml', now: 3 as never }));

    // Assert
    should(sent(gateway).slice(0, 2)).eql([
      { action: 'edit', progress: { now: 'from file', doneSoFar: '- a\n', next: 'later' } },
      { action: 'edit', progress: { now: 'from file', doneSoFar: '- a\n', next: 'sooner' } },
    ]);
    should(gateway.cardCalls).eql([]);
    should(bad).be.a.String();
  });

  it('should refuse a progress write that names nothing', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act + Assert
    should(await refusal(() => controller.progress('F1', {}))).match(/nothing to write/u);
    should(gateway.actCalls).eql([]);
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
    should(gateway.projectCalls).be.aboveOrEqual(1);
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

  it("should send no ferret in the request: the caller's credential is the actor", async () => {
    // Arrange
    const ferret = harness(new FakeGateway(), DENISHA);

    // Act
    await ferret.controller.note('F1', ['a'], {});

    // Assert
    should(ferret.gateway.actCalls.map(call => Object.keys(call))).eql([['id', 'request']]);
  });

  it('should print the daemon’s answer as JSON on request', async () => {
    // Arrange
    const { controller, log } = harness();

    // Act
    await controller.note('F1', ['a'], { json: true });

    // Assert
    should(JSON.parse(log[0]?.slice(4) ?? '').card.id).equal('F1');
  });

  it('should refuse an id it cannot read, for every verb that takes one', async () => {
    // Arrange
    const { controller, gateway } = harness();

    // Act + Assert
    should(await refusal(() => controller.focus('junk', {}))).match(/expected a card id/u);
    should(await refusal(() => controller.move('junk', 'todo', {}))).match(/expected a card id/u);
    should(await refusal(() => controller.refile('junk', { project: 'Other' }))).match(/expected a card id/u);
    should(gateway.actCalls).eql([]);
  });

  it('should explain a refusal from the daemon with who may do it instead', async () => {
    // Arrange
    const { controller, gateway } = harness();
    gateway.actError = new DaemonRefusal('only the owner may drop this', 403, 'forbidden', {
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

describe('fy card new — related work', () => {
  const base = { kind: 'feature', title: 'Search the board', ask: 'make search easy', askSource: 'chat://1' };

  const related = (matches: RelatedResponse['matches'] | undefined) => {
    const searchGateway = new FakeRelatedGateway();
    searchGateway.answer = matches === undefined ? undefined : { matches };
    const searchOutput = new CapturingOutput();
    const log: string[] = [];
    const gateway = new FakeGateway();
    const controller = new BoardController({
      gateway,
      output: {
        success: message => log.push(`ok: ${message}`),
        diagnostic: message => log.push(`diag: ${message}`),
      },
      files: new FakeFiles(),
      binary: 'fy',
      ownFerret: DENISHA,
      related: new RelatedCheck(searchGateway, searchOutput, 'fy'),
    });
    return { controller, gateway, log, searchGateway, searchOutput };
  };

  const strong = [{ strength: 'strong' as const, hit: cardHit() }];

  it('should refuse a strong duplicate, create nothing, and list the matches and the ways out', async () => {
    // Arrange
    const { controller, gateway, searchGateway } = related(strong);

    // Act
    const message = await refusal(() => controller.create([], base));

    // Assert
    should(gateway.createCalls).eql([]);
    should(searchGateway.relatedCalls[0]).eql({
      request: { kind: 'card', title: 'Search the board', ask: 'make search easy' },
    });
    should(message).containEql('&F303');
    should(message).containEql('fy card new … --related F12');
    should(message).containEql('fy card new … --new');
  });

  it('should create anyway with --new, and not even ask', async () => {
    // Arrange
    const { controller, gateway, searchGateway } = related(strong);

    // Act
    await controller.create([], { ...base, new: true });

    // Assert
    should(gateway.createCalls).have.length(1);
    should(searchGateway.relatedCalls).eql([]);
  });

  it('should note an existing card instead of creating with --related', async () => {
    // Arrange
    const { controller, gateway, log, searchGateway } = related(strong);

    // Act
    await controller.create([], { ...base, related: 'F12' });

    // Assert
    should(gateway.createCalls).eql([]);
    should(searchGateway.relatedCalls).eql([]);
    should(gateway.actCalls).have.length(1);
    should(gateway.actCalls[0]?.id).equal('F12');
    should(gateway.actCalls[0]?.request).containEql({ action: 'note' });
    should(JSON.stringify(gateway.actCalls[0]?.request)).containEql('Search the board — make search easy');
    should(log).containEql('ok: Added to &F12 instead of a new card');
  });

  it('should refuse --new together with --related, and a related id that is no card', async () => {
    // Arrange
    const { controller, gateway } = related(strong);

    // Act + Assert
    should(await refusal(() => controller.create([], { ...base, new: true, related: 'F12' }))).match(/not both/u);
    should(await refusal(() => controller.create([], { ...base, related: 'junk' }))).match(/--related id/u);
    should(gateway.createCalls).eql([]);
  });

  it('should print the matches as JSON, and still create nothing, on a strong match with --json', async () => {
    // Arrange
    const { controller, gateway, searchOutput } = related(strong);

    // Act
    await refusal(() => controller.create([], { ...base, json: true }));

    // Assert
    should(gateway.createCalls).eql([]);
    should(JSON.parse(searchOutput.lines[0] ?? '').related[0].hit.id).equal('F303');
  });

  it('should list the weak related cards and offer --related, then create', async () => {
    // Arrange
    const { controller, gateway, log } = related([
      { strength: 'weak', hit: cardHit() },
      { strength: 'weak', hit: askHit() },
    ]);

    // Act
    await controller.create([], base);

    // Assert — only cards are offered; the agenda match is not a card to note.
    should(gateway.createCalls).have.length(1);
    const listed = log.find(line => line.startsWith('diag: Related cards')) ?? '';
    should(listed).containEql('prefer adding to one (a note, nothing created)');
    should(listed).containEql('&F303');
    should(listed).not.containEql('!A3');
    should(listed).containEql('fy card new … --related F12');
  });

  it('should refuse an umbrella card, creating nothing and asking nothing of the daemon', async () => {
    // Arrange
    const { controller, gateway, searchGateway } = related([]);

    // Act
    const message = await refusal(() => controller.create([], { ...base, title: 'Agenda overhaul' }));

    // Assert
    should(gateway.createCalls).eql([]);
    should(searchGateway.relatedCalls).eql([]);
    should(message).containEql('This looks like an umbrella card (the title says "overhaul")');
    should(message).containEql('fy card new … --parent F12');
    should(message).containEql('fy card new … --related F12');
    should(message).containEql('fy card new … --broad "<why this must be one card>"');
  });

  it('should create an umbrella card with --broad "<why>", or one under a parent', async () => {
    // Arrange
    const { controller, gateway } = related([]);

    // Act
    await controller.create([], { ...base, title: 'Agenda overhaul', broad: 'the owner asked for one tracker' });
    await controller.create([], { ...base, title: 'Agenda overhaul', parent: 'F12' });

    // Assert
    should(gateway.createCalls).have.length(2);
  });

  it('should still refuse an umbrella card with a blank --broad', async () => {
    // Arrange
    const { controller, gateway } = related([]);

    // Act + Assert
    should(await refusal(() => controller.create([], { ...base, title: 'Misc fixes', broad: '  ' }))).containEql(
      'umbrella card',
    );
    should(gateway.createCalls).eql([]);
  });

  it('should create on weak matches alone', async () => {
    // Arrange
    const { controller, gateway } = related([{ strength: 'weak', hit: cardHit() }]);

    // Act
    await controller.create([], base);

    // Assert
    should(gateway.createCalls).have.length(1);
  });

  it('should create with one dim line when the daemon has no search yet', async () => {
    // Arrange
    const { controller, gateway, searchOutput } = related(undefined);

    // Act
    await controller.create([], base);

    // Assert
    should(gateway.createCalls).have.length(1);
    should(searchOutput.notices).eql(['related check skipped: this daemon has no search yet']);
  });
});

describe('fy card patch', () => {
  it('should read the card, then send ONE edit carrying its revision', async () => {
    // Arrange
    const { gateway, controller } = harness(
      undefined,
      undefined,
      new FakeFiles({ '-': 'revision: 1\nsummary: One patch, one edit' }),
    );

    // Act
    await controller.patch('&F1', {});

    // Assert
    should(gateway.cardCalls).deepEqual(['F1']);
    should(sent(gateway)).deepEqual([{ action: 'edit', revision: 1, summary: 'One patch, one edit' }]);
  });

  it('should refuse a stale revision with the way to read it again, and send nothing', async () => {
    // Arrange
    const { gateway, controller } = harness(
      undefined,
      undefined,
      new FakeFiles({ 'f1.yaml': 'revision: 9\nbrief: x' }),
    );

    // Act
    const message = await refusal(() => controller.patch('F1', { file: 'f1.yaml' }));

    // Assert
    should(message).match(
      /changed since you read it, so nothing was written: read it again \(fy card show F1 --yaml\)/u,
    );
    should(sent(gateway)).be.empty();
  });

  it('should say nothing changed and send nothing when every value matches the card', async () => {
    // Arrange
    const { gateway, log, controller } = harness(
      undefined,
      undefined,
      new FakeFiles({ '-': 'revision: 1\ntitle: Rename the widget' }),
    );

    // Act
    await controller.patch('F1', {});

    // Assert
    should(log).deepEqual(['ok: &F1: nothing changed, so nothing was sent (every value matches the card)']);
    should(sent(gateway)).be.empty();
  });

  it('should say every problem at once and send nothing', async () => {
    // Arrange
    const { gateway, controller } = harness(
      undefined,
      undefined,
      new FakeFiles({ '-': 'revision: 1\nbogus: 1\nlane: x' }),
    );

    // Act
    const message = await refusal(() => controller.patch('F1', {}));

    // Assert
    should(message).match(/card patch &F1 changed nothing:\n {2}bogus: not a field.*\n {2}lane: not a field/u);
    should(sent(gateway)).be.empty();
  });

  it('should print the editable document with show --yaml', async () => {
    // Arrange
    const { log, controller } = harness();

    // Act
    await controller.show('F1', { yaml: true });

    // Assert
    should(log[0]).match(
      /^ok: # &F1 — read every part, update what is out of date, then: fy card patch F1 --file <this file>\n/u,
    );
    should(log[0]).match(/\nrevision: 1\ntitle: Rename the widget\n/u);
  });
});
