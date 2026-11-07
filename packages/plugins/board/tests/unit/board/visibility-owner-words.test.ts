import { describe, it } from 'bun:test';
import { type CardActionRequest, CardCreateRequestSchema } from '../../../contract/index.ts';
import should from 'should';
import { BoardError, BoardService, BoardUnavailableError, type OwnerWords } from '../../../daemon/lib/board/index.ts';
import { card, ferretActor, MemoryBoardStore, PROJECT, world } from './support.ts';

const SESSION = 'lead';
const OWNER_SAID = 'Build a board that shows only the work the owner asked for';
const ask = { text: OWNER_SAID, source: `session:${SESSION}` };
const lead = { kind: 'ferret', ferret: SESSION } as const;
/** What the ferret's owner-words read can fail on: the adapter reads the queue, the ledger, the lineage and the turn files. */
const failures = [
  'queue',
  'ledger',
  'lineage',
  'directory-stat',
  'directory-list',
  'turn-stat',
  'turn-read',
  'author',
] as const;
type Failure = (typeof failures)[number];

/** An OwnerWords port that fails while broken, whichever read failed; recovery just restores readability. */
const fixture = (failure: Failure) => {
  let broken = true;
  const words: OwnerWords = {
    said: async (_ferret, options) => {
      if (broken) {
        if (options?.strict === true) throw new Error(`${failure} unreadable`);
        return [];
      }
      return [OWNER_SAID];
    },
  };
  return {
    words,
    recover: () => {
      broken = false;
    },
  };
};

const operations = ['create', 'edit', 'visibility'] as const;
const request = (visibility?: 'private') =>
  CardCreateRequestSchema.parse({
    kind: 'feature',
    title: 'Owner board',
    ask,
    projectId: PROJECT,
    assignee: SESSION,
    ...(visibility === undefined ? {} : { visibility }),
  });
const change: Record<'edit' | 'visibility', CardActionRequest> = {
  edit: { action: 'edit', title: 'Must not be written', visibility: 'private' },
  visibility: { action: 'visibility', visibility: 'private' },
};

describe('strict private choices through SessionOwnerWords', () => {
  for (const failure of failures) {
    for (const operation of operations) {
      it(`should write nothing for ${operation} with unreadable ${failure}, then publish the recovered owner ask`, async () => {
        // Arrange: an earlier best-effort read stored an agent guess.
        const { words, recover } = fixture(failure);
        const guessed = card({ ask, askedBy: 'agent', visibility: 'private', visibilitySource: 'default' });
        const ports = world({ store: new MemoryBoardStore([guessed]), ownerWords: words });
        const subject = new BoardService(ports);
        const task = guessed;
        const store = ports.store as MemoryBoardStore;
        const before = store.cards.get(task.id);
        const writes = store.writes.length;
        await words.said(SESSION);
        const hide = () =>
          operation === 'create'
            ? subject.create(request('private'), lead)
            : subject.act(task.id, change[operation], lead);

        // Act + Assert: incomplete words cannot authorize any explicit private choice.
        await hide().then(
          () => should.fail(undefined, undefined, 'an incomplete read authorized private'),
          (error: unknown) => should(error).be.instanceOf(BoardUnavailableError),
        );
        should(store.writes.length).equal(writes);
        should([...store.cards.values()]).eql([before]);

        recover();
        await hide().then(
          () => should.fail(undefined, undefined, 'a ferret hid a recovered owner ask'),
          (error: unknown) => should(error).be.instanceOf(BoardError).and.match({ code: 'forbidden' }),
        );
      });
    }
  }
});

describe('F-0001 a daemon that cannot read what the owner said', () => {
  it('F-0001 should refuse a ferret making its own card private as an unavailable board, not judge it on the card as stored', async () => {
    // Arrange: no OwnerWords port (Conversation is off, so who wrote each turn cannot be read)
    const stored = card({ ask, askedBy: 'agent', visibility: 'public', visibilitySource: 'chosen' });
    const ports = world({ store: new MemoryBoardStore([stored]) });
    const store = ports.store as MemoryBoardStore;
    const subject = new BoardService(ports);
    const writes = store.writes.length;

    // Act + Assert
    await subject.act(stored.id, { action: 'visibility', visibility: 'private' }, lead).then(
      () => should.fail(undefined, undefined, 'a guess hid a card'),
      (error: unknown) => should(error).be.instanceOf(BoardUnavailableError),
    );
    should(store.writes.length).equal(writes);
    should(store.cards.get(stored.id)?.visibility).equal('public');
  });

  it('F-0001 should refuse a ferret’s new private card the same way, and make nothing', async () => {
    const ports = world({ store: new MemoryBoardStore([]) });
    const subject = new BoardService(ports);

    await subject.create(request('private'), lead).then(
      () => should.fail(undefined, undefined, 'a guess hid a new card'),
      (error: unknown) => should(error).be.instanceOf(BoardUnavailableError),
    );
    should((ports.store as MemoryBoardStore).cards.size).equal(0);
  });

  it('F-0001 should still make a card that is not private: a new card never fails for want of the owner’s words', async () => {
    const subject = new BoardService(world({ store: new MemoryBoardStore([]) }));

    const made = await subject.create(request(), lead);

    should(made.card.id).be.ok();
  });
});

describe('F-0001 a card whose creator ferret was removed', () => {
  /** Conversation answers a strict read of a ferret the registry no longer has as "nobody the owner spoke to": no words, no failure. */
  const removedCreator = () => {
    const gone = card({
      createdBy: ferretActor('gone'),
      ask: { text: 'a ferret’s own follow-up errand', source: 'session:gone' },
      askedBy: 'agent',
      visibility: 'public',
      visibilitySource: 'chosen',
    });
    const words: OwnerWords = { said: async () => [] };
    const ports = world({ store: new MemoryBoardStore([gone]), ownerWords: words });
    return { gone, ports, subject: new BoardService(ports) };
  };

  it('F-0001 should be made private by its owner ferret: the strict read of the removed creator settles, it does not refuse for ever', async () => {
    const { gone, ports, subject } = removedCreator();

    await subject.act(gone.id, { action: 'visibility', visibility: 'private' }, lead);

    should((ports.store as MemoryBoardStore).cards.get(gone.id)?.visibility).equal('private');
  });

  it('F-0001 should be made private by the owner', async () => {
    const { gone, ports, subject } = removedCreator();

    await subject.act(gone.id, { action: 'visibility', visibility: 'private' }, { kind: 'owner' });

    should((ports.store as MemoryBoardStore).cards.get(gone.id)?.visibility).equal('private');
  });
});
