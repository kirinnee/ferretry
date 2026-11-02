import { describe, it } from 'bun:test';
import {
  type AgendaId,
  type BoardProjectId,
  type BoardTask,
  type BoardTaskCreateRequestInput,
  BoardTaskCreateRequestSchema,
  type ResolvedAgendaItem,
  ResolvedAgendaItemSchema,
} from '@ferretry/protocol';
import should from 'should';
import {
  type BoardCaller,
  BoardError,
  type BoardOptIn,
  BoardService,
  type OwnerWords,
} from '../../../src/lib/board/index.ts';
import { card, MemoryBoardStore, NOW, OTHER_PROJECT, PROJECT, type ServiceWorld, world } from './support.ts';

const lead: BoardCaller = { kind: 'ferret', sessionId: 'lead' };
const OWNER_WANTS_A_CARD = 'put the login redesign on the board as a card so I can follow it';

/** Each board's switch and the ferrets' answered items, as the opt-in rule reads them; counts what it read. */
class FakeOptIn implements BoardOptIn {
  readonly switchReads: BoardProjectId[] = [];

  constructor(
    private readonly on: ReadonlySet<BoardProjectId> = new Set(),
    private readonly answers: Readonly<Record<string, readonly ResolvedAgendaItem[]>> = {},
    private readonly failing: { readonly switch?: boolean; readonly agenda?: boolean } = {},
  ) {}

  async isOn(projectId: BoardProjectId): Promise<boolean> {
    this.switchReads.push(projectId);
    if (this.failing.switch === true) throw new Error('switch.json is damaged');
    return this.on.has(projectId);
  }

  async nameOf(projectId: BoardProjectId): Promise<string> {
    return projectId === PROJECT ? 'ferretry' : projectId;
  }

  async answered(sessionId: string, id: AgendaId): Promise<ResolvedAgendaItem | undefined> {
    if (this.failing.agenda === true) throw new Error('agenda.json is damaged');
    return this.answers[sessionId]?.find(item => item.id === id);
  }
}

class FakeOwnerWords implements OwnerWords {
  readonly reads: string[] = [];

  constructor(private readonly words: Readonly<Record<string, readonly string[]>> = {}) {}

  async said(sessionId: string): Promise<readonly string[]> {
    this.reads.push(sessionId);
    return this.words[sessionId] ?? [];
  }
}

/** The owner's Yes to "Track this on the board?" on `session`'s agenda. */
const yes = (id: AgendaId = 'A12', session = 'lead', choice = 'Yes'): ResolvedAgendaItem =>
  ResolvedAgendaItemSchema.parse({
    id,
    raisedBy: 'agent',
    raisedBySession: session,
    raisedByName: null,
    source: 'agent-raised',
    sourceRef: null,
    subject: 'Track this on the board?',
    why: 'the login fix spans three PRs',
    context: null,
    howToResolve: 'Yes puts it on the board',
    waitingSince: NOW,
    kind: 'yesno',
    ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
    resolvedAt: NOW,
    resolutionNote: null,
    response: { kind: 'multiple-choice', choice },
    disposition: 'done',
    resolvedBy: 'human',
    resolvedBySession: null,
    resolvedByName: null,
  });

const create = (input: Partial<BoardTaskCreateRequestInput> = {}) =>
  BoardTaskCreateRequestSchema.parse({
    kind: 'feature',
    title: 'Login redesign',
    ask: { text: 'fix the login', source: 'session:lead' },
    ...input,
  });

const serviceWith = (cards: readonly BoardTask[], overrides: Partial<ServiceWorld> = {}) => {
  const ports = world({ store: new MemoryBoardStore(cards), ...overrides });
  return { ports, service: new BoardService(ports) };
};

async function refusal(work: Promise<unknown>): Promise<BoardError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  should(error).be.instanceOf(BoardError);
  return error as BoardError;
}

describe('the board is opt-in', () => {
  it("should refuse a ferret's card where the board is off, saying to use the agenda and how to ask", async () => {
    // Arrange
    const { ports, service } = serviceWith([], { optIn: new FakeOptIn() });

    // Act
    const error = await refusal(service.create(create(), lead));

    // Assert
    should(error.code).equal('forbidden');
    should(error.message).startWith('The ferretry board is off, so this work needs no card');
    should(error.message).containEql('fy agenda add -k yesno "Track this on the board?"');
    should(ports.store.cards.size).equal(0);
  });

  it("should make a ferret's card where the board is on", async () => {
    // Arrange
    const optIn = new FakeOptIn(new Set([PROJECT]));
    const { ports, service } = serviceWith([], { optIn });

    // Act
    const response = await service.create(create(), lead);

    // Assert
    should(response.task.id).equal('F1');
    should(response.task).not.have.property('approval');
    should(optIn.switchReads).eql([PROJECT]);
    should(ports.store.cards.size).equal(1);
  });

  it('should read the switch of the board the card is made on, not the caller’s', async () => {
    // Arrange
    const { service } = serviceWith([], { optIn: new FakeOptIn(new Set([PROJECT])) });

    // Act
    const error = await refusal(service.create(create({ projectId: OTHER_PROJECT }), lead));

    // Assert
    should(error.message).startWith(`The ${OTHER_PROJECT} board is off`);
  });

  it('should read a switch that cannot be read as off', async () => {
    // Arrange
    const { service } = serviceWith([], { optIn: new FakeOptIn(new Set([PROJECT]), {}, { switch: true }) });

    // Act
    const error = await refusal(service.create(create(), lead));

    // Assert
    should(error.code).equal('forbidden');
  });

  it('should never ask the owner or the admin token', async () => {
    // Arrange
    const optIn = new FakeOptIn();
    const { service } = serviceWith([], { optIn });

    // Act
    const owner = await service.create(create({ assignee: 'lead', projectId: PROJECT }), { kind: 'owner' });
    const token = await service.create(create({ assignee: 'lead', projectId: PROJECT }), {
      kind: 'owner',
      via: 'admin-token',
    });

    // Assert
    should([owner.task.id, token.task.id]).eql(['F1', 'F2']);
    should(optIn.switchReads).eql([]);
  });

  it('should make a card under a parent the ferret holds', async () => {
    // Arrange
    const { service } = serviceWith([card({ id: 'F3', owner: 'lead' })], { optIn: new FakeOptIn() });

    // Act
    const response = await service.create(create({ parent: { id: 'F3' } }), lead);

    // Assert
    should(response.task.parent).eql({ id: 'F3' });
  });

  it('should still refuse a parent the ferret does not hold, before the rule is read', async () => {
    // Arrange
    const optIn = new FakeOptIn();
    const { service } = serviceWith([card({ id: 'F3', owner: 'stranger' })], { optIn });

    // Act
    const error = await refusal(service.create(create({ parent: { id: 'F3' } }), lead));

    // Assert
    should(error.code).equal('forbidden');
    should(error.message).not.startWith('The ferretry board is off');
    should(optIn.switchReads).eql([]);
  });

  it("should make a card on the owner's Yes and record the Yes on it", async () => {
    // Arrange
    const { service } = serviceWith([], { optIn: new FakeOptIn(new Set(), { lead: [yes()] }) });

    // Act
    const response = await service.create(create({ approval: 'A12' }), lead);

    // Assert
    should(response.task.approval).eql({ sessionId: 'lead', id: 'A12' });
  });

  it('should make one card on one Yes, also when two creates race', async () => {
    // Arrange: a serial section that holds both creates until they are both waiting, then runs them in turn.
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const queues = new Map<string, Promise<unknown>>();
    const keys: string[] = [];
    const serial = {
      run: async <T>(key: string, work: () => Promise<T>): Promise<T> => {
        keys.push(key);
        const next = (queues.get(key) ?? gate).then(work);
        queues.set(
          key,
          next.catch(() => undefined),
        );
        return await next;
      },
    };
    const { service } = serviceWith([], { optIn: new FakeOptIn(new Set(), { lead: [yes()] }), serial });

    // Act
    const first = service.create(create({ approval: 'A12' }), lead);
    const second = service.create(create({ approval: 'A12' }), lead).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    release();
    const made = await first;
    const error = (await second) as BoardError | undefined;

    // Assert
    should(made.task.id).equal('F1');
    should(error).be.instanceOf(BoardError);
    should(error?.message).containEql('!A12 already made &F1');
    should(keys).eql(['board:approval:lead:A12', 'board:approval:lead:A12']);
  });

  it('should refuse a second card on a Yes that already made one, saying which', async () => {
    // Arrange
    const used = card({ id: 'F4', owner: 'lead', approval: { sessionId: 'lead', id: 'A12' } });
    const { service } = serviceWith([used], { optIn: new FakeOptIn(new Set(), { lead: [yes()] }) });

    // Act
    const error = await refusal(service.create(create({ approval: 'A12' }), lead));

    // Assert
    should(error.message).containEql('The approval does not count: !A12 already made &F4; one Yes makes one card.');
  });

  it("should refuse another ferret's Yes and a No", async () => {
    // Arrange
    const optIn = new FakeOptIn(new Set(), { lead: [yes('A13', 'lead', 'No')], stranger: [yes('A12', 'stranger')] });
    const { service } = serviceWith([], { optIn });

    // Act
    const theirs = await refusal(service.create(create({ approval: 'A12' }), lead));
    const no = await refusal(service.create(create({ approval: 'A13' }), lead));

    // Assert
    should(theirs.message).containEql('!A12 is not an answered item on your agenda');
    should(no.message).containEql('the owner did not answer Yes to !A13');
  });

  it('should read an agenda that cannot be read as no Yes', async () => {
    // Arrange
    const { service } = serviceWith([], { optIn: new FakeOptIn(new Set(), { lead: [yes()] }, { agenda: true }) });

    // Act
    const error = await refusal(service.create(create({ approval: 'A12' }), lead));

    // Assert
    should(error.message).containEql('!A12 is not an answered item on your agenda');
  });

  it('should ignore an approval where the board is on, and record none', async () => {
    // Arrange
    const { service } = serviceWith([], { optIn: new FakeOptIn(new Set([PROJECT])) });

    // Act
    const response = await service.create(create({ approval: 'A99' }), lead);

    // Assert
    should(response.task).not.have.property('approval');
  });

  it("should make a card whose ask is the owner's own words asking for one", async () => {
    // Arrange
    const ownerWords = new FakeOwnerWords({ lead: [OWNER_WANTS_A_CARD] });
    const { service } = serviceWith([], { optIn: new FakeOptIn(), ownerWords });

    // Act
    const response = await service.create(create({ ask: { text: OWNER_WANTS_A_CARD, source: 'owner' } }), lead);

    // Assert
    should(response.task.id).equal('F1');
    should(response.task).not.have.property('approval');
  });

  it("should refuse a card whose ask is the owner's words for the work alone", async () => {
    // Arrange
    const words = 'please fix the login redirect loop on the phone today';
    const ownerWords = new FakeOwnerWords({ lead: [words] });
    const { service } = serviceWith([], { optIn: new FakeOptIn(), ownerWords });

    // Act
    const error = await refusal(service.create(create({ ask: { text: words, source: 'owner' } }), lead));

    // Assert
    should(error.code).equal('forbidden');
  });

  it("should refuse when the owner's words cannot be read", async () => {
    // Arrange
    const ownerWords: OwnerWords = { said: () => Promise.reject(new Error('queue unreadable')) };
    const { service } = serviceWith([], { optIn: new FakeOptIn(), ownerWords });

    // Act
    const error = await refusal(service.create(create({ ask: { text: OWNER_WANTS_A_CARD, source: 'owner' } }), lead));

    // Assert
    should(error.code).equal('forbidden');
  });

  it('should leave every board on when the rule is not wired', async () => {
    // Arrange
    const { service } = serviceWith([]);

    // Act
    const response = await service.create(create(), lead);

    // Assert
    should(response.task.id).equal('F1');
  });
});
