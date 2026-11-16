import { describe, it } from 'bun:test';
import should from 'should';
import {
  type Card,
  CardActionRequestSchema,
  type CardActionRequestInput,
  CardCreateRequestSchema,
  CardSchema,
} from '../../../contract/index.ts';
import { FerretsNames } from '../../../daemon/adapters/ferrets.ts';
import { type BoardCaller, BoardService } from '../../../daemon/lib/board/index.ts';
import { card, ferretActor, MemoryBoardStore, NOW, PROJECT, type ServiceWorld, world } from './support.ts';

const ADMIN: BoardCaller = { kind: 'owner', via: 'admin-token' };
const LEAD: BoardCaller = { kind: 'ferret', ferret: 'lead' };

const create = (assignee: string | null = null) =>
  CardCreateRequestSchema.parse({
    kind: 'feature',
    title: 'Board store',
    ask: { text: 'build it', source: 'owner' },
    projectId: PROJECT,
    ...(assignee === null ? {} : { assignee }),
  });
const action = (input: CardActionRequestInput) => CardActionRequestSchema.parse(input);

const serviceWith = (cards: readonly Card[], overrides: Partial<ServiceWorld> = {}) => {
  const ports = world({ store: new MemoryBoardStore(cards), ...overrides });
  return { ports, service: new BoardService(ports) };
};
const stored = (ports: ServiceWorld, id = 'F1'): Card => ports.store.cards.get(id) as Card;

/** A stored card whose actor sites (createdBy, the created event, one clarification) all hold `actor`, as JSON. */
const withActor = (actor: unknown, extra: Record<string, unknown> = {}): unknown => {
  const base = card();
  return {
    ...base,
    createdBy: actor,
    history: [{ ...base.history[0], actor, ...extra }],
    clarifications: [{ text: 'and the phone', source: 'owner', at: NOW, by: actor }],
  };
};

describe('the card actor is exactly one of three strict shapes', () => {
  it.each([
    ['the owner on their own app', { kind: 'owner' }],
    ['the owner on the admin token', { kind: 'owner', via: 'admin-token' }],
    ['a ferret, by name and id', { kind: 'ferret', name: 'Denisha', ferret: 'lead' }],
    ['the daemon', { kind: 'daemon' }],
  ])('should store %s in history, clarifications and createdBy', (_label, actor) => {
    should(CardSchema.safeParse(withActor(actor)).success).be.true();
  });

  it.each([
    ['a daemon that names a ferret', { kind: 'daemon', ferret: 'lead' }],
    ['an owner that names a ferret', { kind: 'owner', ferret: 'lead' }],
    ['an owner acting some other way', { kind: 'owner', via: 'device' }],
    ['a ferret with no name', { kind: 'ferret', ferret: 'lead' }],
    ['a ferret with an empty name', { kind: 'ferret', name: '', ferret: 'lead' }],
    ['a ferret with an extra key', { kind: 'ferret', name: 'Denisha', ferret: 'lead', via: 'admin-token' }],
  ])('should refuse %s as a stored actor', (_label, actor) => {
    should(CardSchema.safeParse(withActor(actor)).success).be.false();
    // Each site alone is refused too, not only the three together.
    const base = card();
    should(CardSchema.safeParse({ ...base, createdBy: actor }).success).be.false();
    should(CardSchema.safeParse({ ...base, history: [{ ...base.history[0], actor }] }).success).be.false();
    should(
      CardSchema.safeParse({ ...base, clarifications: [{ text: 't', source: 'owner', at: NOW, by: actor }] }).success,
    ).be.false();
  });

  it('should refuse an event that carries actorVia beside its actor', () => {
    should(CardSchema.safeParse(withActor({ kind: 'owner' }, { actorVia: 'admin-token' })).success).be.false();
  });

  it('should refuse a clarification that carries byVia beside its author', () => {
    const base = card();
    const clarification = { text: 't', source: 'owner', at: NOW, by: { kind: 'owner' }, byVia: 'admin-token' };
    should(CardSchema.safeParse({ ...base, clarifications: [clarification] }).success).be.false();
  });

  it('should refuse a reported move that carries reportedVia beside its reporter', () => {
    const base = card({ laneId: 'implement' });
    const moved = {
      seq: 2,
      at: NOW,
      actor: { kind: 'daemon' },
      type: 'moved',
      from: 'todo',
      to: 'implement',
      backward: false,
      reason: null,
      auto: true,
      trigger: 'deploy.done',
      reportedBy: { kind: 'owner', via: 'admin-token' },
    };
    should(CardSchema.safeParse({ ...base, history: [...base.history, moved] }).success).be.true();
    should(
      CardSchema.safeParse({ ...base, history: [...base.history, { ...moved, reportedVia: 'admin-token' }] }).success,
    ).be.false();
  });

  it('should refuse a history event with any key its type does not name', () => {
    should(CardSchema.safeParse(withActor({ kind: 'daemon' }, { stray: true })).success).be.false();
  });
});

describe('an act on the admin token', () => {
  it("should record { kind: 'owner', via: 'admin-token' } and nothing beside it on createdBy and the created event", async () => {
    // Arrange
    const { ports, service } = serviceWith([]);

    // Act
    await service.create(create('lead'), ADMIN);

    // Assert
    const made = stored(ports);
    should(made.createdBy).eql({ kind: 'owner', via: 'admin-token' });
    should(made.history).eql([
      { seq: 1, at: NOW, actor: { kind: 'owner', via: 'admin-token' }, type: 'created', laneId: 'todo' },
    ]);
    should(Object.keys(made)).not.containEql('createdByVia');
  });

  it("should record { kind: 'owner', via: 'admin-token' } and nothing beside it on a note and a clarification", async () => {
    // Arrange
    const { ports, service } = serviceWith([card()]);

    // Act
    await service.act('F1', action({ action: 'note', text: 'checked' }), ADMIN);
    await service.act('F1', action({ action: 'clarify', text: 'also the phone', source: 'owner' }), ADMIN);

    // Assert
    const after = stored(ports);
    should(after.history.find(event => event.type === 'note')).eql({
      seq: 2,
      at: NOW,
      actor: { kind: 'owner', via: 'admin-token' },
      type: 'note',
      text: 'checked',
    });
    should(after.clarifications).eql([
      { text: 'also the phone', source: 'owner', at: NOW, by: { kind: 'owner', via: 'admin-token' } },
    ]);
  });
});

describe("a ferret's act", () => {
  const DENISHA = { nameOf: async (ferret: string) => (ferret === 'lead' ? 'Denisha' : ferret) };

  it('should record its name from the names port on createdBy and the created event', async () => {
    // Arrange
    const { ports, service } = serviceWith([], { names: DENISHA });

    // Act
    await service.create(create(), LEAD);

    // Assert
    const actor = { kind: 'ferret', name: 'Denisha', ferret: 'lead' };
    should(stored(ports).createdBy).eql(actor);
    should(stored(ports).history[0]?.actor).eql(actor);
  });

  it('should record its name from the names port on a note and a clarification', async () => {
    // Arrange
    const { ports, service } = serviceWith([card()], { names: DENISHA });

    // Act
    await service.act('F1', action({ action: 'note', text: 'started' }), LEAD);
    await service.act('F1', action({ action: 'clarify', text: 'one more', source: 'owner' }), LEAD);

    // Assert
    const actor = { kind: 'ferret', name: 'Denisha', ferret: 'lead' };
    should(stored(ports).history.at(-1)?.actor).eql(actor);
    should(stored(ports).clarifications[0]?.by).eql(actor);
    should(stored(ports).history.at(-1)?.actor).not.eql(ferretActor('lead'));
  });

  it("should name a ferret by Ferrets' name, and by its id when Ferrets does not know it, never empty", async () => {
    // Arrange
    const known = new FerretsNames({
      // Only the summary's name is read; the rest of a summary does not matter here.
      get: async id => (id === 'lead' ? ({ name: 'Denisha' } as never) : undefined),
    });
    const failing = new FerretsNames({
      get: async () => {
        throw new Error('ferrets is down');
      },
    });

    // Assert
    should(await known.nameOf('lead')).equal('Denisha');
    should(await known.nameOf('ghost')).equal('ghost');
    should(await failing.nameOf('lead')).equal('lead');
  });
});
