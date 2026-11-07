import { describe, it } from 'bun:test';
import { type CardActionRequest, CardCreateRequestSchema } from '../../../contract/index.ts';
import should from 'should';
import { BoardError, BoardService, BoardUnavailableError, type OwnerWords } from '../../../daemon/lib/board/index.ts';
import { card, MemoryBoardStore, PROJECT, world } from './support.ts';

const SESSION = 'lead';
const OWNER_SAID = 'Build a board that shows only the work the owner asked for';
const ask = { text: OWNER_SAID, source: `session:${SESSION}` };
const lead = { kind: 'ferret', ferret: SESSION } as const;
/** What the ferret's owner-words read can fail on: the adapter reads the queue, the ledger, the lineage and the turn files. */
const failures = ['queue', 'ledger', 'lineage', 'directory-stat', 'directory-list', 'turn-stat', 'turn-read', 'author'] as const;
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

  it('should refuse an explicit private choice when the OwnerWords port is absent', async () => {
    // Arrange
    const ports = world();
    const subject = new BoardService(ports);

    // Act + Assert
    await subject.create(request('private'), lead).then(
      () => should.fail(undefined, undefined, 'missing owner words authorized private'),
      (error: unknown) => should(error).be.instanceOf(BoardUnavailableError),
    );
    should(ports.store.cards.size).equal(0);
  });
});
