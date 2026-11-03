import { describe, it } from 'bun:test';
import {
  type BoardActor,
  type BoardTask,
  type BoardTaskCreateRequestInput,
  BoardTaskCreateRequestSchema,
  BoardQuerySchema,
  type BoardTaskVisibility,
  type PrLink,
} from '@ferretry/protocol';
import should from 'should';
import {
  type BoardCaller,
  BoardError,
  BoardService,
  cardVisibility,
  defaultVisibility,
  visibilityVerdict,
} from '../../../src/lib/board/index.ts';
import type { BoardStanding } from '../../../src/lib/board/authority.ts';
import { card, MemoryBoardStore, PROJECT, type ServiceWorld, world } from './support.ts';

const PERSON_ASK = { text: 'build the board', source: 'owner (board)' } as const;
const AGENT_ASK = { text: 'a ferret idea', source: 'session:lead' } as const;

const owner: BoardCaller = { kind: 'owner' };
const lead: BoardCaller = { kind: 'ferret', sessionId: 'lead' };
const stranger: BoardCaller = { kind: 'ferret', sessionId: 'stranger' };

const serviceWith = (cards: readonly BoardTask[], overrides: Partial<ServiceWorld> = {}) => {
  const ports = world({ store: new MemoryBoardStore(cards), ...overrides });
  return { ports, service: new BoardService(ports) };
};
const stored = (ports: ServiceWorld, id: string): BoardTask => ports.store.cards.get(id) as BoardTask;
const create = (input: Partial<BoardTaskCreateRequestInput> = {}) =>
  BoardTaskCreateRequestSchema.parse({ kind: 'feature', title: 'Board store', ask: AGENT_ASK, ...input });

describe('cardVisibility', () => {
  it('should read public for a top-level card a person asked for, and private for everything else', () => {
    should(cardVisibility(card({ ask: PERSON_ASK }))).equal('public');
    should(cardVisibility(card({ ask: AGENT_ASK }))).equal('private');
    should(cardVisibility(card({ ask: PERSON_ASK, parent: { id: 'F9' } }))).equal('private');
    should(cardVisibility(card({ ask: AGENT_ASK, askedBy: 'person' }))).equal('public');
    should(cardVisibility(card({ ask: PERSON_ASK, askedBy: 'agent' }))).equal('private');
  });

  it('should prefer a stored value, and leave defaultVisibility to ignore it', () => {
    const hidden = card({ ask: PERSON_ASK, visibility: 'private' });
    should(cardVisibility(hidden)).equal('private');
    should(defaultVisibility(hidden)).equal('public');
    should(cardVisibility(card({ ask: AGENT_ASK, visibility: 'public' }))).equal('public');
  });
});

describe('visibilityVerdict', () => {
  const person = card({ ask: PERSON_ASK });
  const agent = card({ ask: AGENT_ASK });
  const sub = card({ ask: AGENT_ASK, parent: { id: 'F9' } });
  const allowed = (target: BoardTask, to: BoardTaskVisibility, standing: BoardStanding) =>
    visibilityVerdict(target, to, standing) === null;

  it('should let the owner set any card either way', () => {
    for (const target of [person, agent, sub]) {
      should(allowed(target, 'public', 'owner-human')).be.true();
      should(allowed(target, 'private', 'owner-human')).be.true();
    }
  });

  it('should let a ferret that owns an agent-asked card, or leads it, set it either way', () => {
    for (const standing of ['owner', 'ancestor'] as const) {
      should(allowed(agent, 'public', standing)).be.true();
      should(allowed(agent, 'private', standing)).be.true();
    }
  });

  it('should never let a ferret hide a card a person asked for', () => {
    for (const standing of ['owner', 'ancestor'] as const) {
      should(allowed(person, 'private', standing)).be.false();
      should(allowed(person, 'public', standing)).be.true();
    }
    should(visibilityVerdict(person, 'private', 'owner')?.allowed).eql(['owner-human']);
  });

  it('should keep a sub-card private unless the owner makes it public', () => {
    for (const standing of ['owner', 'ancestor'] as const) {
      should(allowed(sub, 'public', standing)).be.false();
      should(allowed(sub, 'private', standing)).be.true();
    }
    should(allowed(sub, 'public', 'owner-human')).be.true();
  });

  it('should refuse an assignee, a reader and the daemon', () => {
    for (const standing of ['assignee', 'reader', 'daemon'] as const) {
      should(allowed(agent, 'public', standing)).be.false();
      should(allowed(agent, 'private', standing)).be.false();
    }
  });
});

describe('creating a card stores its visibility', () => {
  it("should store public for the owner's own card and private for a ferret's", async () => {
    const { ports, service } = serviceWith([]);
    const mine = await service.create(
      create({ ask: { text: 'a card from the app', source: 'board' }, assignee: 'lead', projectId: PROJECT }),
      owner,
    );
    const theirs = await service.create(create(), lead);
    should(stored(ports, mine.task.id).visibility).equal('public');
    should(stored(ports, theirs.task.id).visibility).equal('private');
    should(mine.task.visibility).equal('public');
  });

  it('should store a sub-card as private even when the owner asked for the work', async () => {
    const { ports, service } = serviceWith([card({ id: 'F1', ask: PERSON_ASK })]);
    const { task } = await service.create(create({ ask: PERSON_ASK, parent: { id: 'F1' } }), lead);
    should(stored(ports, task.id).visibility).equal('private');
  });

  it('should let a ferret choose either way for its own agent-asked card', async () => {
    const { ports, service } = serviceWith([]);
    const open = await service.create(create({ visibility: 'public' }), lead);
    const hidden = await service.create(create({ visibility: 'private' }), lead);
    should(stored(ports, open.task.id).visibility).equal('public');
    should(stored(ports, hidden.task.id).visibility).equal('private');
  });

  it('should refuse a ferret that hides the owner’s ask, or publishes a sub-card', async () => {
    const { service } = serviceWith([card({ id: 'F1', ask: PERSON_ASK })]);
    await service
      .create(create({ ask: { text: 'x', source: 'owner via lead jaeda' }, visibility: 'private' }), lead)
      .then(
        () => should.fail(undefined, undefined, 'a ferret hid the owner’s ask'),
        (error: unknown) => should(error).be.instanceOf(BoardError).and.match({ code: 'forbidden' }),
      );
    await service.create(create({ parent: { id: 'F1' }, visibility: 'public' }), lead).then(
      () => should.fail(undefined, undefined, 'a ferret published a sub-card'),
      (error: unknown) => should(error).be.instanceOf(BoardError).and.match({ code: 'forbidden' }),
    );
  });

  it('should let the owner publish a sub-card and hide their own ask', async () => {
    const { ports, service } = serviceWith([card({ id: 'F1', ask: PERSON_ASK })]);
    const sub = await service.create(
      create({ ask: PERSON_ASK, parent: { id: 'F1' }, visibility: 'public', assignee: 'lead', projectId: PROJECT }),
      owner,
    );
    const hidden = await service.create(
      create({ ask: PERSON_ASK, visibility: 'private', assignee: 'lead', projectId: PROJECT }),
      owner,
    );
    should(stored(ports, sub.task.id).visibility).equal('public');
    should(stored(ports, hidden.task.id).visibility).equal('private');
  });
});

describe('the visibility action', () => {
  const act = (service: BoardService, id: string, visibility: BoardTaskVisibility, caller: BoardCaller) =>
    service.act(id, { action: 'visibility', visibility }, caller);

  it('should let the card’s ferret flip an agent-asked card and record it as a note', async () => {
    const { ports, service } = serviceWith([card({ id: 'F1', ask: AGENT_ASK, visibility: 'private' })]);
    const { task } = await act(service, 'F1', 'public', lead);
    should(task.visibility).equal('public');
    should(stored(ports, 'F1').visibility).equal('public');
    const last = stored(ports, 'F1').history.at(-1);
    should(last).match({ type: 'note', text: 'visibility: private → public' });
  });

  it('should refuse a ferret that hides the owner’s ask, and let the owner do it', async () => {
    const { ports, service } = serviceWith([card({ id: 'F1', ask: PERSON_ASK, askedBy: 'person' })]);
    await act(service, 'F1', 'private', lead).then(
      () => should.fail(undefined, undefined, 'a ferret hid the owner’s ask'),
      (error: unknown) => should(error).be.instanceOf(BoardError).and.match({ code: 'forbidden' }),
    );
    should(stored(ports, 'F1').visibility).be.undefined();
    await act(service, 'F1', 'private', owner);
    should(stored(ports, 'F1').visibility).equal('private');
  });

  it('should refuse a ferret that does not own the card', async () => {
    const { ports, service } = serviceWith([card({ id: 'F1', ask: AGENT_ASK })]);
    await act(service, 'F1', 'public', stranger).then(
      () => should.fail(undefined, undefined, 'a stranger published a card'),
      (error: unknown) => should(error).be.instanceOf(BoardError).and.match({ code: 'forbidden' }),
    );
    should(stored(ports, 'F1').visibility).be.undefined();
  });

  it('should refuse a change to what the card already is, naming it', async () => {
    const { service } = serviceWith([card({ id: 'F1', ask: AGENT_ASK })]);
    await act(service, 'F1', 'private', lead).then(
      () => should.fail(undefined, undefined, 'a no-op was accepted'),
      (error: unknown) => should(error).be.instanceOf(BoardError).and.match({ code: 'invalid' }),
    );
  });

  it('should refuse a sub-ferret, which may only note and link', async () => {
    const sub: BoardActor = { kind: 'ferret', sessionId: 'child' };
    const { service } = serviceWith([card({ id: 'F1', ask: AGENT_ASK, owner: 'child', createdBy: sub })], {
      subFerrets: { leadOf: async id => (id === 'child' ? 'lead' : undefined), addressOf: async id => id },
    });
    await act(service, 'F1', 'public', { kind: 'ferret', sessionId: 'child' }).then(
      () => should.fail(undefined, undefined, 'a sub-ferret published a card'),
      (error: unknown) => should(error).be.instanceOf(BoardError),
    );
  });
});

describe('backfilling visibility', () => {
  it('should store what each card reads as, once, and never change a stored value', async () => {
    const { ports, service } = serviceWith([
      card({ id: 'F1', ask: PERSON_ASK }),
      card({ id: 'F2', ask: AGENT_ASK }),
      card({ id: 'F3', ask: PERSON_ASK, parent: { id: 'F1' } }),
      card({ id: 'F4', ask: AGENT_ASK, visibility: 'public' }),
      card({ id: 'F5', ask: PERSON_ASK, visibility: 'private' }),
    ]);
    const store = ports.store as MemoryBoardStore;

    should(await service.backfillVisibility()).equal(3);

    should(['F1', 'F2', 'F3', 'F4', 'F5'].map(id => stored(ports, id).visibility)).eql([
      'public',
      'private',
      'private',
      'public',
      'private',
    ]);
    should(store.writes.map(write => write.id).sort()).eql(['F1', 'F2', 'F3']);
    should(await service.backfillVisibility()).equal(0);
  });

  it('should write no history and change nothing else about the card', async () => {
    const before = card({ id: 'F1', ask: PERSON_ASK });
    const { ports, service } = serviceWith([before]);
    await service.backfillVisibility();
    should(stored(ports, 'F1')).eql({ ...before, visibility: 'public' });
  });
});

describe('the board query filters by visibility', () => {
  const pr: PrLink = {
    url: 'https://github.com/kirinnee/ferretry/pull/1',
    number: 1,
    repo: 'kirinnee/ferretry',
    state: 'open',
    draft: false,
    checks: 'none',
    mergedAt: null,
    mergeSha: null,
    releasedIn: null,
    polledAt: null,
  };
  const approval = { sessionId: 'mvzypoiz-0ef5e827', id: 'A7' };
  const board = () => [
    card({
      id: 'F1',
      ask: PERSON_ASK,
      visibility: 'public',
      approval,
      links: { prs: [pr], branch: 'feat/x', commits: [], docs: [] },
    }),
    card({ id: 'F2', ask: AGENT_ASK, visibility: 'private' }),
    card({ id: 'F3', ask: PERSON_ASK }),
    card({ id: 'F4', ask: AGENT_ASK, parent: { id: 'F1' } }),
  ];
  const ids = async (query: Parameters<typeof BoardQuerySchema.parse>[0]) =>
    (await serviceWith(board()).service.board(BoardQuerySchema.parse(query))).cards.map(entry => entry.id).sort();

  it('should serve every card when no filter is sent (an older app loses nothing)', async () => {
    should(await ids({})).eql(['F1', 'F2', 'F3', 'F4']);
    should(await ids({ visibility: 'all' })).eql(['F1', 'F2', 'F3', 'F4']);
  });

  it('should serve public cards, reading a card without a stored value by its default', async () => {
    should(await ids({ visibility: 'public' })).eql(['F1', 'F3']);
  });

  it('should serve private cards alone', async () => {
    should(await ids({ visibility: 'private' })).eql(['F2', 'F4']);
  });

  it('should keep a public card linked to its PRs and its approval', async () => {
    const { service } = serviceWith(board());
    const response = await service.board(BoardQuerySchema.parse({ visibility: 'public' }));
    const shown = response.cards.find(entry => entry.id === 'F1');
    should(shown?.links.prs).eql([pr]);
    should(shown?.links.branch).equal('feat/x');
    should(shown?.approval).eql(approval);
    should(shown?.visibility).equal('public');
  });

  it('should count the header over the cards shown', async () => {
    const { service } = serviceWith(board());
    const everything = await service.board(BoardQuerySchema.parse({ visibility: 'all' }));
    const publicOnly = await service.board(BoardQuerySchema.parse({ visibility: 'public' }));
    should(everything.cards.length).equal(4);
    should(publicOnly.cards.length).equal(2);
  });
});
