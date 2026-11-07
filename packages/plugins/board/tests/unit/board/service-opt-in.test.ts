import { describe, it } from 'bun:test';
import { type BoardProjectId, type Card, CardActionRequestSchema, type CardCreateRequestInput, CardCreateRequestSchema } from '../../../contract/index.ts';
import should from 'should';
import {
  type BoardCaller,
  BoardError,
  type AnsweredAsk,
  type BoardOptIn,
  BoardService,
  type OwnerWords,
} from '../../../daemon/lib/board/index.ts';
import { card, MemoryBoardStore, NOW, OTHER_PROJECT, PROJECT, type ServiceWorld, world } from './support.ts';

const lead: BoardCaller = { kind: 'ferret', ferret: 'lead' };
const OWNER_WANTS_A_CARD = 'put the login redesign on the board as a card so I can follow it';

/** Each board's switch and the ferrets' answered items, as the opt-in rule reads them; counts what it read. */
class FakeOptIn implements BoardOptIn {
  readonly switchReads: BoardProjectId[] = [];

  constructor(
    private readonly on: ReadonlySet<BoardProjectId> = new Set(),
    private readonly answers: Readonly<Record<string, readonly (AnsweredAsk & { readonly id: string })[]>> = {},
    private readonly failing: { readonly switch?: boolean; readonly asks?: boolean } = {},
  ) {}

  async isOn(projectId: BoardProjectId): Promise<boolean> {
    this.switchReads.push(projectId);
    if (this.failing.switch === true) throw new Error('switch.json is damaged');
    return this.on.has(projectId);
  }

  async nameOf(projectId: BoardProjectId): Promise<string> {
    return projectId === PROJECT ? 'ferretry' : projectId;
  }

  async answered(ferret: string, id: string): Promise<AnsweredAsk & { readonly id: string } | undefined> {
    if (this.failing.asks === true) throw new Error('ledger is damaged');
    return this.answers[ferret]?.find(item => item.id === id);
  }
}

class FakeOwnerWords implements OwnerWords {
  readonly reads: string[] = [];

  constructor(private readonly words: Readonly<Record<string, readonly string[]>> = {}) {}

  async said(ferret: string): Promise<readonly string[]> {
    this.reads.push(ferret);
    return this.words[ferret] ?? [];
  }
}

/** The owner's Yes to "Track this on the board?" on `session`'s agenda. */
const yes = (id = 'A12', ferret = 'lead', choice = 'Yes'): AnsweredAsk & { readonly id: string } => ({
  id,
  raisedBy: 'ferret',
  raisedByFerret: ferret,
  subject: 'Track this on the board?',
  options: ['Yes', 'No'],
  answer: { by: 'owner', choice },
});

const refile = (projectId: BoardProjectId) => CardActionRequestSchema.parse({ action: 'refile', projectId });

const create = (input: Partial<CardCreateRequestInput> = {}) =>
  CardCreateRequestSchema.parse({
    kind: 'feature',
    title: 'Login redesign',
    ask: { text: 'fix the login', source: 'session:lead' },
    ...input,
  });

const serviceWith = (cards: readonly Card[], overrides: Partial<ServiceWorld> = {}) => {
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
  it("should refuse a ferret's card where the board is off, saying to use an ask and how to ask", async () => {
    // Arrange
    const { ports, service } = serviceWith([], { optIn: new FakeOptIn() });

    // Act
    const error = await refusal(service.create(create(), lead));

    // Assert
    should(error.code).equal('forbidden');
    should(error.message).startWith('The ferretry board is off, so this work needs no card');
    should(error.message).containEql('fy ask -k yesno "Track this on the board?"');
    should(ports.store.cards.size).equal(0);
  });

  it("should make a ferret's card where the board is on", async () => {
    // Arrange
    const optIn = new FakeOptIn(new Set([PROJECT]));
    const { ports, service } = serviceWith([], { optIn });

    // Act
    const response = await service.create(create(), lead);

    // Assert
    should(response.card.id).equal('F1');
    should(response.card).not.have.property('approval');
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
    should([owner.card.id, token.card.id]).eql(['F1', 'F2']);
    should(optIn.switchReads).eql([]);
  });

  it('should make a card under a parent the ferret holds', async () => {
    // Arrange
    const { service } = serviceWith([card({ id: 'F3', owner: 'lead' })], { optIn: new FakeOptIn() });

    // Act
    const response = await service.create(create({ parent: { id: 'F3' } }), lead);

    // Assert
    should(response.card.parent).eql({ id: 'F3' });
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
    should(response.card.approval).eql({ ferret: 'lead', id: 'A12' });
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
    should(made.card.id).equal('F1');
    should(error).be.instanceOf(BoardError);
    should(error?.message).containEql('!A12 already made &F1');
    should(keys).eql(['board:approval:lead:A12', 'board:approval:lead:A12']);
  });

  it('should refuse a second card on a Yes that already made one, saying which', async () => {
    // Arrange
    const used = card({ id: 'F4', owner: 'lead', approval: { ferret: 'lead', id: 'A12' } });
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
    should(theirs.message).containEql('!A12 is not an answered ask on your ledger');
    should(no.message).containEql('the owner did not answer Yes to !A13');
  });

  it('should read a ledger that cannot be read as no Yes', async () => {
    // Arrange
    const { service } = serviceWith([], { optIn: new FakeOptIn(new Set(), { lead: [yes()] }, { asks: true }) });

    // Act
    const error = await refusal(service.create(create({ approval: 'A12' }), lead));

    // Assert
    should(error.message).containEql('!A12 is not an answered ask on your ledger');
  });

  it('should ignore an approval where the board is on, and record none', async () => {
    // Arrange
    const { service } = serviceWith([], { optIn: new FakeOptIn(new Set([PROJECT])) });

    // Act
    const response = await service.create(create({ approval: 'A99' }), lead);

    // Assert
    should(response.card).not.have.property('approval');
  });

  it("should refuse a card whose ask is the owner's own words, however they ask for a card", async () => {
    // Arrange
    const ownerWords = new FakeOwnerWords({ lead: [OWNER_WANTS_A_CARD] });
    const { service } = serviceWith([], { optIn: new FakeOptIn(), ownerWords });

    // Act
    const error = await refusal(service.create(create({ ask: { text: OWNER_WANTS_A_CARD, source: 'owner' } }), lead));

    // Assert
    should(error.code).equal('forbidden');
    should(error.message).startWith('The ferretry board is off');
  });

  it('should refuse a card under a parent that is dropped, closed, or on another board', async () => {
    // Arrange
    const parents = [
      card({ id: 'F3', owner: 'lead', dropped: { reason: 'superseded', at: NOW } }),
      card({ id: 'F4', owner: 'lead', laneId: 'closed' }),
      card({ id: 'F5', owner: 'lead', projectId: OTHER_PROJECT, laneId: 'todo' }),
    ];
    const { service } = serviceWith(parents, { optIn: new FakeOptIn(new Set([OTHER_PROJECT])) });

    // Act & Assert
    for (const id of ['F3', 'F4', 'F5']) {
      const error = await refusal(service.create(create({ parent: { id } }), lead));
      should(error.message).startWith('The ferretry board is off', id);
    }
  });

  it("should refuse a refile of a ferret's card onto a board that is off", async () => {
    // Arrange: made where the board is on, then moved to one that is off.
    const { ports, service } = serviceWith(
      [card({ id: 'F1', owner: 'lead', projectId: OTHER_PROJECT, laneId: 'todo' })],
      {
        optIn: new FakeOptIn(new Set([OTHER_PROJECT])),
      },
    );

    // Act
    const error = await refusal(service.act('F1', refile(PROJECT), lead));

    // Assert
    should(error.message).startWith('The ferretry board is off');
    should(ports.store.cards.get('F1')?.projectId).equal(OTHER_PROJECT);
  });

  it('should refile onto a board that is off a card under a live parent there the ferret holds, or one made on a Yes', async () => {
    // Arrange
    const cards = [
      card({ id: 'F2', owner: 'lead' }),
      card({ id: 'F1', owner: 'lead', projectId: OTHER_PROJECT, laneId: 'todo', parent: { id: 'F2' } }),
      card({
        id: 'F3',
        owner: 'lead',
        projectId: OTHER_PROJECT,
        laneId: 'todo',
        approval: { ferret: 'lead', id: 'A12' },
      }),
    ];
    const { ports, service } = serviceWith(cards, { optIn: new FakeOptIn() });

    // Act
    await service.act('F1', refile(PROJECT), lead);
    await service.act('F3', refile(PROJECT), lead);

    // Assert
    should(ports.store.cards.get('F1')?.projectId).equal(PROJECT);
    should(ports.store.cards.get('F3')?.projectId).equal(PROJECT);
  });

  it('should refuse a refile under a parent the ferret does not hold, and let the owner refile anything', async () => {
    // Arrange
    const cards = [
      card({ id: 'F2', owner: 'stranger' }),
      card({ id: 'F1', owner: 'lead', projectId: OTHER_PROJECT, laneId: 'todo', parent: { id: 'F2' } }),
    ];
    const { ports, service } = serviceWith(cards, { optIn: new FakeOptIn() });

    // Act
    const error = await refusal(service.act('F1', refile(PROJECT), lead));
    await service.act('F1', refile(PROJECT), { kind: 'owner' });

    // Assert
    should(error.message).startWith('The ferretry board is off');
    should(ports.store.cards.get('F1')?.projectId).equal(PROJECT);
  });

  it('should leave a refile within one board, or onto a board that is on, alone', async () => {
    // Arrange
    const { ports, service } = serviceWith(
      [card({ id: 'F1', owner: 'lead', projectId: OTHER_PROJECT, laneId: 'todo' })],
      {
        optIn: new FakeOptIn(new Set([PROJECT])),
      },
    );

    // Act
    await service.act('F1', refile(PROJECT), lead);

    // Assert
    should(ports.store.cards.get('F1')?.projectId).equal(PROJECT);
  });
});

describe('whether a lead may put a new card under a card', () => {
  it('should be a live card on this machine that it may add a child under', async () => {
    // Arrange
    const cards = [
      card({ id: 'F1', owner: 'lead' }),
      card({ id: 'F2', owner: 'stranger' }),
      card({ id: 'F3', owner: 'lead', laneId: 'closed' }),
      card({ id: 'F4', owner: 'lead', dropped: { reason: 'superseded', at: NOW } }),
      card({ id: 'F5', owner: 'child' }),
    ];
    const { service } = serviceWith(cards);

    // Act
    const answers = await Promise.all(
      ['F1', 'F2', 'F3', 'F4', 'F5', 'F9'].map(id => service.mayAdoptUnder('lead', id)),
    );

    // Assert — F5's owner is the lead's own helper, so the lead is its ancestor.
    should(answers).eql([true, false, false, false, true, false]);
  });

  it('should read a card on a board with no lanes as no longer work', async () => {
    // Arrange
    const { service } = serviceWith([
      card({ id: 'F1', owner: 'lead', projectId: '33333333-3333-4333-8333-333333333333' }),
    ]);

    // Act
    const may = await service.mayAdoptUnder('lead', 'F1');

    // Assert
    should(may).be.false();
  });
});

describe('the board is opt-in, unwired', () => {
  it('should leave every board on when the rule is not wired', async () => {
    // Arrange
    const { service } = serviceWith([]);

    // Act
    const response = await service.create(create(), lead);

    // Assert
    should(response.card.id).equal('F1');
  });
});
