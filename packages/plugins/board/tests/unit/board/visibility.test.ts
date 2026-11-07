import { describe, it } from 'bun:test';
import { type CardActor, BoardQuerySchema, type Card, type CardCreateRequestInput, CardCreateRequestSchema, type CardVisibility, type PrLink } from '../../../contract/index.ts';
import should from 'should';
import type { BoardStanding } from '../../../daemon/lib/board/authority.ts';
import type { OwnerWords } from '../../../daemon/lib/board/index.ts';
import {
  type BoardCaller,
  BoardError,
  BoardService,
  BoardUnavailableError,
  cardVisibility,
  defaultVisibility,
  visibilityVerdict,
  withDefaultVisibility,
} from '../../../daemon/lib/board/index.ts';
import { card, MemoryBoardStore, PROJECT, type ServiceWorld, world } from './support.ts';

const PERSON_ASK = { text: 'build the board', source: 'owner (board)' } as const;
const AGENT_ASK = { text: 'a ferret idea', source: 'session:lead' } as const;

const owner: BoardCaller = { kind: 'owner' };
const lead: BoardCaller = { kind: 'ferret', ferret: 'lead' };
const stranger: BoardCaller = { kind: 'ferret', ferret: 'stranger' };

const serviceWith = (cards: readonly Card[], overrides: Partial<ServiceWorld> = {}) => {
  const ports = world({ store: new MemoryBoardStore(cards), ownerWords: { said: async () => [] }, ...overrides });
  return { ports, service: new BoardService(ports) };
};
const stored = (ports: ServiceWorld, id: string): Card => ports.store.cards.get(id) as Card;
const create = (input: Partial<CardCreateRequestInput> = {}) =>
  CardCreateRequestSchema.parse({ kind: 'feature', title: 'Board store', ask: AGENT_ASK, ...input });

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
  const allowed = (target: Card, to: CardVisibility, standing: BoardStanding) =>
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
    should(stored(ports, mine.card.id).visibility).equal('public');
    should(stored(ports, theirs.card.id).visibility).equal('private');
    should(mine.card.visibility).equal('public');
  });

  it('should store a sub-card as private even when the owner asked for the work', async () => {
    const { ports, service } = serviceWith([card({ id: 'F1', ask: PERSON_ASK })]);
    const { card: task } = await service.create(create({ ask: PERSON_ASK, parent: { id: 'F1' } }), lead);
    should(stored(ports, task.id).visibility).equal('private');
  });

  it('should let a ferret choose either way for its own agent-asked card', async () => {
    const { ports, service } = serviceWith([]);
    const open = await service.create(create({ visibility: 'public' }), lead);
    const hidden = await service.create(create({ visibility: 'private' }), lead);
    should(stored(ports, open.card.id).visibility).equal('public');
    should(stored(ports, hidden.card.id).visibility).equal('private');
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
    should(stored(ports, sub.card.id).visibility).equal('public');
    should(stored(ports, hidden.card.id).visibility).equal('private');
  });
});

describe('the visibility action', () => {
  const act = (service: BoardService, id: string, visibility: CardVisibility, caller: BoardCaller) =>
    service.act(id, { action: 'visibility', visibility }, caller);

  it('should let the card’s ferret flip an agent-asked card and record it as a note', async () => {
    const { ports, service } = serviceWith([card({ id: 'F1', ask: AGENT_ASK, visibility: 'private' })]);
    const { card: task } = await act(service, 'F1', 'public', lead);
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

  it('should record a choice equal to the default, and refuse it only once it is recorded', async () => {
    const { ports, service } = serviceWith([card({ id: 'F1', ask: AGENT_ASK })]);
    await act(service, 'F1', 'private', lead);
    should(stored(ports, 'F1')).match({ visibility: 'private', visibilitySource: 'chosen' });
    should(stored(ports, 'F1').history.at(-1)).match({ type: 'note', text: 'visibility: private (chosen)' });
    await act(service, 'F1', 'private', lead).then(
      () => should.fail(undefined, undefined, 'a no-op was accepted'),
      (error: unknown) => should(error).be.instanceOf(BoardError).and.match({ code: 'invalid' }),
    );
  });

  it('should refuse a ferret that records private on a card whose asker is only a guess', async () => {
    const words = new FakeOwnerWords({ lead: [OWNER_SAID] });
    const { ports, service } = serviceWith([lead_made('F1', { askedBy: 'agent' })], { ownerWords: words });
    await act(service, 'F1', 'private', lead).then(
      () => should.fail(undefined, undefined, 'a ferret hid the owner’s ask'),
      (error: unknown) => should(error).be.instanceOf(BoardError).and.match({ code: 'forbidden' }),
    );
    should(stored(ports, 'F1').visibilitySource).be.undefined();
  });

  it('should not let a ferret record private while the asker cannot be read', async () => {
    const words = new FakeOwnerWords({ lead: new Error('queue torn') });
    const { ports, service } = serviceWith([lead_made('F1', { askedBy: 'agent' })], { ownerWords: words });
    await act(service, 'F1', 'private', lead).then(
      () => should.fail(undefined, undefined, 'a ferret hid a card on a guess'),
      (error: unknown) => should(error).be.instanceOf(BoardUnavailableError),
    );
    should(stored(ports, 'F1').visibilitySource).be.undefined();
    await act(service, 'F1', 'private', owner);
    should(stored(ports, 'F1')).match({ visibility: 'private', visibilitySource: 'chosen' });
  });

  it('should refuse a helper, which may only note and link', async () => {
    const sub: CardActor = { kind: 'ferret', ferret: 'child' };
    const { service } = serviceWith([card({ id: 'F1', ask: AGENT_ASK, owner: 'child', createdBy: sub })], {
      helpers: { leadOf: async id => (id === 'child' ? 'lead' : undefined), addressOf: async id => id },
    });
    await act(service, 'F1', 'public', { kind: 'ferret', ferret: 'child' }).then(
      () => should.fail(undefined, undefined, 'a helper published a card'),
      (error: unknown) => should(error).be.instanceOf(BoardError),
    );
  });
});

class FakeOwnerWords implements OwnerWords {
  constructor(readonly bySession: Record<string, readonly string[] | Error>) {}
  async said(ferret: string): Promise<readonly string[]> {
    const words = this.bySession[ferret] ?? [];
    if (words instanceof Error) throw words;
    return words;
  }
}

const OWNER_SAID = 'Make the inbox show only cards a person asked for, with the project name next to the machine';
const lead_made = (id: string, overrides: Partial<Card> = {}) =>
  card({
    id,
    ask: { text: OWNER_SAID, source: 'session:lead' },
    createdBy: { kind: 'ferret', ferret: 'lead' },
    ...overrides,
  });

describe('withDefaultVisibility', () => {
  it('should never touch a chosen visibility, with or without a source', () => {
    const chosen = card({ ask: PERSON_ASK, askedBy: 'person', visibility: 'private', visibilitySource: 'chosen' });
    const legacy = card({ ask: PERSON_ASK, askedBy: 'person', visibility: 'private' });
    should(withDefaultVisibility(chosen)).equal(chosen);
    should(withDefaultVisibility(legacy)).equal(legacy);
  });

  it('should answer the same card when its default already holds, and re-derive one that does not', () => {
    const holds = card({ ask: PERSON_ASK, askedBy: 'person', visibility: 'public', visibilitySource: 'default' });
    should(withDefaultVisibility(holds)).equal(holds);
    const stale = card({ ask: PERSON_ASK, askedBy: 'person', visibility: 'private', visibilitySource: 'default' });
    should(withDefaultVisibility(stale)).match({ visibility: 'public', visibilitySource: 'default' });
    should(withDefaultVisibility(card({ ask: PERSON_ASK, askedBy: 'person' }))).match({
      visibility: 'public',
      visibilitySource: 'default',
    });
  });
});

describe('visibility follows who asked once that is settled', () => {
  it('should not hide a card on an explicit private while who asked for it cannot be read', async () => {
    const words = new FakeOwnerWords({ lead: new Error('queue torn') });
    const { ports, service } = serviceWith([], { ownerWords: words });
    const request = create({
      ask: { text: OWNER_SAID, source: 'session:lead' },
      projectId: PROJECT,
      visibility: 'private',
    });
    await service.create(request, lead).then(
      () => should.fail(undefined, undefined, 'a ferret hid a card on a guess'),
      (error: unknown) => should(error).be.instanceOf(BoardUnavailableError),
    );
    should(ports.store.cards.size).equal(0);

    words.bySession.lead = [OWNER_SAID];
    await service.create(request, lead).then(
      () => should.fail(undefined, undefined, 'a ferret hid the owner’s ask'),
      (error: unknown) => should(error).be.instanceOf(BoardError).and.match({ code: 'forbidden' }),
    );
    should(ports.store.cards.size).equal(0);
  });

  it('should store a chosen visibility for a new card that asked for one', async () => {
    const { ports, service } = serviceWith([]);
    const { card: task } = await service.create(create({ visibility: 'public' }), lead);
    should(stored(ports, task.id)).match({ visibility: 'public', visibilitySource: 'chosen' });
  });
});

describe('moving a card under another keeps the visibility rules', () => {
  const reparent = (service: BoardService, id: string, parent: string | null, caller: BoardCaller) =>
    service.act(id, { action: 'reparent', parent: parent === null ? null : { id: parent } }, caller);
  const forbidden = async (work: Promise<unknown>) =>
    await work.then(
      () => should.fail(undefined, undefined, 'the move was accepted'),
      (error: unknown) => should(error).be.instanceOf(BoardError).and.match({ code: 'forbidden' }),
    );
  const base = () => [card({ id: 'F2', ask: AGENT_ASK }), card({ id: 'F3', ask: AGENT_ASK })];

  it('should refuse a ferret that would make its published card a public sub-card, and let the owner', async () => {
    const { ports, service } = serviceWith([
      ...base(),
      card({ id: 'F1', ask: AGENT_ASK, askedBy: 'agent', visibility: 'public', visibilitySource: 'chosen' }),
    ]);
    await forbidden(reparent(service, 'F1', 'F2', lead));
    should(stored(ports, 'F1').parent).be.null();

    await reparent(service, 'F1', 'F2', owner);
    should(stored(ports, 'F1')).match({ parent: { id: 'F2' }, visibility: 'public', visibilitySource: 'chosen' });
  });

  it('should let a ferret make its card private first and then move it', async () => {
    const { ports, service } = serviceWith([
      ...base(),
      card({ id: 'F1', ask: AGENT_ASK, askedBy: 'agent', visibility: 'public', visibilitySource: 'chosen' }),
    ]);
    await service.act('F1', { action: 'visibility', visibility: 'private' }, lead);
    await reparent(service, 'F1', 'F2', lead);
    should(stored(ports, 'F1')).match({ parent: { id: 'F2' }, visibility: 'private' });
  });

  it('should refuse a ferret that would hide the owner’s card by moving it, and let the owner', async () => {
    const { ports, service } = serviceWith([
      ...base(),
      card({ id: 'F1', ask: PERSON_ASK, askedBy: 'person', visibility: 'public', visibilitySource: 'default' }),
    ]);
    await forbidden(reparent(service, 'F1', 'F2', lead));
    should(stored(ports, 'F1')).match({ parent: null, visibility: 'public' });

    await reparent(service, 'F1', 'F2', owner);
    should(stored(ports, 'F1')).match({ parent: { id: 'F2' }, visibility: 'private', visibilitySource: 'default' });
  });

  it('should publish a person’s sub-card again when it is lifted to the top level, and keep a chosen one', async () => {
    const { ports, service } = serviceWith([
      ...base(),
      card({
        id: 'F1',
        ask: PERSON_ASK,
        askedBy: 'person',
        parent: { id: 'F2' },
        visibility: 'private',
        visibilitySource: 'default',
      }),
      card({
        id: 'F4',
        ask: PERSON_ASK,
        askedBy: 'person',
        parent: { id: 'F2' },
        visibility: 'private',
        visibilitySource: 'chosen',
      }),
    ]);
    await reparent(service, 'F1', null, lead);
    await reparent(service, 'F4', null, lead);
    should(stored(ports, 'F1')).match({ parent: null, visibility: 'public', visibilitySource: 'default' });
    should(stored(ports, 'F4')).match({ parent: null, visibility: 'private', visibilitySource: 'chosen' });
  });

  it('should let a ferret move the owner’s public sub-card between parents, which publishes nothing new', async () => {
    const { ports, service } = serviceWith([
      ...base(),
      card({
        id: 'F1',
        ask: AGENT_ASK,
        parent: { id: 'F2' },
        visibility: 'public',
        visibilitySource: 'chosen',
      }),
    ]);
    await reparent(service, 'F1', 'F3', lead);
    should(stored(ports, 'F1')).match({ parent: { id: 'F3' }, visibility: 'public' });
  });

  it('should leave a card with no stored visibility without one, reading it by where it sits', async () => {
    const { ports, service } = serviceWith([...base(), card({ id: 'F1', ask: AGENT_ASK })]);
    await reparent(service, 'F1', 'F2', lead);
    should(stored(ports, 'F1').visibility).be.undefined();
    should(cardVisibility(stored(ports, 'F1'))).equal('private');
  });
});

describe('editing a card with its visibility is one mutation', () => {
  const edit = (service: BoardService, id: string, fields: Record<string, unknown>, caller: BoardCaller) =>
    service.act(id, { action: 'edit', ...fields } as never, caller);

  it('should apply text and visibility together, with one stored result', async () => {
    const { ports, service } = serviceWith([card({ id: 'F1', ask: AGENT_ASK })]);
    const store = ports.store as MemoryBoardStore;
    await edit(service, 'F1', { title: 'Changed', visibility: 'public' }, lead);
    should(store.writes).have.length(1);
    should(stored(ports, 'F1')).match({ title: 'Changed', visibility: 'public', visibilitySource: 'chosen' });
    should(stored(ports, 'F1').history.map(event => event.type)).eql(['created', 'field-edited', 'note']);
  });

  it('should change visibility alone through an edit', async () => {
    const { ports, service } = serviceWith([card({ id: 'F1', ask: AGENT_ASK })]);
    await edit(service, 'F1', { visibility: 'public' }, lead);
    should(stored(ports, 'F1')).match({ visibility: 'public' });
  });

  it('should refuse a forbidden visibility without applying the text', async () => {
    const { ports, service } = serviceWith([card({ id: 'F1', ask: PERSON_ASK, askedBy: 'person' })]);
    await edit(service, 'F1', { title: 'Changed', visibility: 'private' }, lead).then(
      () => should.fail(undefined, undefined, 'a ferret hid the owner’s ask'),
      (error: unknown) => should(error).be.instanceOf(BoardError).and.match({ code: 'forbidden' }),
    );
    should(stored(ports, 'F1').title).equal('Board store');
    should((ports.store as MemoryBoardStore).writes).have.length(0);
    await edit(service, 'F1', { title: 'Changed', visibility: 'private' }, owner);
    should(stored(ports, 'F1')).match({ title: 'Changed', visibility: 'private' });
  });

  it('should record a visibility equal to the default beside a text change, and refuse it once recorded', async () => {
    const { ports, service } = serviceWith([card({ id: 'F1', ask: AGENT_ASK })]);
    await edit(service, 'F1', { title: 'Changed', visibility: 'private' }, lead);
    should(stored(ports, 'F1')).match({ title: 'Changed', visibility: 'private', visibilitySource: 'chosen' });
    await edit(service, 'F1', { title: 'Changed again', visibility: 'private' }, lead);
    should(stored(ports, 'F1').history.filter(event => event.type === 'note')).have.length(1);
    await edit(service, 'F1', { visibility: 'private' }, lead).then(
      () => should.fail(undefined, undefined, 'a no-op was accepted'),
      (error: unknown) => should(error).be.instanceOf(BoardError).and.match({ code: 'invalid' }),
    );
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
  const approval = { ferret: 'mvzypoiz-0ef5e827', id: 'A7' };
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
